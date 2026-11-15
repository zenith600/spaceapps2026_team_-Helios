"""Validate the official SPHEREx WCS against Gaia DR3, and check it with an independent solve.

Two separate things, kept separate in every output:

1. **Official-WCS validation.** Detected stars are fitted with the instrument ePSF, mapped to
   the sky through the *published* TAN-SIP WCS, and compared with Gaia DR3 positions carried
   to the exposure's own time and observer (ERFA `pmpx`, spacecraft position). Associations
   are classified with a covariance-aware D² (see `classify_matches`). Residual statistics,
   systematic offsets and spatial trends are reported; the official WCS is never modified.

2. **Independent seeded plate solve.** Using only the requested pointing (the field centre) and
   the nominal 6.15″ pixel scale as a seed, rotation, parity and translation are found by
   voting over all detection–Gaia pixel offsets, then a TAN WCS is fitted to the matched pairs
   (`astropy.wcs.utils.fit_wcs_from_points`). It is validated by count, uniqueness and
   out-of-sample (5-fold) residuals, and only then compared with the official WCS.

Limits: this is a *seeded* solve over a small cutout (≈ 8′), not a blind all-sky solve like
Astrometry.net (which the SPHEREx pipeline itself runs on the full detector: ASTRONETSOLVED).
A TAN-only fit cannot model SIP distortion; over a cutout it is absorbed locally and the
comparison quantifies how much that costs.
"""
from __future__ import annotations

import math

import numpy as np

from deepfield.astro import astrometry as A
from deepfield.astro import stats as S
from deepfield.astro.catalog import gaia_reference_mask
from deepfield.astro.psf import EPSFModel, find_sources, fit_epsf

#: D² below which a catalogue source is a statistically acceptable counterpart (χ²₂, p = 0.003).
MATCH_D2 = S.chi2_ppf(0.9973, 2)
#: Search radius for candidate counterparts (native pixels).
SEARCH_PX = 2.0
#: Brighter-neighbour criterion for "isolated": no Gaia source within this radius (arcsec)
#: brighter than G_candidate + BLEND_DMAG.
BLEND_RADIUS_ARCSEC = 12.0
BLEND_DMAG = 2.5
NOMINAL_SCALE = 6.15


# ----------------------------------------------------------------------------- predictions
def predict_catalog(ex, gaia_df) -> list[dict]:
    """Gaia stars propagated to this exposure (time + observer), with pixel positions."""
    pob = A.observer_bcrs_au(ex.mjd, ex.sc_geocentric_km)
    ref = gaia_reference_mask(gaia_df) if len(gaia_df) else np.zeros(0, bool)
    ny, nx = ex.shape
    out = []
    for i, (_, r) in enumerate(gaia_df.iterrows()):
        has_pm = np.isfinite(r.get("pmra", np.nan)) and np.isfinite(r.get("pmdec", np.nan))
        star = A.CatalogStar.from_gaia_row(r) if has_pm else A.CatalogStar(
            str(r["source_id"]), float(r["ra"]), float(r["dec"]), A.GAIA_DR3_EPOCH_MJD, cov5=A.gaia_cov5(r))
        if not has_pm:
            # 2-parameter solution: position only; Gaia's error is at its epoch and grows with
            # unknown motion, so add a generous 10 mas/yr per axis of motion uncertainty.
            c = star.cov5.copy()
            c[3, 3] = c[4, 4] = 10.0 ** 2
            star.cov5 = c
        p = A.propagate(star, ex.mjd, pob)
        x, y = ex.wcs.all_world2pix([[p["ra"], p["dec"]]], 0)[0]
        if not (-2 <= x <= nx + 1 and -2 <= y <= ny + 1):
            continue
        out.append({"source_id": str(r["source_id"]), "ra": p["ra"], "dec": p["dec"], "cov": p["cov"],
                    "x": float(x), "y": float(y), "g": float(r.get("phot_g_mean_mag", np.nan)),
                    "reference_quality": bool(ref[i]), "has_pm": bool(has_pm),
                    "galaxy_prob": float(r.get("classprob_dsc_combmod_galaxy", np.nan)) if "classprob_dsc_combmod_galaxy" in r else None})
    return out


# ----------------------------------------------------------------------------- measurement
def measure_sources(ex, nsigma: float = 5.0, inflate: bool = True) -> list[dict]:
    """Detect and ePSF-fit every source; sky position and sky covariance via the official WCS."""
    det = find_sources(ex.image, ex.variance, ex.bad, fwhm_px=ex.psf_fwhm_arcsec / NOMINAL_SCALE, nsigma=nsigma)
    out = []
    for s in det:
        m = EPSFModel(ex.epsf_at(s["x"], s["y"]), ex.oversample)
        f = fit_epsf(ex.image, ex.variance, ex.bad, s["x"], s["y"], m)
        if f is None or f["pinned"]:
            continue
        xi, yi = int(round(f["x"])), int(round(f["y"]))
        y0, y1, x0, x1 = max(yi - 1, 0), yi + 2, max(xi - 1, 0), xi + 2
        sat = bool(ex.saturated[y0:y1, x0:x1].any())
        cov_px = np.asarray(f["cov_px"])
        if inflate:
            cov_px = cov_px * max(1.0, f["chi2_dof"])
        ra, dec = ex.wcs.all_pix2world([[f["x"], f["y"]]], 0)[0]
        out.append({**f, "det_snr": s["snr"], "ra": float(ra), "dec": float(dec), "saturated": sat,
                    "cov_sky": A.pixel_cov_to_sky(ex.wcs, f["x"], f["y"], cov_px),
                    "cov_sky_raw": A.pixel_cov_to_sky(ex.wcs, f["x"], f["y"], np.asarray(f["cov_px"]))})
    return out


# ----------------------------------------------------------------------------- association
def classify_matches(meas: list[dict], pred: list[dict], sys_floor_arcsec: float, pixel_scale: float = NOMINAL_SCALE) -> list[dict]:
    """Associate each measured source with catalogue predictions.

    For each candidate within SEARCH_PX: Δ = measured − predicted (tangent plane, arcsec),
    C = C_measured + C_catalogue + σ_sys²·I, D² = Δᵀ C⁻¹ Δ.

    - **confirmed**: exactly one candidate with D² < MATCH_D2, it passes the Gaia reference
      quality filter, and it is isolated (no Gaia source within BLEND_RADIUS brighter than
      G + BLEND_DMAG other than itself);
    - **probable**: exactly one acceptable candidate, but it fails quality or isolation;
    - **ambiguous**: two or more acceptable candidates;
    - **none**: no acceptable candidate (a non-Gaia source, a galaxy, an artefact, or a mover).
    """
    px = np.array([[p["x"], p["y"]] for p in pred]) if pred else np.zeros((0, 2))
    gmag = np.array([p["g"] for p in pred]) if pred else np.zeros(0)
    pra = np.array([p["ra"] for p in pred]) if pred else np.zeros(0)
    pdec = np.array([p["dec"] for p in pred]) if pred else np.zeros(0)
    out = []
    for m in meas:
        if len(px) == 0:
            out.append({**m, "class": "none", "candidates": 0})
            continue
        d = np.hypot(px[:, 0] - m["x"], px[:, 1] - m["y"])
        cand = np.nonzero(d < SEARCH_PX)[0]
        acc = []
        for j in cand:
            xi, eta = A.tangent_offsets_arcsec(m["ra"], m["dec"], pred[j]["ra"], pred[j]["dec"])
            C = np.asarray(m["cov_sky"]) + np.asarray(pred[j]["cov"]) + np.eye(2) * sys_floor_arcsec ** 2
            d2 = float(S.mahalanobis2([xi, eta], C))
            if d2 < MATCH_D2:
                acc.append((d2, j, float(xi), float(eta), C))
        if not acc:
            out.append({**m, "class": "none", "candidates": int(len(cand))})
            continue
        # The counterpart is the brightest statistically acceptable candidate; a second acceptable
        # candidate only makes the association ambiguous if it is comparably bright (within
        # BLEND_DMAG), since a source many magnitudes fainter cannot be what SPHEREx detected.
        acc.sort(key=lambda a: (gmag[a[1]] if np.isfinite(gmag[a[1]]) else 99.0, a[0]))
        d2, j, xi, eta, C = acc[0]
        rivals = [a for a in acc[1:] if not np.isfinite(gmag[a[1]]) or gmag[a[1]] < pred[j]["g"] + BLEND_DMAG]
        sep = A.angular_sep_arcsec(pra, pdec, pred[j]["ra"], pred[j]["dec"])
        brighter = (sep < BLEND_RADIUS_ARCSEC) & (sep > 0.01) & (gmag < pred[j]["g"] + BLEND_DMAG)
        isolated = not bool(brighter.any())
        if rivals:
            cls = "ambiguous"
        elif pred[j]["reference_quality"] and isolated and not m["saturated"]:
            cls = "confirmed"
        else:
            cls = "probable"
        out.append({**m, "class": cls, "candidates": int(len(cand)), "match": pred[j]["source_id"], "match_g": pred[j]["g"],
                    "d2": d2, "dxi": xi, "deta": eta, "cov_total": C.tolist(), "isolated": isolated,
                    "cat_cov": np.asarray(pred[j]["cov"]).tolist()})
    return out


def required_floor(matches: list[dict], target_median: float = S.chi2_ppf(0.5, 2)) -> float:
    """Systematic floor σ_sys (arcsec) that makes the median D² of confirmed matches equal the χ²₂ median.
    0 if the formal errors alone already over-cover."""
    conf = [m for m in matches if m["class"] == "confirmed"]
    if len(conf) < 5:
        return float("nan")
    D = np.array([[m["dxi"], m["deta"]] for m in conf])
    C0 = np.array([np.asarray(m["cov_sky"]) + np.asarray(m["cat_cov"]) for m in conf])

    def med(s):
        return float(np.median(S.mahalanobis2(D, C0 + np.eye(2) * s * s)))
    if med(0.0) <= target_median:
        return 0.0
    lo, hi = 0.0, 10.0
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        lo, hi = (mid, hi) if med(mid) > target_median else (lo, mid)
    return 0.5 * (lo + hi)


# ----------------------------------------------------------------------------- independent solve
def solve_seeded(ex, meas: list[dict], gaia_df, seed_ra: float, seed_dec: float, *, scale: float = NOMINAL_SCALE,
                 search_px: float = 25.0, max_ref: int = 60, max_det: int = 40, min_snr: float = 10.0) -> dict:
    """Plate-solve the cutout from detections + Gaia, seeded only by pointing and nominal scale.

    Voting uses only the brightest detections and the brightest catalogue stars (standard
    practice): with every faint source, chance coincidences in crowded fields swamp the peak.
    """
    from astropy.coordinates import SkyCoord
    from astropy.wcs.utils import fit_wcs_from_points
    import astropy.units as u

    ny, nx = ex.shape
    cx, cy = (nx - 1) / 2, (ny - 1) / 2
    usable = sorted([m for m in meas if m["snr"] >= min_snr and not m["saturated"]], key=lambda m: -m["snr"])[:max_det]
    det = np.array([[m["x"], m["y"]] for m in usable])
    if len(det) < 6 or len(gaia_df) == 0:
        return {"status": "insufficient", "reason": f"{len(det)} usable detections", "passed": False}
    pob = A.observer_bcrs_au(ex.mjd, ex.sc_geocentric_km)
    g = gaia_df.copy()
    g = g[np.isfinite(g["phot_g_mean_mag"])].sort_values("phot_g_mean_mag").head(max_ref * 3)
    ras, decs = [], []
    for _, r in g.iterrows():                     # epoch-propagate (no covariance needed for voting)
        if np.isfinite(r.get("pmra", np.nan)):
            s = A.CatalogStar.from_gaia_row(r)
            s.cov5 = None
            p = A.propagate(s, ex.mjd, pob)
            ras.append(p["ra"]); decs.append(p["dec"])
        else:
            ras.append(float(r["ra"])); decs.append(float(r["dec"]))
    ras, decs = np.array(ras), np.array(decs)
    xi, eta = A.tangent_offsets_arcsec(ras, decs, seed_ra, seed_dec)
    keep = np.hypot(xi, eta) < (max(nx, ny) * scale * 0.6 + search_px * scale)
    xi, eta, ras, decs = xi[keep][:max_ref], eta[keep][:max_ref], ras[keep][:max_ref], decs[keep][:max_ref]
    all_ra, all_dec = ras, decs
    sky = np.stack([xi, eta], 1) / scale
    best = (0, None)
    scores = []
    for parity in (1, -1):
        for th in np.arange(0.0, 360.0, 0.5):
            t = math.radians(th)
            M = np.array([[math.cos(t), -math.sin(t)], [math.sin(t), math.cos(t)]]) @ np.diag([parity, 1.0])
            gp = sky @ np.linalg.inv(M).T + [cx, cy]                 # catalogue → pixel under this hypothesis
            diff = (det[:, None, :] - gp[None, :, :]).reshape(-1, 2)
            diff = diff[(np.abs(diff) < search_px).all(1)]
            if len(diff) == 0:
                scores.append((0, th, parity, 0.0, 0.0)); continue
            H, xe, ye = np.histogram2d(diff[:, 0], diff[:, 1], bins=int(2 * search_px), range=[[-search_px, search_px]] * 2)
            k = np.unravel_index(int(np.argmax(H)), H.shape)
            sx, sy = (xe[k[0]] + xe[k[0] + 1]) / 2, (ye[k[1]] + ye[k[1] + 1]) / 2
            near = diff[(np.abs(diff[:, 0] - sx) < 1.5) & (np.abs(diff[:, 1] - sy) < 1.5)]
            sx, sy = (near.mean(0) if len(near) else (sx, sy))
            sc = int(np.sum(np.hypot(diff[:, 0] - sx, diff[:, 1] - sy) < 1.2))
            scores.append((sc, th, parity, float(sx), float(sy)))
            if sc > best[0]:
                best = (sc, (th, parity, float(sx), float(sy), M))
    if best[1] is None or best[0] < 4:
        return {"status": "no_solution", "votes": int(best[0]), "passed": False}
    th, parity, sx, sy, M = best[1]
    rivals = [s[0] for s in scores if (s[2] != parity) or (min(abs(s[1] - th), 360 - abs(s[1] - th)) > 5.0)]
    second = max(rivals) if rivals else 0
    gp = sky @ np.linalg.inv(M).T + [cx + sx, cy + sy]

    def pairs(pred_xy, tol):
        out = []
        for i, d in enumerate(det):
            dd = np.hypot(pred_xy[:, 0] - d[0], pred_xy[:, 1] - d[1])
            j = int(np.argmin(dd))
            if dd[j] < tol:
                dd2 = np.hypot(det[:, 0] - pred_xy[j, 0], det[:, 1] - pred_xy[j, 1])
                if int(np.argmin(dd2)) == i:                         # mutual nearest neighbours
                    out.append((i, j))
        return out

    pr = pairs(gp, 1.5)
    wcs_fit = None
    for _ in range(3):
        if len(pr) < 6:
            break
        xy = det[[i for i, _ in pr]].T
        sc_ = SkyCoord(ras[[j for _, j in pr]] * u.deg, decs[[j for _, j in pr]] * u.deg)
        wcs_fit = fit_wcs_from_points(xy, sc_, proj_point="center", projection="TAN")
        pxy = np.array(wcs_fit.all_world2pix(np.stack([ras, decs], 1), 0))
        pr = pairs(pxy, 1.0)
    if wcs_fit is None or len(pr) < 6:
        return {"status": "no_solution", "votes": int(best[0]), "matched": len(pr), "passed": False}

    # 5-fold out-of-sample residuals
    rng = np.random.default_rng(12345)
    idx = rng.permutation(len(pr))
    folds = np.array_split(idx, 5)
    oos = []
    for f in folds:
        train = [pr[k] for k in idx if k not in set(f)]
        if len(train) < 4 or len(f) == 0:
            continue
        w = fit_wcs_from_points(det[[i for i, _ in train]].T,
                                SkyCoord(ras[[j for _, j in train]] * u.deg, decs[[j for _, j in train]] * u.deg),
                                proj_point="center", projection="TAN")
        for k in f:
            i, j = pr[k]
            px_, py_ = w.all_world2pix([[ras[j], decs[j]]], 0)[0]
            oos.append(math.hypot(px_ - det[i, 0], py_ - det[i, 1]))
    ins = []
    for i, j in pr:
        px_, py_ = wcs_fit.all_world2pix([[ras[j], decs[j]]], 0)[0]
        ins.append(math.hypot(px_ - det[i, 0], py_ - det[i, 1]))
    geom = A.wcs_scale_rotation(wcs_fit, cx, cy)
    off = A.wcs_scale_rotation(ex.wcs, cx, cy)
    grid = np.array([[0, 0], [nx - 1, 0], [0, ny - 1], [nx - 1, ny - 1], [cx, cy]], float)
    a = ex.wcs.all_pix2world(grid, 0)
    b = wcs_fit.all_pix2world(grid, 0)
    sep = A.angular_sep_arcsec(a[:, 0], a[:, 1], b[:, 0], b[:, 1])
    oos_rms = float(np.sqrt(np.mean(np.square(oos)))) if oos else float("nan")
    checks = {
        "enough_matches": len(pr) >= 6,
        "unambiguous": best[0] >= 2 * max(second, 1),
        "out_of_sample_rms_below_0.35px": bool(np.isfinite(oos_rms) and oos_rms <= 0.35),
        "scale_within_2pct_of_nominal": abs(geom["scale"] / scale - 1) <= 0.02,
    }
    return {
        "status": "solved", "passed": all(checks.values()), "checks": checks,
        "votes_best": int(best[0]), "votes_second": int(second), "matched": len(pr),
        "rms_in_sample_px": float(np.sqrt(np.mean(np.square(ins)))), "rms_out_of_sample_px": oos_rms,
        "scale_arcsec": geom["scale"], "rotation_deg": geom["rotation_deg"], "parity": geom["parity"],
        "official": {"scale_arcsec": off["scale"], "rotation_deg": off["rotation_deg"], "parity": off["parity"]},
        "vs_official": {"centre_sep_arcsec": float(sep[-1]), "max_sep_arcsec": float(sep.max()),
                        "scale_ratio": geom["scale"] / off["scale"],
                        "rotation_diff_deg": float(((geom["rotation_deg"] - off["rotation_deg"] + 180) % 360) - 180),
                        "parity_agrees": geom["parity"] == off["parity"]},
        "crval": [float(v) for v in wcs_fit.wcs.crval], "cd": wcs_fit.wcs.cd.tolist() if wcs_fit.wcs.has_cd() else
        (wcs_fit.wcs.pc * wcs_fit.wcs.cdelt[:, None]).tolist(),
    }


# ----------------------------------------------------------------------------- per exposure
def validate_exposure(ex, gaia_df, *, sys_floor_arcsec: float = 0.3, seed=None) -> dict:
    meas = measure_sources(ex)
    pred = predict_catalog(ex, gaia_df)
    matches = classify_matches(meas, pred, sys_floor_arcsec)
    counts = {c: sum(m["class"] == c for m in matches) for c in ("confirmed", "probable", "ambiguous", "none")}
    eligible = sum(1 for p in pred if p["reference_quality"] and 0 <= p["x"] < ex.shape[1] and 0 <= p["y"] < ex.shape[0])
    solve = solve_seeded(ex, meas, gaia_df, *seed) if seed is not None else None
    return {"obs_id": ex.obs_id, "detector": ex.detector, "mjd": ex.mjd, "shape": list(ex.shape),
            "n_detected": len(meas), "n_catalog_in_frame": len(pred), "n_reference_in_frame": eligible,
            "counts": counts, "matches": matches, "solve": solve, "provenance": ex.provenance}
