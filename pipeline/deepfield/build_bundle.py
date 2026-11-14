"""Assemble the release bundle from per-patch work directories.

Steps: completeness curves, from-scratch CNN training + ONNX export + scoring, dossiers, Deep Field exclusion
update of the prior map, contract parquet files, bundle.json. Then `export_demo` turns it into web files.
"""
from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path

import numpy as np
import pandas as pd

from deepfield.agents.dossier import generate_dossiers
from deepfield.config import NSIDE, PATCH_RADIUS_DEG
from deepfield.contracts import now_iso, write_table
from deepfield.data.refpop import SOURCE as REFPOP_SOURCE, load_refpop
from deepfield.data.spherex import SOURCE as SPHEREX_SOURCE
from deepfield.prior.priormap import build_prior_map, propagate_population

log = logging.getLogger("deepfield.build_bundle")


def completeness_rows(inj: pd.DataFrame, patch_id: str, snr_threshold: float = 5.0) -> list[dict]:
    rows = []
    for lo in np.arange(17.5, 23.0, 0.5):
        sel = inj[(inj.vmag >= lo) & (inj.vmag < lo + 0.5)]
        rows.append({"patch_id": patch_id, "axis": "mag", "bin_lo": float(lo), "bin_hi": float(lo + 0.5),
                     "n_injected": int(len(sel)), "n_recovered": int(sel.recovered.sum()),
                     "fraction": float(sel.recovered.mean()) if len(sel) else float("nan"),
                     "snr_threshold": snr_threshold, "source": SPHEREX_SOURCE})
    for lo in (200, 300, 400, 500, 600, 800):
        hi = {200: 300, 300: 400, 400: 500, 500: 600, 600: 800, 800: 1200}[lo]
        sel = inj[(inj.distance_au >= lo) & (inj.distance_au < hi)]
        rows.append({"patch_id": patch_id, "axis": "distance_au", "bin_lo": float(lo), "bin_hi": float(hi),
                     "n_injected": int(len(sel)), "n_recovered": int(sel.recovered.sum()),
                     "fraction": float(sel.recovered.mean()) if len(sel) else float("nan"),
                     "snr_threshold": snr_threshold, "source": SPHEREX_SOURCE})
    return rows


def mag_limit_50(inj: pd.DataFrame) -> float:
    """Faintest V at which at least half of the injections were recovered (logistic fit on the pooled injections)."""
    if len(inj) < 5 or inj.recovered.sum() == 0:
        return float("nan")
    vm, rec = inj.vmag.values, inj.recovered.values.astype(float)
    best, best_ll = np.nan, -np.inf
    for m50 in np.arange(16.0, 24.0, 0.05):
        for width in (0.3, 0.5, 0.8):
            p = 1 / (1 + np.exp((vm - m50) / width))
            ll = np.sum(rec * np.log(p + 1e-9) + (1 - rec) * np.log(1 - p + 1e-9))
            if ll > best_ll:
                best, best_ll = m50, ll
    return float(best)


def deepfield_exclusion(patches: list[dict], mag50: dict[str, float], mjd_ref: float) -> np.ndarray:
    """Reference planets that crossed a searched patch during its visit at V brighter than that patch's 50% limit."""
    pop = load_refpop()
    excluded = np.zeros(len(pop), dtype=bool)
    for p in patches:
        m50 = mag50.get(p["patch_id"], float("nan"))
        if not np.isfinite(m50):
            continue
        prop = propagate_population(pop, p["mjd_ref"])
        dra = ((prop.ra_now.values - p["ra_deg"] + 180) % 360 - 180) * np.cos(np.radians(p["dec_deg"]))
        ddec = prop.dec_now.values - p["dec_deg"]
        inside = np.hypot(dra, ddec) <= PATCH_RADIUS_DEG
        bright = prop.V_now.values <= m50
        excluded |= inside & bright & ~prop.excluded_prior.values
    return excluded


def train_classifier(work_dir: Path, out_dir: Path) -> dict | None:
    from deepfield.ml.model import export_onnx, train
    Xs, ys = [], []
    for f in sorted(Path(work_dir).glob("*/training_stamps.npz")):
        d = np.load(f)
        Xs.append(d["X"]); ys.append(d["y"])
    if not Xs:
        return None
    X, y = np.concatenate(Xs), np.concatenate(ys).astype(np.float32)
    if (y > 0.5).sum() < 8 or (y <= 0.5).sum() < 8:
        return {"skipped": f"too few examples: {int((y>0.5).sum())} pos / {int((y<=0.5).sum())} neg"}
    model, info = train(X, y, epochs=40)
    export_onnx(model, out_dir / "model.onnx", {"n_positive": int((y > 0.5).sum()), "n_negative": int((y <= 0.5).sum()),
                                                  "val_auc": info["val_auc"], "val_acc": info["val_acc"],
                                                  "n_train": info["n_train"], "n_val": info["n_val"],
                                                  "trained_at": now_iso(), "architecture": "StampNet (3 conv + 2 fc)",
                                                  "training_data": "Deep Field injections into SPHEREx DR1 frames (positives); clean-stack peaks and random positions (negatives)"})
    return {"val_auc": info["val_auc"], "val_acc": info["val_acc"], "n": int(len(y)), "n_pos": int((y > 0.5).sum())}


def build(work_dir: Path, out_dir: Path) -> dict:
    work_dir, out_dir = Path(work_dir), Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for sub in ("stamps", "dossiers"):
        if (out_dir / sub).exists():
            shutil.rmtree(out_dir / sub)
    summaries = [json.loads(p.read_text()) for p in sorted(work_dir.glob("*/summary.json"))]
    if not summaries:
        raise RuntimeError("no patch summaries in work dir")

    # completeness + 50% limits
    comp_rows, mag50, all_inj = [], {}, []
    n_off_field = 0
    for s in summaries:
        inj = pd.read_parquet(work_dir / s["patch_id"] / "injections.parquet")
        if "inj_track_in_field" in inj.columns:
            n_off_field += int((~inj.inj_track_in_field.astype(bool)).sum())
            inj = inj[inj.inj_track_in_field.astype(bool)]  # tracks leaving the cutout are not a search failure
        all_inj.append(inj)
        comp_rows += completeness_rows(inj, s["patch_id"])
        mag50[s["patch_id"]] = mag_limit_50(inj)
    inj_all = pd.concat(all_inj)
    comp_rows += completeness_rows(inj_all, "ALL")
    mag50["ALL"] = mag_limit_50(inj_all)
    write_table(pd.DataFrame(comp_rows), "completeness", out_dir / "completeness.parquet", source=SPHEREX_SOURCE,
                extra_meta={"mag50": mag50, "n_injected": int(len(inj_all)), "n_recovered": int(inj_all.recovered.sum()),
                            "n_off_field_excluded": n_off_field})
    inj_all.to_parquet(out_dir / "injections.parquet")

    # candidates + spectra + stamps
    cands, spectra = [], []
    for s in summaries:
        pdir = work_dir / s["patch_id"]
        c = pd.read_parquet(pdir / "candidates_raw.parquet")
        cands.append(c)
        spectra.append(pd.read_parquet(pdir / "spectra.parquet"))
        for sd in (pdir / "stamps").glob("*"):
            shutil.copytree(sd, out_dir / "stamps" / sd.name)
    cand_df = pd.concat(cands, ignore_index=True)
    spec_df = pd.concat(spectra, ignore_index=True)

    # classifier
    ml = train_classifier(work_dir, out_dir)
    if ml and "val_auc" in ml:
        from deepfield.ml.model import load_stamp_set, predict
        X = np.stack([load_stamp_set(out_dir / "stamps" / cid) for cid in cand_df.candidate_id])
        cand_df["ml_score"] = predict(out_dir / "model.onnx", X).astype(float)
        ml["note"] = "ml_score filled from model.onnx"
    else:
        cand_df["ml_score"] = None
    use_rule = not (ml and ml.get("val_auc", 0) >= 0.8)
    ml_status = {"trained": bool(ml and "val_auc" in ml), "ranking_uses": "rule_score" if use_rule else "ml_score", **(ml or {})}

    # dossiers
    spectra_by_id = {cid: g.sort_values("wavelength_um").to_dict(orient="records") for cid, g in spec_df.groupby("candidate_id")}
    cand_records = cand_df.drop(columns=[c for c in cand_df.columns if c.startswith("_")]).to_dict(orient="records")
    cand_records = [{k: (None if (isinstance(v, float) and np.isnan(v)) else v) for k, v in r.items()} for r in cand_records]
    doss = generate_dossiers(cand_records, spectra_by_id, out_dir / "dossiers")

    write_table(pd.DataFrame(cand_records), "candidates", out_dir / "candidates.parquet", source=SPHEREX_SOURCE,
                extra_meta={"ml": ml_status, "dossiers": doss})
    write_table(spec_df, "spectra", out_dir / "spectra.parquet", source=SPHEREX_SOURCE,
                extra_meta={"units": "matched-filter PSF amplitude in MJy/sr; templates are toy models (see spectral/templates.py)"})

    # prior map with the Deep Field exclusion + targets
    mjd_map = float(np.mean([s["mjd_ref"] for s in summaries]))
    excl = deepfield_exclusion(summaries, mag50, mjd_map)
    from astropy_healpix import HEALPix
    import astropy.units as u
    hp = HEALPix(nside=NSIDE, order="ring")
    searched_hpix = {int(hp.lonlat_to_healpix(s["ra_deg"] * u.deg, s["dec_deg"] * u.deg)) for s in summaries}
    prior, pmeta = build_prior_map(mjd_map, NSIDE, excluded_deepfield=excl, searched_hpix=searched_hpix)
    write_table(prior, "prior_map", out_dir / "prior_map.parquet", source=REFPOP_SOURCE, extra_meta=pmeta)
    targets = pd.DataFrame([{
        "patch_id": s["patch_id"], "rank": i + 1, "ra_deg": s["ra_deg"], "dec_deg": s["dec_deg"], "radius_deg": s["radius_deg"],
        "hpix": int(hp.lonlat_to_healpix(s["ra_deg"] * u.deg, s["dec_deg"] * u.deg)),
        "p_surviving": float(prior.loc[prior.hpix == int(hp.lonlat_to_healpix(s["ra_deg"] * u.deg, s["dec_deg"] * u.deg)), "p_surviving"].iloc[0]),
        "n_exposures": s["n_exposures"], "mjd_start": s["mjd_start"], "mjd_end": s["mjd_end"], "visit_label": s["visit_label"],
        "status": "searched", "score": float(s["n_exposures"]) * float(prior.loc[prior.hpix == int(hp.lonlat_to_healpix(s["ra_deg"] * u.deg, s["dec_deg"] * u.deg)), "p_surviving"].iloc[0]),
        "source": SPHEREX_SOURCE,
    } for i, s in enumerate(summaries)])
    write_table(targets, "targets", out_dir / "targets.parquet", source=SPHEREX_SOURCE)

    info = {
        "kind": "RELEASE", "generated_at": now_iso(), "n_patches": len(summaries), "mag50": mag50,
        "n_injected": int(len(inj_all)), "n_recovered": int(inj_all.recovered.sum()), "n_off_field_excluded": n_off_field,
        "frac_excluded_prior": pmeta["frac_excluded_prior"], "frac_excluded_deepfield": pmeta["frac_excluded_deepfield"],
        "n_excluded_deepfield": int(excl.sum()), "ml": ml_status, "dossiers": doss,
        "patches": [{k: s.get(k) for k in ("patch_id", "ra_deg", "dec_deg", "n_exposures", "n_visits", "mode", "mjd_start", "mjd_end", "n_bands",
                                       "clean_snr_max", "median_pixel_sigma_mjysr", "n_injected", "n_recovered", "observer",
                                       "known_bodies", "device", "elapsed_s")} for s in summaries],
        "sources": [SPHEREX_SOURCE, REFPOP_SOURCE, "JPL Horizons", "JPL SBIdent"],
    }
    (out_dir / "bundle.json").write_text(json.dumps(info, indent=1, default=float))
    log.info("bundle built: %s", json.dumps({k: info[k] for k in ("n_patches", "mag50", "n_injected", "n_recovered", "n_excluded_deepfield", "ml")}, default=float))
    return info
