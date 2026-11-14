"""Search one sky patch end to end: fetch SPHEREx cutouts, stack, inject, measure completeness, build candidates.

Everything produced here is written under <work_dir>/<patch_id>/ and later merged into the release bundle.
"""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

import numpy as np
import pandas as pd
import torch

from deepfield.config import CUTOUT_DEG, PATCH_MAX_EXPOSURES, PATCH_PER_VISIT, PATCH_RADIUS_DEG, PATCH_VISITS
from deepfield.contracts import write_stamps
from deepfield.data import spherex as SX
from deepfield.data.horizons import observer_positions
from deepfield.data.refpop import load_refpop
from deepfield.data.sbident import known_bodies, match_known
from deepfield.inject.injector import Injection, apply_injections, make_injections
from deepfield.prior.priormap import propagate_population
from deepfield.spectral.templates import fit_templates
from deepfield.stack import geometry as G
from deepfield.stack import shiftstack as S
from deepfield.stack.extract import find_peaks, noise_threshold, peak_near, rule_score
from deepfield.stack.reproject import reproject_cutout, target_wcs

log = logging.getLogger("deepfield.run_patch")
#: Floor only. The working threshold is calibrated per patch from its own SNR map, because the
#: map is a maximum over thousands of trials and a fixed 5 sigma sits near its median.
SNR_FLOOR = 5.0

#: Injected brightness range, V magnitudes, bright to faint.
#:
#: Deliberately brighter than any surviving reference planet (which are all V 17.5-23).
#: Injecting them at their catalogue brightness recovered 0 of 32 and produced a
#: completeness curve with no shape: it could say we were under the limit, but not where
#: the limit is. A curve needs points either side of 50%, so the ladder brackets it. The
#: orbits, tracks and spectra remain those of real reference planets.
INJECT_VMAG_LADDER = (
    float(os.environ.get("INJECT_VMAG_MIN", "13.0")),
    float(os.environ.get("INJECT_VMAG_MAX", "22.0")),
)


def load_patch_frames(ra0: float, dec0: float, max_exposures: int = PATCH_MAX_EXPOSURES,
                      radius_deg: float = PATCH_RADIUS_DEG, collection: str = "spherex_dr1"):
    sia = SX.sia_search(ra0, dec0, radius_deg, collection)
    if len(sia) == 0:
        raise RuntimeError(f"no SPHEREx {collection} coverage at {ra0:.3f},{dec0:.3f}")
    visit = SX.best_visits(sia, n_visits=PATCH_VISITS, per_visit=min(PATCH_PER_VISIT, max_exposures))
    cutouts = []
    skipped = 0
    for i, (_, row) in enumerate(visit.iterrows()):
        t = time.time()
        try:
            p = SX.fetch_cutout(row, ra0, dec0, CUTOUT_DEG)
            c = SX.load_cutout(p)
        except Exception as exc:  # 422 = centre not on this exposure; 5xx already retried
            skipped += 1
            log.warning("cutout %d/%d %s skipped: %s", i + 1, len(visit), row["obs_id"], str(exc)[:120])
            continue
        if c.good.mean() < 0.3:
            skipped += 1
            log.warning("cutout %s D%d skipped: only %.0f%% good pixels", c.obs_id, c.detector, 100 * c.good.mean())
            continue
        cutouts.append(c)
        log.info("cutout %d/%d %s D%d mjd %.3f (%.1fs)", i + 1, len(visit), c.obs_id, c.detector, c.mjd, time.time() - t)
    if len(cutouts) < 8:
        raise RuntimeError(f"only {len(cutouts)} usable cutouts at {ra0:.3f},{dec0:.3f} ({skipped} skipped)")
    cutouts.sort(key=lambda c: c.mjd)
    return cutouts, visit


def _epochs_meta(cutouts):
    return [{"obs_id": c.obs_id, "detector": c.detector, "mjd": c.mjd, "wave_um": c.wave_um, "bandwidth_um": c.bandwidth_um,
             "path": Path(c.path).name} for c in cutouts]


def search_patch(patch_id: str, ra0: float, dec0: float, work_dir: Path, *, n_inject_runs: int = 4,
                 n_per_run: int = 8, seed: int = 0, max_exposures: int = PATCH_MAX_EXPOSURES,
                 n_lab_injections: int = 3, n_lab_real: int = 3, n_lab_artifacts: int = 2) -> dict:
    work = Path(work_dir) / patch_id
    work.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed)
    dev = S.device()
    t_start = time.time()

    cutouts, visit = load_patch_frames(ra0, dec0, max_exposures)
    mjds = np.array([c.mjd for c in cutouts])
    mjd_ref = float(mjds.mean())
    obs_xyz, obs_label = observer_positions(mjds + 2400000.5)
    npix = int(cutouts[0].image.shape[0])
    wcs_out = target_wcs(ra0, dec0, npix)
    waves = np.array([c.wave_um for c in cutouts])

    def frames_from(cuts):
        return [reproject_cutout(c, wcs_out, npix) for c in cuts]

    n_visits = len(np.unique(S.visit_groups(mjds)))
    if n_visits >= S.MIN_VISITS_FOR_CROSS_VISIT:
        # Three or more visits: parallax (curved in time) separates from proper motion (linear),
        # so a fine distance grid plus a small orbital-rate grid gives real distance discrimination.
        trials = G.default_trial_grid(distances=tuple(np.geomspace(250, 1500, 36)) + (np.inf,), rates=(-0.5, -0.25, 0.0, 0.25, 0.5))
    elif n_visits == 2:
        # Two time samples cannot separate parallax from proper motion: a wrong (distance, rate)
        # pair reproduces the same inter-visit shift and peaks somewhere else entirely, often
        # harder than the truth. Verified on synthetic two-visit data, where the search put the
        # peak 73 px from a source it had the signal to find. So do not offer free rates here --
        # search distance only, and say in the summary that position is weakly constrained.
        trials = G.default_trial_grid(distances=tuple(np.geomspace(250, 1500, 36)) + (np.inf,), rates=(0.0,))
    else:
        trials = G.default_trial_grid()
    off = S.offsets_pixels(trials, ra0, dec0, mjds, obs_xyz, mjd_ref)
    stationary_idx = [i for i, t in enumerate(trials) if not np.isfinite(t.distance_au)][0]

    # ---- clean search ---------------------------------------------------
    frames_clean = frames_from(cutouts)
    prep_clean = S.prepare(frames_clean, dev=dev)
    snr_c, flux_c, best_c, nden_c = S.stack_trials(prep_clean, off)
    # Calibrated against this map's own noise, not a fixed 5 sigma: the map is a maximum over
    # every trial, so its median already sits near 5 when the trial grid is large.
    snr_threshold = max(SNR_FLOOR, noise_threshold(snr_c))
    peaks = find_peaks(snr_c, nden_c, snr_threshold)
    log.info("%s: %d epochs, %d visits, %d trials, threshold %.2f, %d peaks (max %.2f)", patch_id,
             len(cutouts), n_visits, len(trials), snr_threshold, len(peaks),
             np.nanmax(np.where(np.isfinite(snr_c), snr_c, -np.inf)))

    # known small bodies (JPL SBIdent); failure is logged, not fatal
    try:
        known = known_bodies(ra0, dec0, PATCH_RADIUS_DEG * 1.2, mjd_ref)
        known_label = f"{len(known)} known bodies from JPL SBIdent"
    except Exception as exc:
        known = pd.DataFrame(columns=["name", "ra_deg", "dec_deg", "vmag"])
        known_label = f"SBIdent unavailable ({type(exc).__name__})"
    log.info("%s: %s", patch_id, known_label)

    # ---- injection runs -------------------------------------------------
    pop = load_refpop()
    prop = propagate_population(pop, mjd_ref)
    inj_records: list[dict] = []
    lab_pool: list[tuple[Injection, dict, S.Prepared, np.ndarray]] = []
    lab_pool_all: list[tuple[Injection, dict, S.Prepared, np.ndarray]] = []
    for run in range(n_inject_runs):
        injs = make_injections(pop, prop, n_per_run, rng, wcs_out, npix, mjds, obs_xyz, mjd_ref, waves,
                               tag=f"{patch_id[-3:]}R{run}", vmag_ladder=INJECT_VMAG_LADDER)
        cuts_inj = apply_injections(cutouts, injs)
        prep = S.prepare(frames_from(cuts_inj), dev=dev)
        snr_i, flux_i, best_i, nden_i = S.stack_trials(prep, off)
        for inj in injs:
            s_pk, xp, yp = peak_near(snr_i, inj.x_ref, inj.y_ref, radius=2.5)
            s_clean, _, _ = peak_near(snr_c, inj.x_ref, inj.y_ref, radius=2.5)
            recovered = bool(np.isfinite(s_pk) and s_pk >= snr_threshold and s_pk > s_clean + 2.0)
            bt = int(best_i[int(yp), int(xp)]) if np.isfinite(s_pk) else stationary_idx
            tr = trials[bt]
            rec = {"patch_id": patch_id, "run": run, "injection_id": inj.injection_id, "pop_index": inj.pop_index,
                   "vmag": inj.vmag, "distance_au": inj.distance_au, "x_ref": inj.x_ref, "y_ref": inj.y_ref,
                   "snr_peak": float(s_pk) if np.isfinite(s_pk) else None, "snr_clean_here": float(s_clean) if np.isfinite(s_clean) else None,
                   "recovered": recovered, "best_distance_au": tr.distance_au if np.isfinite(tr.distance_au) else None,
                   "best_rate_ra": tr.rate_ra_arcsec_day, "best_rate_dec": tr.rate_dec_arcsec_day,
                   "x_peak": xp, "y_peak": yp, **{f"inj_{k}": v for k, v in inj.extra.items()}}
            inj_records.append(rec)
            lab_pool_all.append((inj, rec, prep, off[bt]))
            if run == 0 or len(lab_pool) < 2 * n_lab_injections:
                lab_pool.append((inj, rec, prep, off[bt]))
        log.info("%s: injection run %d: %d/%d recovered", patch_id, run, sum(r["recovered"] for r in inj_records[-n_per_run:]), n_per_run)

    inj_df = pd.DataFrame(inj_records)
    inj_df.to_parquet(work / "injections.parquet")

    # ---- training stamps for the from-scratch CNN ---------------------------
    from deepfield.ml.model import normalise_stamp
    X, y_lab, meta_rows = [], [], []

    def ml_stamp(prep, off_one, x, y_):
        snr_map, _ = S.stack_one(prep, off_one)
        singles, static = S.shifted_stamps(prep, off_one, x, y_, size=32, max_n=12)
        best = singles[np.argmax(singles.reshape(len(singles), -1).max(1))]
        return normalise_stamp(S.stamp_along(snr_map, x, y_, 32), static, best)

    for inj, r, prep, off_one in lab_pool_all:
        if r["snr_peak"] is not None and r["snr_peak"] >= 3.0:
            X.append(ml_stamp(prep, off_one, r["x_peak"], r["y_peak"])); y_lab.append(1)
            meta_rows.append({"kind": "injection", **{k: r[k] for k in ("injection_id", "vmag", "snr_peak")}})
    # negatives: noise peaks of the clean stack (any trial), stationary peaks, and random positions
    neg_peaks = find_peaks(snr_c, nden_c, threshold=3.0, max_peaks=40)
    for p in neg_peaks:
        bt = int(best_c[p["y"], p["x"]])
        X.append(ml_stamp(prep_clean, off[bt], p["x"], p["y"])); y_lab.append(0)
        meta_rows.append({"kind": "clean_peak", "snr_peak": p["snr"]})
    for _ in range(max(10, len(X) // 2)):
        x_, y_ = rng.uniform(16, npix - 16), rng.uniform(16, npix - 16)
        bt = int(best_c[int(y_), int(x_)])
        X.append(ml_stamp(prep_clean, off[bt], x_, y_)); y_lab.append(0)
        meta_rows.append({"kind": "random", "snr_peak": float(snr_c[int(y_), int(x_)])})
    np.savez_compressed(work / "training_stamps.npz", X=np.stack(X).astype(np.float32), y=np.array(y_lab, np.int8))
    pd.DataFrame(meta_rows).to_parquet(work / "training_meta.parquet")
    log.info("%s: %d training stamps (%d positive)", patch_id, len(y_lab), int(sum(y_lab)))

    # ---- candidates for the Lab / Classify --------------------------------
    cands, spectra = [], []
    source = SX.SOURCE
    stamps_root = work / "stamps"

    def add_candidate(cid: str, x: float, y: float, prep: S.Prepared, off_one: np.ndarray, trial: G.Trial, snr_val: float,
                      flux_val: float, is_sim: bool, inj: Injection | None, status: str):
        ra, dec = wcs_out.all_pix2world([x], [y], 0)
        ra, dec = float(ra[0]), float(dec[0])
        s_single, f_single, e_single = S.single_epoch_snr_along(prep, off_one, x, y)
        singles, static = S.shifted_stamps(prep, off_one, x, y, size=32, max_n=12)
        snr_map, _ = S.stack_one(prep, off_one)
        stack_stamp = S.stamp_along(snr_map, x, y, 32)
        known_name = match_known(known, ra, dec) if not is_sim else None
        fit = fit_templates(waves, f_single, e_single)
        stationary = not np.isfinite(trial.distance_au)
        single_max = float(np.nanmax(np.abs(s_single))) if np.isfinite(s_single).any() else 0.0
        sd = stamps_root / cid
        write_stamps(sd, singles, stack_stamp, static, source=source, is_simulated=is_sim,
                     meta={"candidate_id": cid, "patch_id": patch_id, "injected_mag": inj.vmag if inj else None,
                           "trial": {"distance_au": None if stationary else trial.distance_au,
                                     "rate_ra": trial.rate_ra_arcsec_day, "rate_dec": trial.rate_dec_arcsec_day}})
        rs = rule_score(snr_val, single_max, stationary, known_name is not None, threshold=snr_threshold)
        cands.append({
            "candidate_id": cid, "patch_id": patch_id, "ra_deg": ra, "dec_deg": dec, "is_simulated": is_sim,
            "injection_id": inj.injection_id if inj else None, "injected_mag": inj.vmag if inj else None,
            "injected_distance_au": inj.distance_au if inj else None,
            "snr_stack": float(snr_val), "snr_single_max": single_max,
            "best_distance_au": None if stationary else float(trial.distance_au),
            "best_rate_ra_arcsec_day": trial.rate_ra_arcsec_day, "best_rate_dec_arcsec_day": trial.rate_dec_arcsec_day,
            "flux_mjysr": float(flux_val), "n_epochs": int(len(cutouts)), "n_bands": int(fit["n"]),
            "methane_score": fit["methane_score"], "template_best": fit["best"], "ml_score": None, "rule_score": rs,
            "crowd_p_real": 0.5, "n_votes": 0,
            "status": status if known_name is None else "known", "known_object": known_name,
            "stamp_dir": f"stamps/{cid}", "dossier_path": f"dossiers/{cid}.json", "source": source, "created_mjd": mjd_ref,
            "_x": x, "_y": y, "_fit_chi2": fit.get("chi2"), "_obs_label": obs_label,
        })
        models = fit.get("models", {})
        for k, c in enumerate(cutouts):
            if not np.isfinite(f_single[k]):
                continue
            spectra.append({
                "candidate_id": cid, "obs_id": c.obs_id, "detector": c.detector, "mjd": c.mjd,
                "wavelength_um": c.wave_um, "bandwidth_um": c.bandwidth_um,
                "flux_mjysr": float(f_single[k]), "flux_err_mjysr": float(e_single[k]),
                "model_planet": float(models["planet"][k]) if models else None,
                "model_asteroid": float(models["asteroid"][k]) if models else None,
                "model_star": float(models["star"][k]) if models else None, "source": source,
            })

    n_c = 0
    # injected: choose a spread of recovered + marginal + failed for the Lab
    lab_pool.sort(key=lambda t: -(t[1]["snr_peak"] or 0))
    chosen = []
    rec = [t for t in lab_pool if t[1]["recovered"]]
    fail = [t for t in lab_pool if not t[1]["recovered"]]
    chosen += rec[:max(1, n_lab_injections - 1)]
    chosen += fail[:n_lab_injections - len(chosen)]
    if len(chosen) < n_lab_injections:
        chosen += [t for t in lab_pool if t not in chosen][:n_lab_injections - len(chosen)]
    for inj, r, prep, off_one in chosen:
        n_c += 1
        bt_trial = G.Trial(r["best_distance_au"] if r["best_distance_au"] else np.inf, r["best_rate_ra"], r["best_rate_dec"])
        xp, yp = (r["x_peak"], r["y_peak"]) if r["recovered"] else (inj.x_ref, inj.y_ref)
        snr_map, flux_map = S.stack_one(prep, off_one)
        add_candidate(f"{patch_id}-S{n_c:02d}", xp, yp, prep, off_one, bt_trial,
                      snr_map[int(yp), int(xp)], flux_map[int(yp), int(xp)], True, inj, "simulated")

    # real peaks from the clean stack: moving-trial peaks as candidates, stationary peaks as artifacts
    movers = [p for p in peaks if best_c[p["y"], p["x"]] != stationary_idx]
    statics = [p for p in peaks if best_c[p["y"], p["x"]] == stationary_idx]
    for p in movers[:n_lab_real]:
        n_c += 1
        bt = int(best_c[p["y"], p["x"]])
        add_candidate(f"{patch_id}-C{n_c:02d}", p["x"], p["y"], prep_clean, off[bt], trials[bt], p["snr"],
                      flux_c[p["y"], p["x"]], False, None, "candidate")
    for p in statics[:n_lab_artifacts]:
        n_c += 1
        add_candidate(f"{patch_id}-A{n_c:02d}", p["x"], p["y"], prep_clean, off[stationary_idx], trials[stationary_idx], p["snr"],
                      flux_c[p["y"], p["x"]], False, None, "artifact")
    # an "empty" test card: a random low-SNR location
    for _ in range(1):
        n_c += 1
        for _try in range(100):
            x, y = rng.uniform(16, npix - 16), rng.uniform(16, npix - 16)
            if np.isfinite(snr_c[int(y), int(x)]) and abs(snr_c[int(y), int(x)]) < 2.5:
                break
        add_candidate(f"{patch_id}-E{n_c:02d}", x, y, prep_clean, off[stationary_idx], trials[stationary_idx],
                      snr_c[int(y), int(x)], flux_c[int(y), int(x)], False, None, "empty")

    cand_df = pd.DataFrame(cands)
    cand_df.to_parquet(work / "candidates_raw.parquet")
    pd.DataFrame(spectra).to_parquet(work / "spectra.parquet")

    # ---- per-patch summary -------------------------------------------------
    noise = float(np.nanmedian(prep_clean.sigma))
    summary = {
        "patch_id": patch_id, "ra_deg": ra0, "dec_deg": dec0, "radius_deg": PATCH_RADIUS_DEG, "npix": npix,
        "n_exposures": int(len(cutouts)), "mjd_start": float(mjds.min()), "mjd_end": float(mjds.max()), "mjd_ref": mjd_ref,
        "visit_label": f"{cutouts[0].obs_id.split('_')[0]}..{cutouts[-1].obs_id.split('_')[0]}",
        "n_bands": len({round(w, 2) for w in waves}), "detectors": sorted({c.detector for c in cutouts}),
        "n_trials": len(trials), "n_visits": int(n_visits),
        "mode": ("cross-visit parallax stack (position and distance constrained)"
                 if n_visits >= S.MIN_VISITS_FOR_CROSS_VISIT else
                 "two-visit stack, distance grid only (two time samples cannot separate parallax "
                 "from proper motion, so position is weakly constrained)" if n_visits == 2 else
                 "single-visit co-add (no distance information)"),
        "snr_threshold": float(snr_threshold),
        "snr_threshold_note": ("calibrated from this patch's own max-over-trials SNR map "
                               "(robust median + sqrt(2 ln N_eff) * MAD), floored at 5"),
        "observer": obs_label, "known_bodies": known_label,
        "clean_peaks": peaks[:20], "clean_snr_max": float(np.nanmax(np.where(np.isfinite(snr_c), snr_c, -np.inf))),
        "median_pixel_sigma_mjysr": noise, "device": str(dev),
        "n_injected": int(len(inj_df)), "n_recovered": int(inj_df.recovered.sum()),
        "epochs": _epochs_meta(cutouts), "elapsed_s": time.time() - t_start, "source": SX.SOURCE,
        "collection": str(visit.iloc[0].get("collection", "spherex_dr1")),
    }
    (work / "summary.json").write_text(json.dumps(summary, indent=1, default=float))
    # stash the clean SNR map for the Proof page / debugging
    np.savez_compressed(work / "clean_stack.npz", snr=snr_c, flux=flux_c, best_trial=best_c, static=prep_clean.static)
    log.info("%s done in %.0fs: %d/%d injections recovered, %d lab candidates", patch_id, summary["elapsed_s"],
             summary["n_recovered"], summary["n_injected"], len(cands))
    return summary
