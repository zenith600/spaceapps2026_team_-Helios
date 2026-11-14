"""Two things the viewer can tell a user about a field, computed from the data it already has.

`change_map` answers "where did anything happen here?" without a trained model at all: it
is a per-pixel chi-squared of the visit-to-visit flux against the measured noise. A star
that sits still at constant brightness scores ~1; something that moves or varies scores
high. That is transparent, needs no training set, and cannot hallucinate.

`classify_point` answers "what kind of thing is this?" from the spectrum, by scoring the
same three templates the Planet X search uses (reflected sunlight with methane absorption,
plain reflected sunlight, stellar blackbody) and adding a blackbody temperature fit. No
pretrained weights are involved anywhere, which keeps the project rule intact.

Both are deliberately boring methods, stated plainly in the UI. An interpretable number a
user can argue with beats a confident score they cannot.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from deepfield.spectral.templates import fit_templates, planck_nu

#: Robust z (relative to this field's own chi2/dof distribution) above which a pixel is
#: "something changed here". Self-calibrated, see change_map.
CHANGE_THRESHOLD = float(5.0)

#: Fractional systematic floor added to each exposure's variance. Covers cross-detector
#: calibration and reprojection effects the Level 2 variance plane does not include.
CHANGE_SYS_FLOOR = 0.05

#: Brightness is modelled as a polynomial in wavelength of this degree. Quadratic follows
#: a star's spectral slope and curvature across 0.75-5 um without having freedom to absorb
#: a genuine jump between visits.
CHANGE_POLY_DEG = 2

#: Best-template chi2/dof above this means none of our shapes explain the spectrum.
UNEXPLAINED_CHI2 = float(5.0)

#: Fractional systematic error added to each spectral point before template fitting.
#: The templates are illustrative, not radiative-transfer models; 10% is the honest scale
#: of how far a real source can sit from them and still be "that kind of thing".
CLASSIFY_SYS_FLOOR = 0.10


def change_map(flux: np.ndarray, var: np.ndarray, good: np.ndarray,
               wave_um: np.ndarray | None = None, *, deg: int = CHANGE_POLY_DEG,
               floor: float = CHANGE_SYS_FLOOR) -> dict:
    """Where does the brightness change in a way its colour cannot explain?

    The naive model -- "this pixel has one constant brightness" -- is wrong for SPHEREx and
    was the first version shipped. Every exposure sees a different wavelength, so a star's
    brightness legitimately differs from frame to frame because of its spectrum, and the
    zodiacal background shifts with time and band. On real data that model gave a median
    chi2/dof of 7-97 *across empty sky*, and flagged nearly every pixel: it detected colour
    and background, not change.

    What "nothing happened here" actually means is "brightness is a smooth function of
    wavelength, and does not depend on when you looked". So:

      1. remove each exposure's own robust background level (zodiacal light differs per
         frame; this alone took the median from 7.1 to 0.95 on Barnard's Star);
      2. per pixel, fit brightness as a low-order polynomial in wavelength, weighted by the
         variance plus a small systematic floor;
      3. chi2/dof of what the polynomial cannot explain;
      4. a robust z against *this field's own* chi2 distribution (median, MAD), because the
         Level 2 variance plane still underestimates the true scatter -- the same reason the
         shift-and-stack threshold is calibrated per patch.

    Checked on the baked targets: Barnard's Star (moving) z=17, RW Aurigae (variable)
    z=43, R Draconis (Mira) z=10, WISE 0855 z=5 -- each target flags at its own position.
    """
    f = np.array(flux, dtype=np.float64)
    v = np.asarray(var, dtype=np.float64)
    n_exp, ny, nx = f.shape
    ok = np.asarray(good, dtype=bool) & np.isfinite(f) & np.isfinite(v) & (v > 0)

    # 1. per-exposure background
    for i in range(n_exp):
        m = ok[i]
        if m.sum() > 20:
            f[i] -= np.median(f[i][m])

    # 2. weighted polynomial in wavelength, solved per pixel via the normal equations
    lam = (np.zeros(n_exp) if wave_um is None else np.asarray(wave_um, dtype=np.float64))
    lam = lam - (lam.mean() if lam.size else 0.0)          # centred: better conditioned
    k = deg + 1 if wave_um is not None else 1
    powers = np.stack([lam ** p for p in range(2 * k - 1)])           # (2k-1, n)

    v_eff = v + (floor * np.abs(np.nan_to_num(f))) ** 2
    w = np.where(ok, 1.0 / np.where(v_eff > 0, v_eff, np.inf), 0.0)    # (n, ny, nx)
    fw = np.where(ok, np.nan_to_num(f), 0.0) * w

    S = np.einsum("pn,nyx->pyx", powers, w)                           # sum w lam^p
    T = np.einsum("pn,nyx->pyx", powers[:k], fw)                      # sum w f lam^p
    M = np.empty((ny, nx, k, k))
    for a in range(k):
        for b in range(k):
            M[..., a, b] = S[a + b]
    b_vec = np.moveaxis(T, 0, -1)                                     # (ny, nx, k)
    ridge = 1e-9 * np.trace(M, axis1=-2, axis2=-1)[..., None, None] * np.eye(k)
    n_used = ok.sum(axis=0)
    valid = n_used >= k + 2
    coef = np.zeros((ny, nx, k))
    with np.errstate(all="ignore"):
        try:
            coef[valid] = np.linalg.solve(M[valid] + ridge[valid], b_vec[valid][..., None])[..., 0]
        except np.linalg.LinAlgError:
            for yy, xx in zip(*np.nonzero(valid)):
                coef[yy, xx] = np.linalg.lstsq(M[yy, xx] + ridge[yy, xx], b_vec[yy, xx], rcond=None)[0]
        # at the least-squares solution, sum w (f - model)^2 = sum w f^2 - c.b
        chi2 = (np.where(ok, np.nan_to_num(f), 0.0) ** 2 * w).sum(axis=0) - (coef * b_vec).sum(axis=-1)
        dof = np.maximum(n_used - k, 1)
        reduced = np.where(valid, np.maximum(chi2, 0.0) / dof, np.nan)

    # 4. robust z against this field's own distribution
    finite = reduced[np.isfinite(reduced)]
    med = float(np.median(finite)) if finite.size else float("nan")
    mad = float(1.4826 * np.median(np.abs(finite - med))) if finite.size else float("nan")
    with np.errstate(all="ignore"):
        z = (reduced - med) / mad if mad and np.isfinite(mad) and mad > 0 else np.full_like(reduced, np.nan)

    return {
        "chi2_per_dof": reduced.astype(np.float32),
        "z": z.astype(np.float32),
        "n_used": n_used.astype(np.int16),
        "threshold": CHANGE_THRESHOLD,
        "median": med,
        "mad": mad,
        "n_significant": int(np.count_nonzero(np.nan_to_num(z, nan=-np.inf) > CHANGE_THRESHOLD)),
    }


def change_peaks(cm: dict, min_sep: int = 3, max_peaks: int = 12,
                 threshold: float | None = None) -> list[dict]:
    """Local maxima of the robust-z map, strongest first."""
    from scipy.ndimage import maximum_filter
    zmap = cm["z"]
    thr = CHANGE_THRESHOLD if threshold is None else threshold
    s = np.where(np.isfinite(zmap), zmap, -np.inf)
    local = maximum_filter(s, size=2 * min_sep + 1)
    ys, xs = np.nonzero((s >= thr) & (s == local))
    peaks = [{"x": int(x), "y": int(y), "z": round(float(s[y, x]), 1),
              "chi2_per_dof": round(float(cm["chi2_per_dof"][y, x]), 2),
              "n_used": int(cm["n_used"][y, x])} for y, x in zip(ys, xs)]
    peaks.sort(key=lambda p: -p["z"])
    return peaks[:max_peaks]


# ---------------------------------------------------------------------------
# What kind of thing is this?
# ---------------------------------------------------------------------------

#: Human-readable meaning of each template, for the UI.
TEMPLATE_LABELS = {
    "planet": ("cold and methane-rich",
               "Reflected sunlight with methane absorption — the signature of a cold giant "
               "planet or a brown dwarf."),
    "asteroid": ("reflected sunlight",
                 "A flat, slightly red reflection spectrum, like rock or ice lit by the Sun."),
    "star": ("star-like",
             "A smooth thermal glow, like a star. A brown dwarf can land here too: these simple "
             "shapes cannot tell a warm brown dwarf from a cool star."),
    "none": ("not enough data", "Too few bands measured here to tell."),
}


def fit_temperature(wave_um, flux, err) -> dict:
    """Best single blackbody temperature, by coarse scan then refinement.

    Colour temperature is the one number that makes an infrared spectrum intuitive: a few
    hundred kelvin is a brown dwarf, a few thousand an ordinary star. It is only a colour
    temperature, not a physical surface, and the UI says so.
    """
    w = np.asarray(wave_um, float)
    f = np.asarray(flux, float)
    e = np.asarray(err, float)
    ok = np.isfinite(f) & np.isfinite(e) & (e > 0) & np.isfinite(w)
    if ok.sum() < 3 or len(np.unique(np.round(w[ok], 2))) < 3:
        return {"temperature_k": None, "chi2_per_dof": None}
    w, f, e = w[ok], f[ok], e[ok]
    wt = 1.0 / e ** 2
    best = (np.inf, None)
    for T in np.geomspace(100.0, 20000.0, 220):
        t = planck_nu(w, T)
        t = t / max(float(np.max(t)), 1e-300)
        s = float((wt * t * f).sum() / max(float((wt * t * t).sum()), 1e-30))
        if s <= 0:
            continue
        chi2 = float((((f - s * t) / e) ** 2).sum())
        if chi2 < best[0]:
            best = (chi2, T)
    chi2, T = best
    if T is None:
        return {"temperature_k": None, "chi2_per_dof": None}
    return {"temperature_k": round(float(T)), "chi2_per_dof": round(chi2 / max(len(w) - 2, 1), 2)}


#: The stellar hypothesis is a blackbody at any temperature in this range, not one fixed
#: shape. With a single 4500 K template, a cool M dwarf (~3100 K) fitted the "reflected
#: sunlight" shape -- a red-tilted 5772 K blackbody -- better, and was labelled an asteroid.
STAR_T_RANGE_K = (2300.0, 12000.0)
STAR_T_STEPS = 120


def star_chi2(wave_um, flux, err) -> dict:
    """Best blackbody over the stellar temperature range: {chi2, temperature_k}."""
    w, f, e = np.asarray(wave_um, float), np.asarray(flux, float), np.asarray(err, float)
    ok = np.isfinite(f) & np.isfinite(e) & (e > 0) & np.isfinite(w)
    best = (np.inf, None)
    if ok.sum() < 2:
        return {"chi2": np.inf, "temperature_k": None}
    w, f, e = w[ok], f[ok], e[ok]
    wt = 1.0 / e ** 2
    for T in np.geomspace(*STAR_T_RANGE_K, STAR_T_STEPS):
        t = planck_nu(w, T)
        t = t / max(float(np.max(t)), 1e-300)
        s = max(float((wt * t * f).sum() / max(float((wt * t * t).sum()), 1e-30)), 0.0)
        chi2 = float((((f - s * t) / e) ** 2).sum())
        if chi2 < best[0]:
            best = (chi2, T)
    return {"chi2": best[0], "temperature_k": None if best[1] is None else round(float(best[1]))}


#: Percentile of a field's own best-fit chi2/dof above which a point is "odd one out".
ODD_PERCENTILE = 95.0


def field_odd_threshold(bundle_dir, *, n_sample: int = 150, percentile: float = ODD_PERCENTILE,
                        seed: int = 0) -> dict:
    """How badly do ordinary points in *this* field fit the templates?

    An absolute "nothing fits" threshold does not survive real data. Sampled across the
    baked fields, the median best-template chi2/dof at random pixels is 13-19 -- mostly
    empty sky -- because every exposure's point carries its own zodiacal background and
    our three shapes are deliberately crude. With a fixed threshold all five challenge
    targets were flagged "odd one out", which made the badge meaningless.

    Relative to the field it means something: on the baked data only RW Aurigae clears its
    field's 95th percentile (50 against 26.5), because its variability scrambles its own
    spectrum across epochs. Barnard's Star, WISE 0855 and Epsilon Indi B sit inside theirs.
    """
    from deepfield.sky.service import spectrum_at
    rng = np.random.default_rng(seed)
    with np.load(Path(bundle_dir) / "cube.npz", allow_pickle=True) as z:
        ny, nx = z["flux"].shape[1:]
    vals = []
    for _ in range(n_sample):
        x, y = int(rng.integers(3, nx - 3)), int(rng.integers(3, ny - 3))
        try:
            k = classify_point(spectrum_at(bundle_dir, x, y, 1)["points"])
        except Exception:
            continue
        if k.get("available") and k.get("best_chi2_per_dof") is not None:
            vals.append(float(k["best_chi2_per_dof"]))
    if len(vals) < 20:
        return {"odd_threshold": UNEXPLAINED_CHI2, "odd_percentile": None, "n_sampled": len(vals),
                "note": "too few classifiable points; fell back to the fixed threshold"}
    v = np.asarray(vals)
    return {"odd_threshold": round(float(np.percentile(v, percentile)), 3),
            "odd_percentile": percentile, "n_sampled": len(vals),
            "field_median_chi2_per_dof": round(float(np.median(v)), 3),
            "note": ("A point is 'odd one out' when its best template fits worse than "
                     f"{percentile:.0f}% of randomly sampled points in this same field.")}


def classify_point(points: list[dict], odd_threshold: float | None = None) -> dict:
    """Template + temperature verdict for one clicked spectrum.

    `odd_threshold` is the field's own calibration from `field_odd_threshold`; without it a
    fixed fallback is used, which on real SPHEREx data is too strict to mean anything.
    """
    if not points:
        return {"available": False, "reason": "no usable exposures at this point"}
    w = np.array([p["wave_um"] for p in points], float)
    f = np.array([p["flux_mjysr"] for p in points], float)
    e_stat = np.array([p["flux_err_mjysr"] for p in points], float)
    # The templates are deliberately simple physical shapes, and the cross-detector
    # calibration is good to a few percent, not to the photon noise. Without a floor a bright
    # star's tiny statistical error bars make every template "fail", so every bright star in
    # the sky would be flagged odd-one-out. With it, odd-one-out means "even allowing for
    # how crude our shapes are, nothing fits".
    e = np.sqrt(e_stat ** 2 + (CLASSIFY_SYS_FLOOR * np.abs(f)) ** 2)
    n_bands = len(set(np.round(w, 2)))
    if n_bands < 3:
        return {"available": False,
                "reason": f"only {n_bands} distinct colour{'s' if n_bands != 1 else ''} here — "
                          "need at least three to compare shapes"}

    fit = fit_templates(w, f, e)
    temp = fit_temperature(w, f, e)
    # Replace the fixed-temperature star with the best stellar blackbody, then re-rank.
    star = star_chi2(w, f, e)
    if np.isfinite(star["chi2"]) and fit.get("chi2"):
        fit["chi2"]["star"] = star["chi2"]
        kinds = ("planet", "asteroid", "star")
        c = np.array([fit["chi2"][k] for k in kinds])
        like = np.exp(-0.5 * (c - c.min()))
        p = like / like.sum()
        fit["methane_score"] = float(p[0])
        fit["best"] = kinds[int(np.argmax(p))]
    best = fit.get("best", "none")
    label, meaning = TEMPLATE_LABELS.get(best, TEMPLATE_LABELS["none"])
    chi2 = fit.get("chi2", {})
    ranked = sorted(((k, v) for k, v in chi2.items() if np.isfinite(v)), key=lambda kv: kv[1])
    dof = max(fit.get("n", 1) - 1, 1)

    # How badly does even the *best* template explain this point? A high value means none
    # of our shapes fit, which is the only honest form of "anomalous" available here: it is
    # a statement about our model library, not a claim about the object. An unmodelled but
    # perfectly ordinary source scores high, and so does a bad measurement.
    best_chi2_per_dof = round(float(ranked[0][1]) / dof, 2) if ranked else None
    limit = UNEXPLAINED_CHI2 if odd_threshold is None else float(odd_threshold)
    unexplained = bool(best_chi2_per_dof is not None and best_chi2_per_dof > limit)
    # "Confident" means a template both clearly wins *and* fits. Winning among three shapes
    # that all fail is not confidence, and showing both badges at once contradicted itself.
    confident = (len(ranked) > 1 and (ranked[1][1] - ranked[0][1]) > 2.0 and not unexplained)

    return {
        "available": True,
        "best": best,
        "label": label,
        "meaning": meaning,
        "confident": bool(confident),
        "unexplained": unexplained,
        "best_chi2_per_dof": best_chi2_per_dof,
        "odd_threshold": round(limit, 3),
        "anomaly_note": (
            "This spectrum fits our templates worse than almost every other point in this field. "
            "That makes it worth a look, but it is a gap in our small model library, not "
            "evidence of something new — a variable source (whose colours change between "
            "visits), a blended pair, or a bad measurement all land here too."
            if unexplained else None),
        "methane_score": None if fit.get("methane_score") is None or not np.isfinite(fit["methane_score"])
                         else round(float(fit["methane_score"]), 3),
        "n_bands": n_bands,
        "ranking": [{"template": k, "label": TEMPLATE_LABELS[k][0],
                     "chi2_per_dof": round(float(v) / dof, 2)} for k, v in ranked],
        "temperature": temp,
        "star_temperature_k": star["temperature_k"],
        "method": ("Weighted least-squares fit of three shapes — reflected sunlight with methane "
                   "absorption, plain reflected sunlight, and a stellar blackbody whose temperature "
                   "is fitted between 2,300 and 12,000 K — plus a free blackbody colour temperature. "
                   "No trained model, no third-party weights: the shapes are simple physical models "
                   "in pipeline/deepfield/spectral/templates.py and sky/analyse.py."),
        "caveat": ("A shape match is a hint, not an identification: these templates are "
                   "illustrative, and a handful of bands rarely pins down what something is."),
    }
