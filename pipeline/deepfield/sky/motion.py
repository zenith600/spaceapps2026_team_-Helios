"""Measure how a source moves across a view: one position per visit, then a straight line.

The challenge's movers shift 1-2 SPHEREx pixels over the survey so far -- real, but easy to
miss by eye. This turns "watch closely" into a number with an error bar that can be checked
against Gaia:

1. Every exposure loses its own median background (the zodiacal light differs per frame).
2. The source is found near a prior position in a coadd of the exposures that see it
   (`min_wave_um` restricts that to long wavelengths for objects like WISE 0855, which is
   invisible below ~3 um).
3. Per visit, the exposures that see it are inverse-variance coadded and a 2-D Gaussian plus
   a flat background is fitted in a 7x7 box. SPHEREx under-samples its PSF (FWHM ~1.2 px), so
   a plain centroid is biased by where the star falls within a pixel; a fitted model is not.
4. x(t) and y(t) are fitted as straight lines, weighted by each visit's position error. When
   the scatter exceeds the errors, the errors are scaled up by sqrt(chi2/dof) rather than
   trusted.

Parallax (0.55" for Barnard's Star, < 0.1 px) is below what 6.15" pixels resolve here and is
not modelled; it adds a little scatter about the line.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np

#: Per-visit systematic floor, in pixels: reprojection, PSF changes between detectors.
POSITION_FLOOR_PX = 0.05
BOX = 3                       # half-width of the fitting box: 7x7 pixels
MIN_VISIT_SNR = 5.0           # a visit's coadd must detect the source this well to count
MIN_VISITS = 3
DAYS_PER_YEAR = 365.25


def _background_subtracted(flux: np.ndarray, good: np.ndarray) -> np.ndarray:
    out = np.array(flux, dtype=np.float64, copy=True)
    for i in range(out.shape[0]):
        ok = good[i] & np.isfinite(out[i])
        out[i] -= np.median(out[i][ok]) if ok.any() else 0.0
    return out


def _coadd(f: np.ndarray, v: np.ndarray, g: np.ndarray, sel: np.ndarray):
    """Inverse-variance mean image and its 1-sigma error image over the selected exposures."""
    ok = g[sel] & np.isfinite(f[sel]) & np.isfinite(v[sel]) & (v[sel] > 0)
    w = np.where(ok, 1.0 / np.where(v[sel] > 0, v[sel], 1.0), 0.0)
    s = w.sum(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        img = np.where(s > 0, (w * np.nan_to_num(f[sel])).sum(axis=0) / np.where(s > 0, s, 1.0), np.nan)
        err = np.where(s > 0, 1.0 / np.sqrt(np.where(s > 0, s, 1.0)), np.nan)
    return img, err


def fit_position(img: np.ndarray, err: np.ndarray, x0: float, y0: float, box: int = BOX) -> dict | None:
    """Gaussian + background fit around (x0, y0). Coordinates are array indices, y up."""
    from scipy.optimize import least_squares

    ny, nx = img.shape
    xi, yi = int(round(x0)), int(round(y0))
    ys, xs = slice(max(yi - box, 0), min(yi + box + 1, ny)), slice(max(xi - box, 0), min(xi + box + 1, nx))
    d, e = img[ys, xs], err[ys, xs]
    Y, X = np.mgrid[ys, xs]
    ok = np.isfinite(d) & np.isfinite(e) & (e > 0)
    if ok.sum() < 12:
        return None
    X, Y, d, e = X[ok].astype(float), Y[ok].astype(float), d[ok], e[ok]
    amp0 = float(max(d.max() - np.median(d), 1e-12))

    def model(p):
        a, xc, yc, s, b = p
        return a * np.exp(-((X - xc) ** 2 + (Y - yc) ** 2) / (2 * s * s)) + b

    try:
        r = least_squares(lambda p: (model(p) - d) / e, [amp0, x0, y0, 0.8, float(np.median(d))],
                          bounds=([0, x0 - box, y0 - box, 0.35, -np.inf], [np.inf, x0 + box, y0 + box, 2.5, np.inf]))
    except Exception:
        return None
    if not r.success:
        return None
    a, xc, yc, s, b = r.x
    dof = max(len(d) - 5, 1)
    chi2 = float((r.fun ** 2).sum())
    try:
        cov = np.linalg.inv(r.jac.T @ r.jac) * max(chi2 / dof, 1.0)
    except np.linalg.LinAlgError:
        return None
    ex, ey = math.sqrt(max(cov[1, 1], 0)), math.sqrt(max(cov[2, 2], 0))
    ea = math.sqrt(max(cov[0, 0], 0))
    snr = a / ea if ea > 0 else 0.0
    # A fit pinned to the edge of its box found a neighbour or nothing, not the source.
    if abs(xc - x0) > box - 0.5 or abs(yc - y0) > box - 0.5:
        return None
    return {"x": float(xc), "y": float(yc), "ex": ex, "ey": ey, "sigma_px": float(s),
            "amp": float(a), "snr": float(snr), "chi2_per_dof": chi2 / dof}


def _weighted_line(t: np.ndarray, v: np.ndarray, ev: np.ndarray):
    """v = c + m t, weighted. Returns (c, m, err_c, err_m, chi2, dof), errors scaled when chi2/dof > 1."""
    w = 1.0 / ev ** 2
    A = np.vstack([np.ones_like(t), t]).T
    cov = np.linalg.inv(A.T @ (A * w[:, None]))
    c, m = cov @ (A.T @ (w * v))
    chi2 = float((w * (v - (c + m * t)) ** 2).sum())
    dof = max(len(t) - 2, 1)
    scale = max(chi2 / dof, 1.0)
    return float(c), float(m), math.sqrt(cov[0, 0] * scale), math.sqrt(cov[1, 1] * scale), chi2, dof


def find_source(img: np.ndarray, err: np.ndarray, x0: float, y0: float, radius: float) -> tuple[float, float, float] | None:
    """Highest-SNR pixel within `radius` of the prior. Returns (x, y, snr)."""
    snr = img / err
    ny, nx = snr.shape
    Y, X = np.mgrid[0:ny, 0:nx]
    inside = ((X - x0) ** 2 + (Y - y0) ** 2 <= radius ** 2) & np.isfinite(snr)
    inside &= (X >= BOX) & (X < nx - BOX) & (Y >= BOX) & (Y < ny - BOX)
    if not inside.any():
        return None
    k = np.nanargmax(np.where(inside, snr, -np.inf))
    y, x = np.unravel_index(k, snr.shape)
    return float(x), float(y), float(snr[y, x])


def find_red_source(flux, var, good, wave, *, red_um: float = 3.8, blue_um: float = 2.5,
                    min_red_snr: float = 6.0, max_blue_snr: float = 3.0) -> tuple[float, float, float] | None:
    """The brightest source that is detected beyond `red_um` and absent below `blue_um`.

    That colour is the signature of the coldest brown dwarfs: methane and water absorb almost
    all their light at short wavelengths, while they glow near 4.5 um. Used to locate WISE
    0855, whose position in the brief is 15 years old.
    """
    f = _background_subtracted(flux, good)
    red, ered = _coadd(f, var, good, wave >= red_um)
    blue, eblue = _coadd(f, var, good, wave < blue_um)
    sr, sb = red / ered, blue / eblue
    cand = np.isfinite(sr) & (sr >= min_red_snr) & ~(np.nan_to_num(sb, nan=0.0) > max_blue_snr)
    ny, nx = sr.shape
    Y, X = np.mgrid[0:ny, 0:nx]
    cand &= (X >= BOX) & (X < nx - BOX) & (Y >= BOX) & (Y < ny - BOX)
    if not cand.any():
        return None
    k = np.nanargmax(np.where(cand, sr, -np.inf))
    y, x = np.unravel_index(k, sr.shape)
    return float(x), float(y), float(sr[y, x])


def measure_motion(bundle_dir: Path | str, x0: float | None = None, y0: float | None = None, *,
                   search_px: float = 4.0, min_wave_um: float | None = None,
                   reference: dict | None = None, prior_note: str = "") -> dict:
    """Per-visit positions and a proper-motion fit for the source near (x0, y0).

    `reference` is an independent measurement to compare with, e.g. Gaia DR3:
    {"pmra_mas", "pmdec_mas", "source"}. Returns a JSON-ready dict; never raises for data
    reasons -- it explains instead.
    """
    import json

    d = Path(bundle_dir)
    meta = json.loads((d / "sky.json").read_text())
    with np.load(d / "cube.npz", allow_pickle=True) as z:
        flux, var, good = z["flux"], z["var"], np.asarray(z["good"], bool)
        mjd, visit, wave = np.asarray(z["mjd"], float), np.asarray(z["visit"]), np.asarray(z["wave_um"], float)
    n, ny, nx = flux.shape
    if x0 is None or y0 is None:
        x0, y0 = (nx - 1) / 2, (ny - 1) / 2
    cd1, cd2 = (meta.get("wcs") or {}).get("cdelt", [-meta["pixel_arcsec"] / 3600, meta["pixel_arcsec"] / 3600])
    out: dict = {"slug": meta["slug"], "available": False, "prior": {"x": x0, "y": y0, "note": prior_note},
                 "min_wave_um": min_wave_um, "pixel_arcsec": meta["pixel_arcsec"], "reference": reference,
                 "method": __doc__.split("\n\n")[1].strip().replace("\n", " ") if __doc__ else ""}

    f = _background_subtracted(flux, good)
    use = np.ones(n, bool) if min_wave_um is None else (wave >= min_wave_um)
    stack, estack = _coadd(f, var, good, use)
    hit = find_source(stack, estack, x0, y0, search_px)
    if hit is None or hit[2] < MIN_VISIT_SNR:
        out["reason"] = f"no source detected within {search_px:g} px of the prior position"
        return out
    sx, sy, ssnr = hit
    out["located"] = {"x": sx, "y": sy, "snr": round(ssnr, 1)}

    visits = []
    for v in sorted(set(visit.tolist())):
        sel = (visit == v) & use
        if not sel.any():
            continue
        img, err = _coadd(f, var, good, sel)
        p = fit_position(img, err, sx, sy)
        if p is None or p["snr"] < MIN_VISIT_SNR:
            continue
        visits.append({"visit": int(v), "mjd": float(np.mean(mjd[sel])), "n_exposures": int(sel.sum()),
                       "x": round(p["x"], 4), "y": round(p["y"], 4),
                       "ex": round(math.hypot(p["ex"], POSITION_FLOOR_PX), 4),
                       "ey": round(math.hypot(p["ey"], POSITION_FLOOR_PX), 4),
                       "snr": round(p["snr"], 1), "sigma_px": round(p["sigma_px"], 3)})
    out["visits"] = visits
    span = (max(p["mjd"] for p in visits) - min(p["mjd"] for p in visits)) if visits else 0.0
    if len(visits) < MIN_VISITS or span < 60:
        if not visits:
            out["reason"] = ("the source is found, but no single visit gives a usable position — usually "
                             "because its core saturates the detector and those pixels are flagged")
        else:
            out["reason"] = (f"only {len(visits)} visit(s) give a usable position "
                             f"(need {MIN_VISITS} spanning at least two months)")
        return out

    t_ref = float(np.mean([p["mjd"] for p in visits]))
    t = np.array([(p["mjd"] - t_ref) / DAYS_PER_YEAR for p in visits])
    xs, ys = np.array([p["x"] for p in visits]), np.array([p["y"] for p in visits])
    exs, eys = np.array([p["ex"] for p in visits]), np.array([p["ey"] for p in visits])
    cx, vx, ecx, evx, chix, dofx = _weighted_line(t, xs, exs)
    cy, vy, ecy, evy, chiy, dofy = _weighted_line(t, ys, eys)

    # Pixels -> sky through the grid's own scale. cdelt1 < 0: +x is west, so RA* = vx * cdelt1.
    k1, k2 = cd1 * 3600.0, cd2 * 3600.0
    pmra, pmdec = vx * k1, vy * k2
    epmra, epmdec = abs(evx * k1), abs(evy * k2)
    pm = math.hypot(pmra, pmdec)
    epm = math.sqrt((pmra * epmra) ** 2 + (pmdec * epmdec) ** 2) / pm if pm > 0 else math.hypot(epmra, epmdec)
    pa = (math.degrees(math.atan2(pmra, pmdec)) + 360.0) % 360.0
    out.update({
        "available": True,
        "t_ref_mjd": t_ref,
        "fit": {"x0": cx, "y0": cy, "vx_px_per_yr": vx, "vy_px_per_yr": vy,
                "ex0": ecx, "ey0": ecy, "evx": evx, "evy": evy,
                "chi2_x": round(chix, 2), "chi2_y": round(chiy, 2), "dof": dofx},
        "pm": {"pmra_arcsec_yr": round(pmra, 3), "pmdec_arcsec_yr": round(pmdec, 3),
               "err_pmra": round(epmra, 3), "err_pmdec": round(epmdec, 3),
               "total_arcsec_yr": round(pm, 3), "err_total": round(epm, 3), "pa_deg": round(pa, 1)},
        "baseline_days": round(span, 1),
        "shift_px": round(math.hypot(vx, vy) * span / DAYS_PER_YEAR, 2),
    })
    out["caveat"] = ("A straight-line fit to one position per visit. Parallax is not modelled, and a "
                     "blended neighbour can pull a position; the error bars come from the fit and are "
                     "scaled up when the visits scatter more than they predict.")
    return attach_reference(out, reference)


def attach_reference(out: dict, reference: dict | None) -> dict:
    """Compare a fitted motion with an independent one (Gaia DR3), in units of our own error."""
    out["reference"] = reference
    out.pop("comparison", None)
    if not out.get("available") or not reference or reference.get("pmra_mas") is None:
        return out
    pm = out["pm"]
    rra, rdec = reference["pmra_mas"] / 1000.0, reference["pmdec_mas"] / 1000.0
    dra, ddec = pm["pmra_arcsec_yr"] - rra, pm["pmdec_arcsec_yr"] - rdec
    # Gaia's errors are ~1000x smaller than ours, so ours set the scale.
    nsig = math.hypot(dra / max(pm["err_pmra"], 1e-6), ddec / max(pm["err_pmdec"], 1e-6)) / math.sqrt(2)
    out["comparison"] = {"total_arcsec_yr": round(math.hypot(rra, rdec), 3),
                         "pmra_arcsec_yr": round(rra, 3), "pmdec_arcsec_yr": round(rdec, 3),
                         "pa_deg": round((math.degrees(math.atan2(rra, rdec)) + 360) % 360, 1),
                         "diff_pmra": round(dra, 3), "diff_pmdec": round(ddec, 3),
                         "n_sigma": round(nsig, 2), "agrees": bool(nsig < 3.0)}
    return out


def motion_for_bundle(bundle_dir: Path | str, x: float | None = None, y: float | None = None,
                      *, min_wave_um: float | None = None) -> dict:
    """Measure motion for a view, with a Gaia DR3 comparison when one matches.

    With no position given, measures the source at the view centre -- the target, for any
    view built from a name or from coordinates the user typed.
    """
    import json

    from deepfield.sky.resolver import known

    d = Path(bundle_dir)
    meta = json.loads((d / "sky.json").read_text())
    tgt = meta.get("target") or {}
    entry = known(tgt.get("slug", "")) if tgt.get("resolver") == "builtin" else None
    if x is None and entry is not None and not entry.centre_is_target:
        return {"slug": meta["slug"], "available": False, "pixel_arcsec": meta["pixel_arcsec"], "min_wave_um": None,
                "prior": {"x": None, "y": None, "note": "not measured"},
                "target": {"name": entry.name, "epoch_note": entry.epoch_note},
                "reason": (f"{entry.name} is not at the centre of this view, so the source there is not it. "
                           f"{entry.look_for}")}
    note = "the view centre" if x is None else "a position you chose"
    out = measure_motion(d, x, y, search_px=4.0 if x is None else 2.0, min_wave_um=min_wave_um, prior_note=note)
    out["target"] = {"name": tgt.get("name"), "epoch_note": tgt.get("epoch_note", "")}
    if out.get("available"):
        try:
            ref = gaia_reference(meta, out["fit"]["x0"], out["fit"]["y0"], out["t_ref_mjd"])
        except Exception:
            ref = None
        attach_reference(out, ref)
    return out


def write_motion(bundle_dir: Path | str) -> dict:
    import json

    out = motion_for_bundle(bundle_dir)
    (Path(bundle_dir) / "motion.json").write_text(json.dumps(out, indent=1, default=float))
    return out


def gaia_reference(meta: dict, x: float, y: float, mjd: float, *, max_px: float = 2.5) -> dict | None:
    """The Gaia DR3 source whose position carried to `mjd` lands within `max_px` of (x, y)."""
    from astropy.wcs import WCS

    from deepfield.sky.catalogs import cone_search
    from deepfield.sky.resolver import GAIA_DR3_EPOCH_MJD

    df = cone_search("gaia", float(meta["ra_deg"]), float(meta["dec_deg"]), float(meta["fov_deg"]) * 0.75)
    if not len(df) or "pmra" not in df:
        return None
    df = df.dropna(subset=["pmra", "pmdec"])
    w = WCS(naxis=2)
    for k in ("ctype", "crval", "crpix", "cdelt"):
        setattr(w.wcs, k, meta["wcs"][k])
    dt = (mjd - GAIA_DR3_EPOCH_MJD) / DAYS_PER_YEAR
    dec = df["dec"].to_numpy(float) + df["pmdec"].to_numpy(float) * dt / 3.6e6
    ra = df["ra"].to_numpy(float) + df["pmra"].to_numpy(float) * dt / 3.6e6 / np.cos(np.radians(df["dec"].to_numpy(float)))
    px, py = w.all_world2pix(ra, dec, 0)
    dist = np.hypot(px - x, py - y)
    if not np.isfinite(dist).any() or np.nanmin(dist) > max_px:
        return None
    k = int(np.nanargmin(dist))
    r = df.iloc[k]
    return {"pmra_mas": float(r["pmra"]), "pmdec_mas": float(r["pmdec"]), "g_mag": float(r["mag"]),
            "parallax_mas": float(r["parallax"]) if np.isfinite(r.get("parallax", np.nan)) else None,
            "separation_px": round(float(dist[k]), 2), "source": "Gaia DR3 (gaiadr3.gaia_source)"}
