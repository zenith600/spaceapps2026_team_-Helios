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

import numpy as np

from deepfield.spectral.templates import fit_templates, planck_nu

#: chi2/dof above this is "something changed here" rather than noise.
CHANGE_THRESHOLD = float(3.0)


def change_map(flux: np.ndarray, var: np.ndarray, good: np.ndarray,
               visit: np.ndarray | None = None) -> dict:
    """Per-pixel variability significance across the stack.

    For each pixel, fit a single constant brightness (the inverse-variance weighted mean)
    and measure how badly that fits:  chi2 = sum w (f - fbar)^2,  dof = n - 1.

    A source that moves leaves the pixel it used to occupy and enters a new one, so both
    pixels vary; a source that pulses varies in place. Either way chi2/dof climbs well
    above 1. Pixels seen fewer than three times are left undefined rather than guessed.
    """
    flux = np.asarray(flux, dtype=np.float64)
    var = np.asarray(var, dtype=np.float64)
    ok = np.asarray(good, dtype=bool) & np.isfinite(flux) & np.isfinite(var) & (var > 0)

    w = np.where(ok, 1.0 / np.where(var > 0, var, np.inf), 0.0)
    n = ok.sum(axis=0)
    wsum = w.sum(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(wsum > 0, (w * np.nan_to_num(flux)).sum(axis=0) / np.where(wsum > 0, wsum, 1), np.nan)
        resid = np.where(ok, flux - mean, 0.0)
        chi2 = (w * resid ** 2).sum(axis=0)
        dof = np.maximum(n - 1, 1)
        reduced = np.where(n >= 3, chi2 / dof, np.nan)

    out = {
        "chi2_per_dof": reduced.astype(np.float32),
        "n_used": n.astype(np.int16),
        "mean_flux": mean.astype(np.float32),
        "threshold": CHANGE_THRESHOLD,
    }
    finite = reduced[np.isfinite(reduced)]
    out["median"] = float(np.median(finite)) if finite.size else float("nan")
    out["n_significant"] = int(np.count_nonzero(reduced > CHANGE_THRESHOLD))
    return out


def change_peaks(cm: dict, min_sep: int = 3, max_peaks: int = 12,
                 threshold: float | None = None) -> list[dict]:
    """Local maxima of the change map, strongest first."""
    from scipy.ndimage import maximum_filter
    r = cm["chi2_per_dof"]
    thr = CHANGE_THRESHOLD if threshold is None else threshold
    s = np.where(np.isfinite(r), r, -np.inf)
    local = maximum_filter(s, size=2 * min_sep + 1)
    ys, xs = np.nonzero((s >= thr) & (s == local))
    peaks = [{"x": int(x), "y": int(y), "chi2_per_dof": round(float(s[y, x]), 2),
              "n_used": int(cm["n_used"][y, x])} for y, x in zip(ys, xs)]
    peaks.sort(key=lambda p: -p["chi2_per_dof"])
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
             "A smooth thermal glow with no absorption dips, like an ordinary star."),
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


def classify_point(points: list[dict]) -> dict:
    """Template + temperature verdict for one clicked spectrum."""
    if not points:
        return {"available": False, "reason": "no usable exposures at this point"}
    w = np.array([p["wave_um"] for p in points], float)
    f = np.array([p["flux_mjysr"] for p in points], float)
    e = np.array([p["flux_err_mjysr"] for p in points], float)
    n_bands = len(set(np.round(w, 2)))
    if n_bands < 3:
        return {"available": False,
                "reason": f"only {n_bands} distinct colour{'s' if n_bands != 1 else ''} here — "
                          "need at least three to compare shapes"}

    fit = fit_templates(w, f, e)
    temp = fit_temperature(w, f, e)
    best = fit.get("best", "none")
    label, meaning = TEMPLATE_LABELS.get(best, TEMPLATE_LABELS["none"])
    chi2 = fit.get("chi2", {})
    ranked = sorted(((k, v) for k, v in chi2.items() if np.isfinite(v)), key=lambda kv: kv[1])
    dof = max(fit.get("n", 1) - 1, 1)
    confident = len(ranked) > 1 and (ranked[1][1] - ranked[0][1]) > 2.0

    return {
        "available": True,
        "best": best,
        "label": label,
        "meaning": meaning,
        "confident": bool(confident),
        "methane_score": None if fit.get("methane_score") is None or not np.isfinite(fit["methane_score"])
                         else round(float(fit["methane_score"]), 3),
        "n_bands": n_bands,
        "ranking": [{"template": k, "label": TEMPLATE_LABELS[k][0],
                     "chi2_per_dof": round(float(v) / dof, 2)} for k, v in ranked],
        "temperature": temp,
        "method": ("Weighted least-squares fit of three fixed template shapes, plus a single "
                   "blackbody colour temperature. No trained model, no third-party weights — "
                   "the templates are simple physical models written out in "
                   "pipeline/deepfield/spectral/templates.py."),
        "caveat": ("A shape match is a hint, not an identification: these templates are "
                   "illustrative, and a handful of bands rarely pins down what something is."),
    }
