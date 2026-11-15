"""Deep Field validation run: real-data validation, injection–recovery, calibration and holdout.

Usage:
    PYTHONPATH=pipeline:apps/api python -m deepfield.validation --config pipeline/deepfield/validation/configs/v1.yaml

Writes data/validation/<run_id>/ with: config.yaml (copy), environment.json, inputs.json
(checksums of every exposure and catalogue response), frozen_params.json (with its hash,
written before any holdout data is read), report.json (machine-readable results), log.txt.
A compact copy of the report goes to apps/web/public/validation/report.json for /proof.

Every number in the report is labelled with its split and whether it comes from real
observations or from synthetic sources injected into real exposures.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import platform
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

from deepfield.astro import astrometry as A
from deepfield.astro import catalog as CAT
from deepfield.astro import motion_sky as M
from deepfield.astro import sources as SRC
from deepfield.astro import stats as S
from deepfield.astro import variability as V
from deepfield.astro import wcsval as W
from deepfield.astro.exposure import best_cutout_for, crop, load_exposure
from deepfield.astro.psf import EPSFModel, extendedness, find_sources, fit_epsf, fit_gaussian
from deepfield.config import CACHE_DIR, REPO_ROOT
from deepfield.validation import inject as INJ

SKY_DIR = REPO_ROOT / "data" / "sky"
CUTOUTS = CACHE_DIR / "cutouts"
PUBLIC_REPORT = REPO_ROOT / "apps" / "web" / "public" / "validation" / "report.json"
log = logging.getLogger("deepfield.validation")


# ----------------------------------------------------------------------------- utilities
def _jsonable(o):
    if isinstance(o, (np.floating,)):
        return None if not np.isfinite(o) else float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, np.ndarray):
        return [_jsonable(x) for x in o.tolist()]
    if isinstance(o, float):
        return None if not math.isfinite(o) else o
    if isinstance(o, dict):
        return {str(k): _jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_jsonable(x) for x in o]
    return o


def dump(obj, path: Path):
    path.write_text(json.dumps(_jsonable(obj), indent=1))


def config_hash(obj) -> str:
    return hashlib.sha256(json.dumps(_jsonable(obj), sort_keys=True).encode()).hexdigest()[:16]


def environment() -> dict:
    import astropy, erfa, scipy  # noqa: E401
    def git(*a):
        try:
            return subprocess.check_output(["git", *a], cwd=REPO_ROOT, text=True).strip()
        except Exception:  # noqa: BLE001
            return None
    return {"python": sys.version.split()[0], "platform": platform.platform(),
            "numpy": np.__version__, "scipy": scipy.__version__, "astropy": astropy.__version__,
            "pyerfa": erfa.__version__, "pandas": pd.__version__,
            "git_commit": git("rev-parse", "HEAD"), "git_dirty": bool(git("status", "--porcelain")),
            "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}


# ----------------------------------------------------------------------------- field loading
def load_field(field: dict, half: int):
    d = SKY_DIR / field["slug"]
    meta = json.loads((d / "sky.json").read_text())
    ra0, dec0 = float(meta["ra_deg"]), float(meta["dec_deg"])
    with np.load(d / "cube.npz", allow_pickle=True) as z:
        frames = list(zip([str(o) for o in z["obs_id"]], [int(x) for x in z["detector"]], [int(v) for v in z["visit"]]))
    exps, missing = [], []
    for obs, det, visit in frames:
        f = best_cutout_for(ra0, dec0, obs, det, CUTOUTS)
        if f is None:
            missing.append(f"{obs}_D{det}")
            continue
        ex = crop(load_exposure(f), ra0, dec0, half)
        if ex is None:
            missing.append(f"{obs}_D{det}")
            continue
        exps.append((ex, visit))
    exps.sort(key=lambda e: e[0].mjd)
    return ra0, dec0, exps, missing


def field_catalogs(ra0, dec0, half: int):
    radius = half * 6.15 * math.sqrt(2) + 60.0
    gaia, gprov = CAT.gaia_dr3(ra0, dec0, radius)
    xsc, xprov = CAT.safe(CAT.twomass_xsc, ra0, dec0, radius)
    aw, aprov = CAT.safe(CAT.allwise, ra0, dec0, radius)
    ned, nprov = CAT.safe(CAT.ned_cone, ra0, dec0, radius)
    cats = {"gaia": gaia, "twomass_xsc": xsc, "allwise": aw, "ned": ned}
    provs = {"gaia": gprov, "twomass_xsc": xprov, "allwise": aprov, "ned": nprov}
    return cats, provs


def pick_target(field, gaia: pd.DataFrame, ra0, dec0) -> str | None:
    t = field.get("target")
    if not t:
        return None
    if t != "brightest_near_centre":
        return str(t)
    sep = A.angular_sep_arcsec(gaia["ra"].to_numpy(float), gaia["dec"].to_numpy(float), ra0, dec0)
    near = gaia[(sep < 8.0) & np.isfinite(gaia["phot_g_mean_mag"])]
    return None if near.empty else str(near.sort_values("phot_g_mean_mag").iloc[0]["source_id"])


# ----------------------------------------------------------------------------- real data, one field
def real_field(field, exps, cats, params, cfg, ra0, dec0) -> dict:
    gaia = cats["gaia"]
    g_pred = gaia[pd.to_numeric(gaia["phot_g_mean_mag"], errors="coerce") <= cfg["gaia_g_max_for_prediction"]]
    inflate = params["covariance_policy"] == "inflated"
    per_exp = []
    for ex, visit in exps:
        meas = W.measure_sources(ex, nsigma=cfg["detection_nsigma"], inflate=inflate)
        pred = W.predict_catalog(ex, g_pred)
        matches = W.classify_matches(meas, pred, params["sys_floor_arcsec"])
        solve = W.solve_seeded(ex, meas, g_pred, ra0, dec0)
        per_exp.append({"ex": ex, "visit": visit, "meas": meas, "pred": pred, "matches": matches, "solve": solve,
                        "pob": A.observer_bcrs_au(ex.mjd, ex.sc_geocentric_km)})
        log.info("  %s D%d: %d detected, %s, solve=%s", ex.obs_id, ex.detector, len(meas),
                 {c: sum(m["class"] == c for m in matches) for c in ("confirmed", "probable", "ambiguous", "none")},
                 solve.get("passed"))
    return {"per_exp": per_exp, "target": pick_target(field, gaia, ra0, dec0)}


def astrometry_summary(per_exp, crit) -> dict:
    conf = [m for e in per_exp for m in e["matches"] if m["class"] == "confirmed"]
    counts = {c: sum(1 for e in per_exp for m in e["matches"] if m["class"] == c) for c in ("confirmed", "probable", "ambiguous", "none")}
    out = {"n_exposures": len(per_exp), "association_counts": counts}
    if not conf:
        return {**out, "passed": False, "reason": "no confirmed matches"}
    r = np.hypot([m["dxi"] for m in conf], [m["deta"] for m in conf])
    dxi = np.array([m["dxi"] for m in conf])
    deta = np.array([m["deta"] for m in conf])
    out["residual_arcsec"] = S.summarize(r)
    out["residual_px"] = {k: (v / 6.15 if k != "n" else v) for k, v in S.summarize(r).items()}
    out["mean_offset_arcsec"] = {"xi": float(np.mean(dxi)), "eta": float(np.mean(deta)),
                                 "sem_xi": float(np.std(dxi) / math.sqrt(len(dxi))), "sem_eta": float(np.std(deta) / math.sqrt(len(deta)))}
    zps = [M.exposure_zero_point(e["matches"]) for e in per_exp]
    zps = [z for z in zps if z]
    if zps:
        zx, zy = np.array([z["mean"][0] for z in zps]), np.array([z["mean"][1] for z in zps])
        out["per_exposure_zero_point_arcsec"] = {"n": len(zps), "rms_xi": float(np.std(zx)), "rms_eta": float(np.std(zy)),
                                                 "max_abs": float(np.max(np.hypot(zx, zy)))}
    # spatial dependence: regress residuals on window position
    X = np.array([[1.0, m["x"] - 45, m["y"] - 45] for m in conf])
    trend = {}
    for name, yv in (("xi", dxi), ("eta", deta)):
        beta, *_ = np.linalg.lstsq(X, yv, rcond=None)
        res = yv - X @ beta
        s2 = float(res @ res) / max(len(yv) - 3, 1)
        se = np.sqrt(np.diag(np.linalg.inv(X.T @ X)) * s2)
        trend[name] = {"slope_x_arcsec_per_100px": float(beta[1] * 100), "slope_y_arcsec_per_100px": float(beta[2] * 100),
                       "se_x": float(se[1] * 100), "se_y": float(se[2] * 100)}
    out["spatial_trend"] = trend
    d2 = np.array([m["d2"] for m in conf])
    out["normalised_residual_coverage"] = S.coverage_2d(d2)
    out["required_sys_floor_arcsec"] = W.required_floor([m for e in per_exp for m in e["matches"]])
    per_exp_conf = [sum(m["class"] == "confirmed" for m in e["matches"]) for e in per_exp]
    out["confirmed_per_exposure"] = {"min": int(min(per_exp_conf)), "median": float(np.median(per_exp_conf)), "max": int(max(per_exp_conf))}
    elig = sum(1 for e in per_exp for p in e["pred"] if p["reference_quality"] and 0 <= p["x"] < 91 and 0 <= p["y"] < 91)
    out["match_ratio_confirmed_over_reference_in_frame"] = counts["confirmed"] / elig if elig else None
    c = crit["official_wcs"]
    checks = {"min_confirmed_per_exposure": bool(min(per_exp_conf) >= c["min_confirmed_per_exposure"]),
              "median_residual": bool(out["residual_arcsec"]["median"] <= c["max_median_residual_arcsec"]),
              "mean_offset": bool(max(abs(out["mean_offset_arcsec"]["xi"]), abs(out["mean_offset_arcsec"]["eta"])) <= c["max_abs_mean_offset_arcsec"])}
    out["checks"], out["passed"] = checks, all(checks.values())
    sol = [e["solve"] for e in per_exp if e["solve"]]
    solved = [s for s in sol if s.get("status") == "solved"]
    passed = [s for s in solved if s["passed"]]
    out["seeded_solve"] = {
        "n_exposures": len(sol), "n_solved": len(solved), "n_passed": len(passed),
        "out_of_sample_rms_px": S.summarize([s["rms_out_of_sample_px"] for s in passed]),
        "vs_official_centre_sep_arcsec": S.summarize([s["vs_official"]["centre_sep_arcsec"] for s in passed]),
        "vs_official_max_sep_arcsec": S.summarize([s["vs_official"]["max_sep_arcsec"] for s in passed]),
        "scale_ratio": S.summarize([s["vs_official"]["scale_ratio"] for s in passed]),
        "rotation_diff_deg": S.summarize([abs(s["vs_official"]["rotation_diff_deg"]) for s in passed]),
        "parity_agrees": int(sum(s["vs_official"]["parity_agrees"] for s in passed)),
        "failures": [{"status": s.get("status"), "checks": s.get("checks"), "matched": s.get("matched")} for s in sol if not s.get("passed")][:20],
    }
    return out


def wing_fit_validation(per_exp) -> dict:
    """Saturated stars fitted on their unsaturated wings (core pixels masked), checked against Gaia.

    Decides, on real data, whether wing fits may be used for a saturated target. Uses isolated
    Gaia-matched stars whose core is flagged OVERFLOW/NONLINEAR."""
    rows = [m for e in per_exp for m in e["matches"]
            if m.get("saturated") and m.get("match") and m.get("isolated") and m.get("d2") is not None and m.get("n_pix", 0) >= 20]
    if not rows:
        return {"n": 0, "usable": False, "reason": "no isolated saturated Gaia stars in the field"}
    r = np.hypot([m["dxi"] for m in rows], [m["deta"] for m in rows])
    cov = S.coverage_2d([m["d2"] for m in rows])
    usable = bool(len(rows) >= 20 and cov["empirical"][1] >= 0.85)
    return {"n": len(rows), "residual_arcsec": S.summarize(r), "coverage": cov, "usable": usable,
            "rule": "usable if ≥ 20 star-exposures and ≥ 85 % of normalised residuals inside the nominal 95.45 % region"}


def _epochs_for(per_exp, gaia_id: str, exclude_zp_ids=(), require_class=("confirmed", "probable", "ambiguous"),
                allow_saturated: bool = False):
    eps = []
    for e in per_exp:
        m = next((m for m in e["matches"] if m.get("match") == gaia_id and m["class"] in require_class
                  and (allow_saturated or not m["saturated"]) and m.get("n_pix", 0) >= (20 if m["saturated"] else 12)), None)
        if m is None:
            continue
        zp = M.exposure_zero_point(e["matches"], exclude_ids=(gaia_id, *exclude_zp_ids))
        if zp is None:
            continue
        ra, dec = A.from_tangent_arcsec(-zp["mean"][0], -zp["mean"][1], m["ra"], m["dec"])
        eps.append({"mjd": e["ex"].mjd, "ra": float(ra), "dec": float(dec), "visit": e["visit"],
                    "cov": np.asarray(m["cov_sky"]) + np.asarray(zp["cov"]), "pob": e["pob"],
                    "flux": m["flux"], "flux_err": m["flux_err"], "lam": e["ex"].wavelength_at(m["x"], m["y"])[0]})
    return eps


def motion_summary(per_exp, gaia: pd.DataFrame, target_id: str | None, reg_cfg) -> dict:
    gi = gaia.set_index("source_id")
    # registration check on confirmed field stars with Gaia astrometry
    counts = {}
    for e in per_exp:
        for m in e["matches"]:
            if m["class"] == "confirmed":
                counts[m["match"]] = counts.get(m["match"], 0) + 1
    stars = [s for s, n in counts.items() if n >= reg_cfg["min_epochs"] and s != target_id and s in gi.index
             and np.isfinite(gi.loc[s].get("pmra", np.nan))]
    reg = []
    for sid in stars[:60]:
        eps = _epochs_for(per_exp, sid, require_class=("confirmed",))
        row = gi.loc[sid]
        fit = M.epochs_to_fit(eps, float(row["ra"]), float(row["dec"]), eps[0]["mjd"] if eps else 0.0,
                              parallax_mode="fixed", parallax_fixed_arcsec=float(row["parallax"]) / 1000 if np.isfinite(row["parallax"]) else 0.0)
        if fit is None:
            continue
        cmp_ = M.compare_pm(fit, [row["pmra"], row["pmdec"]], M.gaia_pm_cov_mas(row))
        reg.append({"source_id": sid, "n": fit["n_epochs"], "d2": cmp_["d2"], "p": cmp_["p"],
                    "pm_err_arcsec_yr": float(np.sqrt(np.trace(np.asarray(fit["cov_pm"])) / 2)),
                    "delta_pm_arcsec_yr": float(np.hypot(*cmp_["delta"]))})
    frac_bad = float(np.mean([r["p"] < M.P_CONSISTENT for r in reg])) if reg else None
    registration = {"n_field_stars": len(reg), "fraction_inconsistent": frac_bad,
                    "expected_fraction_if_calibrated": M.P_CONSISTENT,
                    "median_d2": float(np.median([r["d2"] for r in reg])) if reg else None,
                    "coverage": S.coverage_2d([r["d2"] for r in reg]) if reg else None,
                    "median_pm_error_arcsec_yr": float(np.median([r["pm_err_arcsec_yr"] for r in reg])) if reg else None,
                    "ok": None if frac_bad is None else bool(frac_bad <= reg_cfg["max_fraction_inconsistent"])}
    tgt = {"gaia_id": target_id}
    wing = wing_fit_validation(per_exp)
    if target_id and target_id in gi.index:
        row = gi.loc[target_id]
        strict = _epochs_for(per_exp, target_id)
        with_wings = _epochs_for(per_exp, target_id, allow_saturated=True)
        use_wings = wing["usable"] and len(with_wings) > len(strict)
        eps = with_wings if use_wings else strict
        tgt["epochs_strict_unsaturated"] = len(strict)
        tgt["epochs_including_wing_fits"] = len(with_wings)
        tgt["wing_fits_used"] = bool(use_wings)
        tgt["n_epochs_usable"] = len(eps)
        tgt["n_exposures"] = len(per_exp)
        px = float(row["parallax"]) / 1000 if np.isfinite(row.get("parallax", np.nan)) else 0.0
        fit_free = M.epochs_to_fit(eps, float(row["ra"]), float(row["dec"]), eps[0]["mjd"] if eps else 0.0, parallax_mode="auto")
        fit_fix = M.epochs_to_fit(eps, float(row["ra"]), float(row["dec"]), eps[0]["mjd"] if eps else 0.0,
                                  parallax_mode="fixed", parallax_fixed_arcsec=px)
        gcov = M.gaia_pm_cov_mas(row)
        tgt["gaia"] = {"pmra_mas_yr": float(row["pmra"]), "pmdec_mas_yr": float(row["pmdec"]), "parallax_mas": float(row["parallax"]),
                       "g_mag": float(row["phot_g_mean_mag"]), "ruwe": float(row.get("ruwe", np.nan))}
        tgt["fit_parallax_from_gaia"] = fit_fix
        tgt["fit_parallax_free_or_auto"] = fit_free
        enough = len(eps) >= reg_cfg["min_epochs"]
        tgt["vs_gaia"] = M.compare_pm(fit_fix, [row["pmra"], row["pmdec"]], gcov) if (fit_fix and enough) else None
        tgt["label"] = M.label(fit_fix if enough else None, tgt["vs_gaia"], registration["ok"], True)
        if not enough:
            tgt["label"] = (f"not measurable: only {len(eps)} of {len(per_exp)} exposures give a usable, unsaturated position "
                            f"(need {reg_cfg['min_epochs']})")
        ruwe = float(row.get("ruwe", np.nan))
        if np.isfinite(ruwe) and ruwe > 1.4:
            tgt["gaia_caveat"] = f"Gaia RUWE = {ruwe:.2f} > 1.4: Gaia's own solution may be perturbed (e.g. binarity)"
    elif target_id:
        tgt["label"] = "target not in the Gaia query"
    else:
        tgt["label"] = "no designated target (e.g. not in Gaia, or the position is not the target's)"
    return {"registration": registration, "wing_fit_validation": wing, "target": tgt, "field_star_samples": reg[:60]}


def variability_summary(per_exp, gaia_ids: list[str], f_sys: float, vcfg) -> dict:
    res = []
    for sid in gaia_ids:
        eps = _epochs_for(per_exp, sid, require_class=("confirmed",))
        if len(eps) < vcfg["min_epochs"]:
            continue
        t = V.variability_test([e["lam"] for e in eps], [e["flux"] for e in eps], [e["flux_err"] for e in eps],
                               [e["visit"] for e in eps], f_sys=f_sys)
        res.append({"source_id": sid, **{k: t.get(k) for k in ("testable", "verdict", "p_primary", "p_lrt", "p_pairs", "delta_chi2", "dof_lrt",
                                                                "chi2_null_dof", "peak_to_peak", "n", "n_visits", "overlap_pairs")}})
    tested = [r for r in res if r["testable"]]
    q = S.bh_qvalues([r["p_primary"] for r in tested])
    for r, qq in zip(tested, q):
        r["q_bh"] = float(qq)
        r["candidate_variable"] = bool(qq < vcfg["fdr_q"])
    p = np.array([r["p_primary"] for r in tested]) if tested else np.zeros(0)
    return {"n_sources": len(res), "n_testable": len(tested), "n_inconclusive": len(res) - len(tested),
            "n_candidates_q05": int(sum(r.get("candidate_variable", False) for r in tested)),
            "fraction_p_below_0.05": float(np.mean(p < 0.05)) if len(p) else None,
            "fraction_p_below_0.0027": float(np.mean(p < 0.0027)) if len(p) else None,
            "sources": res}


def psf_comparison(per_exp, max_per_exp: int = 25) -> list[dict]:
    rows = []
    for e in per_exp:
        ex = e["ex"]
        for m in [m for m in e["matches"] if m["class"] == "confirmed" and 10 <= m["snr"] <= 2000][:max_per_exp]:
            g = fit_gaussian(ex.image, ex.variance, ex.bad, m["x"], m["y"])
            if g is None or g["pinned"]:
                continue
            ra_g, dec_g = ex.wcs.all_pix2world([[g["x"], g["y"]]], 0)[0]
            pred_ra, pred_dec = A.from_tangent_arcsec(-m["dxi"], -m["deta"], m["ra"], m["dec"])
            rg = A.angular_sep_arcsec(ra_g, dec_g, pred_ra, pred_dec)
            rows.append({"snr": m["snr"], "phase_x": m["x"] - round(m["x"]), "phase_y": m["y"] - round(m["y"]),
                         "epsf_chi2_dof": m["chi2_dof"], "gauss_chi2_dof": g["chi2_dof"],
                         "epsf_resid_arcsec": float(math.hypot(m["dxi"], m["deta"])), "gauss_resid_arcsec": float(rg),
                         "flux_ratio_gauss_over_epsf": g["flux"] / m["flux"] if m["flux"] > 0 else None,
                         "gauss_sigma_px": g["sigma_px"],
                         "dx_gauss_minus_epsf_px": g["x"] - m["x"], "dy_gauss_minus_epsf_px": g["y"] - m["y"]})
    return rows


def psf_summary(rows) -> dict:
    if not rows:
        return {"n": 0}
    df = pd.DataFrame(rows)
    out = {"n_star_exposures": int(len(df)),
           "median_chi2_dof": {"epsf": float(df["epsf_chi2_dof"].median()), "gaussian": float(df["gauss_chi2_dof"].median())},
           "astrometric_residual_vs_gaia_arcsec": {"epsf": S.summarize(df["epsf_resid_arcsec"]), "gaussian": S.summarize(df["gauss_resid_arcsec"])},
           "fraction_epsf_better_chi2": float(np.mean(df["epsf_chi2_dof"] < df["gauss_chi2_dof"])),
           "fraction_epsf_closer_to_gaia": float(np.mean(df["epsf_resid_arcsec"] < df["gauss_resid_arcsec"])),
           "flux_ratio_gauss_over_epsf": S.summarize(df["flux_ratio_gauss_over_epsf"].dropna())}
    bins = [10, 30, 100, 300, 2000]
    by = []
    for lo, hi in zip(bins[:-1], bins[1:]):
        s = df[(df["snr"] >= lo) & (df["snr"] < hi)]
        if len(s) >= 5:
            by.append({"snr_lo": lo, "snr_hi": hi, "n": int(len(s)), "flux_ratio_median": float(s["flux_ratio_gauss_over_epsf"].median()),
                       "epsf_resid_median": float(s["epsf_resid_arcsec"].median()), "gauss_resid_median": float(s["gauss_resid_arcsec"].median()),
                       "epsf_chi2_dof_median": float(s["epsf_chi2_dof"].median()), "gauss_chi2_dof_median": float(s["gauss_chi2_dof"].median())})
    out["by_snr"] = by
    # pixel-phase dependence of the position difference (Gaussian − ePSF)
    ph = []
    for lo in np.arange(-0.5, 0.5, 0.2):
        s = df[(df["phase_x"] >= lo) & (df["phase_x"] < lo + 0.2)]
        if len(s) >= 5:
            ph.append({"phase_lo": float(lo), "n": int(len(s)), "median_dx_gauss_minus_epsf_px": float(s["dx_gauss_minus_epsf_px"].median())})
    out["position_difference_vs_pixel_phase"] = ph
    return out


def sources_summary(per_exp, cats, provs, ecfg, params) -> dict:
    """Morphology + catalogue identity for the brightest distinct sources in the field."""
    pts = []
    for k, e in enumerate(per_exp):
        for m in e["meas"]:
            pts.append((m["ra"], m["dec"], m["snr"], k, m))
    pts.sort(key=lambda p: -p[2])
    groups = []
    for ra, dec, snr, k, m in pts:
        for g in groups:
            if A.angular_sep_arcsec(ra, dec, g["ra"], g["dec"]) < 3.0:
                g["members"].append((k, m))
                break
        else:
            groups.append({"ra": ra, "dec": dec, "snr": snr, "members": [(k, m)]})
    groups = [g for g in groups if len(g["members"]) >= 3][: ecfg["max_sources_per_field"]]
    out = []
    for g in groups:
        ext = []
        for k, m in sorted(g["members"], key=lambda km: -km[1]["snr"])[: ecfg["exposures_per_source"]]:
            ex = per_exp[k]["ex"]
            if m["saturated"]:
                continue
            ext.append(extendedness(ex.image, ex.variance, ex.bad, m["x"], m["y"], ex.epsf_at(m["x"], m["y"]), ex.oversample))
        morph = SRC.morphology(ext, min_blur_px=params["ext_min_blur_px"], p_threshold=ecfg["p_threshold"])
        assoc = SRC.associate(g["ra"], g["dec"], {k: v for k, v in cats.items() if v is not None}, provs)
        cls = SRC.classify(morph, assoc)
        out.append({"ra": g["ra"], "dec": g["dec"], "peak_snr": g["snr"], "n_detections": len(g["members"]),
                    "morphology": morph, "associations": assoc, **cls})
    tally = {}
    for s in out:
        tally[s["class"]] = tally.get(s["class"], 0) + 1
    return {"n_sources": len(out), "classes": tally, "sources": out}


# ----------------------------------------------------------------------------- injection–recovery
def injection_field(field, exps, cfg, params, seed: int, avoid_sky, ra0, dec0) -> dict:
    icfg = cfg["injection"]
    rng = np.random.default_rng(seed)
    inflate = params["covariance_policy"] == "inflated"
    # noise scale: median forced-photometry σ for a point source in this field
    sig = []
    gains = []
    for ex, _ in exps[:8]:
        gains.append(INJ.noise_gain(ex))
        m = EPSFModel(ex.epsf_at(45, 45), ex.oversample)
        f = V.forced_flux(ex.image, ex.variance, ex.bad, 45.3, 44.7, m)
        if f:
            sig.append(f["flux_err"])
    gain = float(np.median([g for g in gains if g])) if any(gains) else 0.0
    flux_per_snr = float(np.median(sig))
    t0 = float(np.median([ex.mjd for ex, _ in exps]))
    pop = INJ.population(rng, (ra0, dec0), icfg["radius_px"] * 6.15, t0, flux_per_snr, icfg["counts"], icfg, avoid_sky)
    byid = {s.id: s for s in pop}
    obs = {s.id: [] for s in pop}
    groups: dict[int, list] = {}
    for s in pop:                                    # batches as assigned at placement (partners with their primary)
        groups.setdefault(int(s.meta.get("batch", 0)), []).append(s)
    flat = [groups[k] for k in sorted(groups)]
    for bi, batch in enumerate(flat):
        for ex, visit in exps:
            img, var, placed = INJ.inject(ex, batch, rng, gain)
            det = find_sources(img, var, ex.bad, fwhm_px=ex.psf_fwhm_arcsec / 6.15, nsigma=cfg["detection_nsigma"])
            dxy = np.array([[d["x"], d["y"]] for d in det]) if det else np.zeros((0, 2))
            for p in placed:
                s = byid[p["id"]]
                dd = np.hypot(dxy[:, 0] - p["x"], dxy[:, 1] - p["y"]) if len(dxy) else np.array([])
                detected = bool(len(dd) and dd.min() < 1.5)
                n_near = int(np.sum(dd < 3.0)) if len(dd) else 0
                m = EPSFModel(ex.epsf_at(p["x"], p["y"]), ex.oversample)
                fit = fit_epsf(img, var, ex.bad, p["x"], p["y"], m)
                forced = V.forced_flux(img, var, ex.bad, p["x"], p["y"], m)
                rec = {"mjd": ex.mjd, "visit": visit, "lam": p["lam"], "true_flux": p["flux"], "detected": detected, "n_near": n_near,
                       "pob": A.observer_bcrs_au(ex.mjd, ex.sc_geocentric_km)}
                if forced:
                    rec.update({"forced_flux": forced["flux"], "forced_err": forced["flux_err"]})
                if fit and not fit["pinned"]:
                    cov_px = np.asarray(fit["cov_px"]) * (max(1.0, fit["chi2_dof"]) if inflate else 1.0)
                    ra, dec = ex.wcs.all_pix2world([[fit["x"], fit["y"]]], 0)[0]
                    xi, eta = A.tangent_offsets_arcsec(ra, dec, p["ra"], p["dec"])
                    csky = A.pixel_cov_to_sky(ex.wcs, fit["x"], fit["y"], cov_px)
                    csky_raw = A.pixel_cov_to_sky(ex.wcs, fit["x"], fit["y"], np.asarray(fit["cov_px"]))
                    rec.update({"ra": float(ra), "dec": float(dec), "cov": csky, "err_arcsec": float(math.hypot(xi, eta)),
                                "d2": float(S.mahalanobis2([xi, eta], csky)), "d2_raw": float(S.mahalanobis2([xi, eta], csky_raw)),
                                "d2_inflated": float(S.mahalanobis2([xi, eta], A.pixel_cov_to_sky(ex.wcs, fit["x"], fit["y"], np.asarray(fit["cov_px"]) * max(1.0, fit["chi2_dof"])))),
                                "fit_flux": fit["flux"], "fit_flux_err": fit["flux_err"], "chi2_dof": fit["chi2_dof"]})
                if s.kind in ("extended", "static") and s.snr_target >= 20 and len([o for o in obs[s.id] if "ext" in o]) < 4 and fit:
                    rec["ext"] = extendedness(img, var, ex.bad, p["x"], p["y"], ex.epsf_at(p["x"], p["y"]), ex.oversample)
                obs[s.id].append(rec)
        log.info("  injection batch %d/%d done", bi + 1, len(flat))
    return {"population": pop, "obs": obs, "flux_per_snr": flux_per_snr, "gain": gain, "t0": t0}


def injection_metrics(inj, params, vcfg, ecfg) -> dict:
    pop, obs = inj["population"], inj["obs"]
    rows = []
    for s in pop:
        for o in obs[s.id]:
            snr_true = o["true_flux"] / o["forced_err"] if o.get("forced_err") else np.nan
            rows.append({"id": s.id, "kind": s.kind, "snr_true": snr_true, **{k: o.get(k) for k in
                         ("detected", "err_arcsec", "d2", "d2_raw", "d2_inflated", "fit_flux", "fit_flux_err", "true_flux", "n_near")}})
    df = pd.DataFrame(rows)
    out = {"n_sources": len(pop), "n_source_exposures": int(len(df)), "noise_gain": inj["gain"], "flux_per_unit_snr": inj["flux_per_snr"]}
    pt = df[df["kind"].isin(["static", "moving", "variable", "steep"])]
    bins = [1, 2, 3, 5, 7, 10, 20, 50, 100, 300, 3000]
    comp = []
    for lo, hi in zip(bins[:-1], bins[1:]):
        s = pt[(pt["snr_true"] >= lo) & (pt["snr_true"] < hi)]
        if len(s):
            k = int(s["detected"].sum())
            lo_ci, hi_ci = S.wilson_interval(k, len(s))
            comp.append({"snr_lo": lo, "snr_hi": hi, "n": int(len(s)), "completeness": k / len(s), "ci68": [lo_ci, hi_ci]})
    out["completeness_vs_snr"] = comp
    det = pt[pt["detected"] & pt["err_arcsec"].notna()]
    ast = []
    for lo, hi in zip(bins[:-1], bins[1:]):
        s = det[(det["snr_true"] >= lo) & (det["snr_true"] < hi)]
        if len(s) >= 5:
            ast.append({"snr_lo": lo, "snr_hi": hi, "n": int(len(s)), "median_err_arcsec": float(s["err_arcsec"].median()),
                        "rms_err_arcsec": float(np.sqrt(np.mean(s["err_arcsec"] ** 2)))})
    out["astrometric_error_vs_snr"] = ast
    out["position_coverage"] = {"raw": S.coverage_2d(det["d2_raw"]), "inflated": S.coverage_2d(det["d2_inflated"]),
                                "policy_used": params["covariance_policy"]}
    fl = det[det["fit_flux"].notna() & (det["snr_true"] >= 5)]
    out["flux"] = {"fractional_bias_median": float(((fl["fit_flux"] - fl["true_flux"]) / fl["true_flux"]).median()) if len(fl) else None,
                   "coverage": S.coverage_1d((fl["fit_flux"] - fl["true_flux"]) / fl["fit_flux_err"]) if len(fl) else None,
                   "n": int(len(fl))}
    # false detections: injected-free check is not possible per source; report confusion near blends instead
    # motion recovery
    mot = []
    for s in pop:
        if s.kind not in ("moving", "static"):
            continue
        eps = [{"mjd": o["mjd"], "ra": o["ra"], "dec": o["dec"], "cov": o["cov"], "pob": o["pob"]}
               for o in obs[s.id] if o.get("detected") and "ra" in o]
        fit = M.epochs_to_fit(eps, s.ra0, s.dec0, s.t0_mjd, parallax_mode="none")
        if fit is None:
            continue
        d = np.asarray(fit["pm_arcsec_yr"]) - np.asarray(s.pm)
        d2 = float(S.mahalanobis2(d, np.asarray(fit["cov_pm"])))
        mot.append({"kind": s.kind, "snr": s.snr_target, "true_pm": float(np.hypot(*s.pm)), "fit_pm": fit["pm_total"],
                    "err_arcsec_yr": float(np.hypot(*d)), "d2": d2, "motion_p": fit["motion_p"], "n": fit["n_epochs"]})
    md = pd.DataFrame(mot)
    if len(md):
        mov, sta = md[md["kind"] == "moving"], md[md["kind"] == "static"]
        out["motion"] = {
            "n_moving": int(len(mov)), "n_static": int(len(sta)),
            "pm_error_arcsec_yr": S.summarize(md["err_arcsec_yr"]),
            "pm_coverage": S.coverage_2d(md["d2"]),
            "detected_motion_rate_moving_p0027": float(np.mean(mov["motion_p"] < 0.0027)) if len(mov) else None,
            "false_motion_rate_static_p0027": float(np.mean(sta["motion_p"] < 0.0027)) if len(sta) else None,
            "by_pm": [{"pm_lo": lo, "pm_hi": hi, "n": int(len(s)), "detected_rate": float(np.mean(s["motion_p"] < 0.0027)),
                       "median_err": float(s["err_arcsec_yr"].median())}
                      for lo, hi in ((0.5, 2), (2, 5), (5, 12.1)) for s in [mov[(mov["true_pm"] >= lo) & (mov["true_pm"] < hi)]] if len(s)],
        }
    # variability recovery and spectral-confusion false positives
    var = []
    for s in pop:
        if s.kind not in ("variable", "static", "steep"):
            continue
        o = [o for o in obs[s.id] if o.get("forced_flux") is not None]
        if len(o) < vcfg["min_epochs"]:
            continue
        t = V.variability_test([x["lam"] for x in o], [x["forced_flux"] for x in o], [x["forced_err"] for x in o],
                               [x["visit"] for x in o], f_sys=params["f_sys"])
        var.append({"kind": s.kind, "amp": s.amp, "beta": s.beta, "snr": s.snr_target, "testable": t["testable"],
                    "p": t.get("p_primary"), "p_lrt": t.get("p_lrt")})
    vd = pd.DataFrame(var)
    if len(vd):
        tv = vd[vd["testable"]]
        q = S.bh_qvalues(tv["p"].to_numpy()) if len(tv) else np.zeros(0)
        q_lrt = S.bh_qvalues(tv["p_lrt"].to_numpy()) if len(tv) else np.zeros(0)
        tv = tv.assign(q=q, q_lrt=q_lrt)

        def rate(kind, col):
            s = tv[tv["kind"] == kind]
            return float(np.mean(s[col] < vcfg["fdr_q"])) if len(s) else None
        out["variability"] = {
            "primary_test": "matched-wavelength pairs (model-free)",
            "n_tested": int(len(tv)), "n_inconclusive": int((~vd["testable"]).sum()),
            "false_positive_rate_static_q05": rate("static", "q"),
            "false_positive_rate_steep_spectrum_q05": rate("steep", "q"),
            "lrt_false_positive_rate_static_q05": rate("static", "q_lrt"),
            "lrt_false_positive_rate_steep_spectrum_q05": rate("steep", "q_lrt"),
            "detection_rate_by_amplitude_q05": [{"amp": a, "n": int(len(g)), "rate": float(np.mean(g["q"] < vcfg["fdr_q"])),
                                                 "rate_lrt": float(np.mean(g["q_lrt"] < vcfg["fdr_q"]))}
                                                for a, g in tv[tv["kind"] == "variable"].groupby("amp")],
            "p_values_static_fraction_below_0.05": float(np.mean(tv[tv["kind"] == "static"]["p"] < 0.05)) if (tv["kind"] == "static").any() else None,
        }
    # extended-source classification
    ext = []
    for s in pop:
        if s.kind not in ("extended", "static") or s.snr_target < 20:
            continue
        rs = [o["ext"] for o in obs[s.id] if o.get("ext")]
        if not rs:
            continue
        mo = SRC.morphology(rs, min_blur_px=params["ext_min_blur_px"], p_threshold=ecfg["p_threshold"])
        ext.append({"kind": s.kind, "blur": s.blur_px, "resolved": mo["resolved"], "median_blur_px": mo["median_blur_px"],
                    "p_point_combined": mo["p_point_combined"]})
    ed = pd.DataFrame(ext)
    if len(ed):
        e, p_ = ed[ed["kind"] == "extended"], ed[ed["kind"] == "static"]
        out["extended"] = {"n_extended": int(len(e)), "n_point": int(len(p_)), "min_blur_px_used": params["ext_min_blur_px"],
                           "recall_extended": float(np.mean(e["resolved"])) if len(e) else None,
                           "false_extended_rate_points": float(np.mean(p_["resolved"])) if len(p_) else None,
                           "recall_by_blur": [{"blur_px": b, "n": int(len(g)), "recall": float(np.mean(g["resolved"]))} for b, g in e.groupby("blur")],
                           "samples": ed.to_dict("records")}
    # blends
    bl = []
    for s in pop:
        if s.kind != "blend":
            continue
        o = [x for x in obs[s.id] if "err_arcsec" in x]
        if not o:
            continue
        bl.append({"sep_px": s.meta["sep_px"], "ratio": s.meta["ratio"], "median_err_arcsec": float(np.median([x["err_arcsec"] for x in o])),
                   "resolved_fraction": float(np.mean([x["n_near"] >= 2 for x in o]))})
    if bl:
        bd = pd.DataFrame(bl)
        out["blends"] = {"n_pairs": int(len(bd)), "median_err_brighter_arcsec": float(bd["median_err_arcsec"].median()),
                         "resolved_fraction_by_sep": [{"sep_lo": lo, "sep_hi": hi, "n": int(len(g)), "resolved": float(g["resolved_fraction"].mean()),
                                                       "median_err_arcsec": float(g["median_err_arcsec"].median())}
                                                      for lo, hi in ((0.6, 1.2), (1.2, 1.8), (1.8, 2.6)) for g in [bd[(bd["sep_px"] >= lo) & (bd["sep_px"] < hi)]] if len(g)]}
    return out


# ----------------------------------------------------------------------------- orchestration
def run(config_path: Path, out_root: Path | None = None, only: list[str] | None = None) -> Path:
    cfg = yaml.safe_load(Path(config_path).read_text())
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + config_hash(cfg)[:8]
    out = (out_root or REPO_ROOT / "data" / "validation") / run_id
    out.mkdir(parents=True, exist_ok=True)
    fh = logging.FileHandler(out / "log.txt", encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
    log.addHandler(fh)
    log.addHandler(logging.StreamHandler(sys.stdout))
    log.setLevel(logging.INFO)
    shutil.copy(config_path, out / "config.yaml")
    env = environment()
    dump(env, out / "environment.json")
    log.info("run %s, config hash %s, seed %s, commit %s (dirty=%s)", run_id, config_hash(cfg), cfg["seed"], env["git_commit"], env["git_dirty"])
    half = cfg["window_half_px"]
    fields = [f for f in cfg["fields"] if not only or f["id"] in only]
    params = dict(cfg["provisional"])
    params["ext_min_blur_px"] = cfg["extendedness"]["min_blur_px"]
    report = {"run_id": run_id, "config_hash": config_hash(cfg), "seed": cfg["seed"], "environment": env, "fields": {}, "splits": {}}
    inputs = {"exposures": {}, "catalogs": {}}
    t_start = time.time()

    def do_field(field, params, with_injection: bool, seed_offset: int):
        log.info("field %s (%s) split=%s params=%s", field["id"], field["name"], field["split"], params)
        ra0, dec0, exps, missing = load_field(field, half)
        cats, provs = field_catalogs(ra0, dec0, half)
        inputs["exposures"][field["id"]] = [ex.provenance for ex, _ in exps]
        inputs["catalogs"][field["id"]] = provs
        real = real_field(field, exps, cats, params, cfg, ra0, dec0)
        per_exp = real["per_exp"]
        fr = {"name": field["name"], "slug": field["slug"], "split": field["split"], "data": "real SPHEREx exposures",
              "centre": [ra0, dec0], "n_exposures": len(exps), "missing_cutouts": missing, "params_used": dict(params),
              "astrometry": astrometry_summary(per_exp, cfg["pass_criteria"]),
              "motion": motion_summary(per_exp, cats["gaia"], real["target"], cfg["registration"]),
              "psf_rows": psf_comparison(per_exp)}
        conf_ids = sorted({m["match"] for e in per_exp for m in e["matches"] if m["class"] == "confirmed"})
        if real["target"]:
            conf_ids = sorted(set(conf_ids) | {real["target"]})
        fr["variability"] = variability_summary(per_exp, conf_ids, params["f_sys"], cfg["variability"])
        fr["sources"] = sources_summary(per_exp, cats, provs, cfg["extendedness"], params)
        if with_injection:
            avoid = [(m["ra"], m["dec"]) for m in per_exp[0]["meas"] if m["snr"] >= 20] if per_exp else []
            inj = injection_field(field, exps, cfg, params, cfg["seed"] + seed_offset, avoid, ra0, dec0)
            fr["injection"] = {"data": "synthetic sources injected into real SPHEREx exposures",
                               **injection_metrics(inj, params, cfg["variability"], cfg["extendedness"])}
        return fr, per_exp, cats

    # 1. development: choose covariance policy from injection coverage
    dev = [f for f in fields if f["split"] == "development"]
    cov_score = {"raw": [], "inflated": []}
    for i, f in enumerate(dev):
        fr, _, _ = do_field(f, params, True, i)
        report["fields"][f["id"]] = fr
        pc = fr["injection"]["position_coverage"]
        for k in ("raw", "inflated"):
            if pc[k].get("n"):
                cov_score[k].append(abs(pc[k]["empirical"][0] - S.NOMINAL[0]) + abs(pc[k]["empirical"][1] - S.NOMINAL[1]))
    choice = min(cov_score, key=lambda k: np.mean(cov_score[k]) if cov_score[k] else 9) if any(cov_score.values()) else params["covariance_policy"]
    params["covariance_policy"] = choice
    # extendedness: smallest blur threshold with ≤ 5 % false "extended" on dev point sources, best recall
    samples = [s for f in dev for s in report["fields"][f["id"]]["injection"].get("extended", {}).get("samples", [])]
    ext_choice, ext_table = params["ext_min_blur_px"], []
    for thr in (0.5, 0.6, 0.75, 0.9, 1.0):
        pts = [s for s in samples if s["kind"] == "static"]
        exs = [s for s in samples if s["kind"] == "extended"]
        res = lambda s: s["p_point_combined"] < cfg["extendedness"]["p_threshold"] and s["median_blur_px"] >= thr  # noqa: E731
        fpr = float(np.mean([res(s) for s in pts])) if pts else None
        rec = float(np.mean([res(s) for s in exs])) if exs else None
        ext_table.append({"min_blur_px": thr, "false_extended_rate_points": fpr, "recall_extended": rec, "n_points": len(pts), "n_extended": len(exs)})
    ok_rows = [r for r in ext_table if r["false_extended_rate_points"] is not None and r["false_extended_rate_points"] <= 0.05]
    if ok_rows:
        ext_choice = max(ok_rows, key=lambda r: (r["recall_extended"] or 0, -r["min_blur_px"]))["min_blur_px"]
    params["ext_min_blur_px"] = ext_choice
    report["splits"]["development"] = {"fields": [f["id"] for f in dev], "decided": {
        "covariance_policy": choice, "coverage_distance": {k: float(np.mean(v)) if v else None for k, v in cov_score.items()},
        "ext_min_blur_px": ext_choice, "extendedness_threshold_scan": ext_table}}
    log.info("development → covariance_policy = %s (%s), ext_min_blur_px = %s", choice, cov_score, ext_choice)

    # 2. calibration: systematic floors from real stars
    cal = [f for f in fields if f["split"] == "calibration"]
    floors, var_stars = [], []
    for f in cal:
        fr, per_exp, cats = do_field(f, params, True, 100)
        report["fields"][f["id"]] = fr
        floors.append(fr["astrometry"].get("required_sys_floor_arcsec"))
        for sid in sorted({m["match"] for e in per_exp for m in e["matches"] if m["class"] == "confirmed"}):
            eps = _epochs_for(per_exp, sid, require_class=("confirmed",))
            if len(eps) >= 6:
                var_stars.append(([e["lam"] for e in eps], [e["flux"] for e in eps], [e["flux_err"] for e in eps], [e["visit"] for e in eps]))
    floors = [x for x in floors if x is not None and np.isfinite(x)]
    params["sys_floor_arcsec"] = float(np.median(floors)) if floors else params["sys_floor_arcsec"]
    fcal = V.calibrate_floor(var_stars)
    if fcal.get("f_sys") is not None:
        params["f_sys"] = fcal["f_sys"]
    report["splits"]["calibration"] = {"fields": [f["id"] for f in cal], "astrometric_floor_arcsec": params["sys_floor_arcsec"],
                                       "photometric_floor": fcal}

    # 3. freeze
    frozen = {"params": params, "hash": config_hash(params), "frozen_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
              "note": "written before any holdout field was opened"}
    dump(frozen, out / "frozen_params.json")
    report["frozen_params"] = frozen
    log.info("FROZEN %s", frozen)

    # 4. holdout, evaluated once with frozen parameters
    hold = [f for f in fields if f["split"] == "holdout"]
    for i, f in enumerate(hold):
        fr, _, _ = do_field(f, params, True, 200 + i)
        report["fields"][f["id"]] = fr
    report["splits"]["holdout"] = {"fields": [f["id"] for f in hold], "params_hash": frozen["hash"]}

    # summaries
    psf_rows = [r for f in report["fields"].values() for r in f.pop("psf_rows", [])]
    report["psf_comparison"] = {"data": "real Gaia-confirmed stars in all fields", **psf_summary(psf_rows)}
    report["elapsed_s"] = round(time.time() - t_start, 1)
    dump(inputs, out / "inputs.json")
    dump(report, out / "report.json")
    PUBLIC_REPORT.parent.mkdir(parents=True, exist_ok=True)
    dump(compact(report), PUBLIC_REPORT)
    log.info("done in %.0f s → %s", time.time() - t_start, out)
    return out


def compact(report: dict) -> dict:
    """The report without bulky per-source tables, for the web page."""
    r = json.loads(json.dumps(_jsonable(report)))
    for f in r.get("fields", {}).values():
        if "variability" in f:
            f["variability"]["sources"] = [s for s in f["variability"]["sources"] if s.get("candidate_variable")][:20]
        if "sources" in f:
            f["sources"]["sources"] = [{k: s.get(k) for k in ("ra", "dec", "peak_snr", "class", "confidence", "reasons", "morphology")}
                                       for s in f["sources"]["sources"]][:25]
        if "motion" in f:
            f["motion"].pop("field_star_samples", None)
        if "astrometry" in f:
            f["astrometry"]["seeded_solve"]["failures"] = f["astrometry"]["seeded_solve"]["failures"][:5]
    return r
