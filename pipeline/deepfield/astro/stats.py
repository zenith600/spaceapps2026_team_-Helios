"""Statistics used across the validation pipeline.

Every function here is a standard, textbook method, written out so its assumptions are
visible and testable:

- `mahalanobis2`: D² = Δᵀ C⁻¹ Δ for a 2-D discrepancy with covariance C. Under a Gaussian null
  with correct C it follows χ² with 2 degrees of freedom.
- `chi2_sf`: survival function (p-value) of χ².
- `bh_qvalues`: Benjamini–Hochberg (1995) adjusted p-values (q-values), controlling the false
  discovery rate for independent or positively dependent tests.
- `robust_z`: (x − median) / (1.4826 · MAD). For Gaussian data 1.4826·MAD estimates σ; a
  robust z of 5 is NOT a calibrated 5σ significance unless the data are Gaussian and
  independent, which correlated image pixels are not.
- `coverage`: fraction of normalised errors inside nominal 68.27 / 95.45 / 99.73 % intervals.
- `wilson_interval`: binomial confidence interval for a recovered fraction.
"""
from __future__ import annotations

import math

import numpy as np
from scipy import stats as _st

#: Two-sided Gaussian probability inside ±1σ, ±2σ, ±3σ.
NOMINAL = (0.682689492, 0.954499736, 0.997300204)


def mahalanobis2(delta, cov) -> np.ndarray:
    """D² for one or many 2-vectors. `delta` (..., 2), `cov` (..., 2, 2)."""
    d = np.asarray(delta, float)
    c = np.asarray(cov, float)
    inv = np.linalg.inv(c)
    return np.einsum("...i,...ij,...j->...", d, inv, d)


def chi2_sf(x, dof) -> np.ndarray:
    return _st.chi2.sf(np.asarray(x, float), dof)


def chi2_ppf(p, dof) -> float:
    return float(_st.chi2.ppf(p, dof))


def bh_qvalues(p) -> np.ndarray:
    """Benjamini–Hochberg adjusted p-values. NaN inputs stay NaN and are not counted."""
    p = np.asarray(p, float)
    out = np.full_like(p, np.nan)
    ok = np.isfinite(p)
    m = int(ok.sum())
    if m == 0:
        return out
    pv = p[ok]
    order = np.argsort(pv)
    ranked = pv[order] * m / np.arange(1, m + 1)
    q = np.minimum.accumulate(ranked[::-1])[::-1]
    q = np.clip(q, 0.0, 1.0)
    res = np.empty(m)
    res[order] = q
    out[ok] = res
    return out


def robust_sigma(x) -> float:
    x = np.asarray(x, float)
    x = x[np.isfinite(x)]
    if x.size == 0:
        return float("nan")
    return float(1.4826 * np.median(np.abs(x - np.median(x))))


def robust_z(x) -> np.ndarray:
    x = np.asarray(x, float)
    s = robust_sigma(x)
    med = float(np.nanmedian(x)) if np.isfinite(x).any() else float("nan")
    with np.errstate(invalid="ignore", divide="ignore"):
        return (x - med) / s


def coverage_1d(z) -> dict:
    """Fraction of |z| within 1, 2, 3 (z = error / claimed σ)."""
    z = np.abs(np.asarray(z, float))
    z = z[np.isfinite(z)]
    n = int(z.size)
    if n == 0:
        return {"n": 0}
    f = [float(np.mean(z <= k)) for k in (1, 2, 3)]
    return {"n": n, "nominal": list(NOMINAL), "empirical": f}


def coverage_2d(d2) -> dict:
    """Fraction of 2-D D² within the χ²(2) quantiles that match 1σ/2σ/3σ probability."""
    d2 = np.asarray(d2, float)
    d2 = d2[np.isfinite(d2)]
    n = int(d2.size)
    if n == 0:
        return {"n": 0}
    thr = [chi2_ppf(p, 2) for p in NOMINAL]
    f = [float(np.mean(d2 <= t)) for t in thr]
    return {"n": n, "nominal": list(NOMINAL), "empirical": f, "thresholds_d2": thr}


def wilson_interval(k: int, n: int, z: float = 1.0) -> tuple[float, float]:
    """Wilson score interval for a binomial proportion (z=1 → ~68 %)."""
    if n <= 0:
        return (float("nan"), float("nan"))
    p = k / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return (max(0.0, centre - half), min(1.0, centre + half))


def summarize(x) -> dict:
    """Median, RMS, percentiles and max of a sample (NaN-safe)."""
    x = np.asarray(x, float)
    x = x[np.isfinite(x)]
    if x.size == 0:
        return {"n": 0}
    return {"n": int(x.size), "median": float(np.median(x)), "rms": float(np.sqrt(np.mean(x ** 2))),
            "p68": float(np.percentile(x, 68.27)), "p95": float(np.percentile(x, 95)),
            "max": float(np.max(x)), "mean": float(np.mean(x))}
