"""Point-source detection and PSF fitting on original SPHEREx exposures.

Two PSF models, fitted the same way so they can be compared fairly:

- **Gaussian** (the model Deep Field used before): A·exp(−r²/2s²) + B, point-sampled, s free.
  Flux = 2πs²A. Simple, but SPHEREx under-samples its PSF (FWHM ≈ 1.2 px), so where a star
  falls inside a pixel biases a point-sampled model.
- **Instrument ePSF**: the effective PSF published with each exposure (`EPSF` extension,
  5× oversampled, pixel response included), evaluated at the star's own detector zone.
  Model = F·o²·E(o(y−y_c)+c, o(x−x_c)+c) + B with cubic-spline interpolation of E.
  `o²` restores per-native-pixel normalisation because the published oversampled array sums to 1.

Both fits minimise χ² = Σ((model − data)/σ)² over unflagged pixels in a 7×7 box with SciPy's
`least_squares`. Parameter covariance is (JᵀJ)⁻¹ (analytic, from the variance plane); callers
decide whether to inflate it by the reduced χ² — the calibration experiments measure which
choice gives honest coverage.

Extended sources: the ePSF is blurred by a circular Gaussian of width w (profiled over a grid)
and Δχ² = χ²(w=0) − min_w χ²(w) is a likelihood-ratio statistic for "wider than a point". On the
boundary w ≥ 0 its null distribution is ½χ²₀ + ½χ²₁ (Self & Liang 1987).
"""
from __future__ import annotations

import math
from functools import lru_cache

import numpy as np
from scipy import ndimage
from scipy.optimize import least_squares

BOX = 3                      # half-width of the fitting box → 7×7 pixels
EXT_W_GRID = np.round(np.arange(0.0, 3.01, 0.25), 2)     # extra Gaussian blur, native pixels


# ----------------------------------------------------------------------------- detection
def find_sources(image, variance, bad, fwhm_px: float = 1.2, nsigma: float = 5.0, border: int = 4,
                 max_sources: int = 400) -> list[dict]:
    """Matched-filter detection: SNR = Σk(I−B) / sqrt(Σk²σ²) with a Gaussian kernel k, local maxima above `nsigma`."""
    img = np.where(bad, np.nan, image)
    good = np.isfinite(img)
    if good.sum() < 50:
        return []
    vals = img[good]
    med = np.median(vals)
    for _ in range(3):                                  # sigma-clipped background
        s = 1.4826 * np.median(np.abs(vals - med))
        keep = np.abs(vals - med) < 3 * s
        if keep.sum() < 20:
            break
        med = np.median(vals[keep])
    sig = fwhm_px / 2.3548
    r = int(math.ceil(3 * sig)) + 1
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    k = np.exp(-(xx ** 2 + yy ** 2) / (2 * sig ** 2))
    k /= k.sum()
    num = ndimage.correlate(np.where(good, img - med, 0.0), k, mode="constant")
    den = np.sqrt(ndimage.correlate(np.where(good, variance, 0.0), k * k, mode="constant"))
    with np.errstate(invalid="ignore", divide="ignore"):
        snr = np.where(den > 0, num / den, 0.0)
    peak = (snr == ndimage.maximum_filter(snr, size=3)) & (snr > nsigma)
    ny, nx = img.shape
    peak[:border, :] = peak[-border:, :] = False
    peak[:, :border] = peak[:, -border:] = False
    ys, xs = np.nonzero(peak)
    order = np.argsort(-snr[ys, xs])[:max_sources]
    return [{"x": float(xs[i]), "y": float(ys[i]), "snr": float(snr[ys[i], xs[i]]), "background": float(med)}
            for i in order]


# ----------------------------------------------------------------------------- models
class EPSFModel:
    """Evaluate an oversampled ePSF at arbitrary sub-pixel offsets (cubic spline, cached)."""

    def __init__(self, epsf: np.ndarray, oversample: int = 5, blur_px: float = 0.0):
        e = np.asarray(epsf, float)
        if blur_px > 0:
            e = ndimage.gaussian_filter(e, blur_px * oversample, mode="constant")
            e = e / e.sum()
        self.o = oversample
        self.c = (e.shape[0] - 1) / 2.0
        self.coef = ndimage.spline_filter(e, order=3)
        self.half_native = (e.shape[0] - 1) / 2.0 / oversample

    def __call__(self, X, Y, xc, yc):
        u = self.c + self.o * (np.asarray(X, float) - xc)
        v = self.c + self.o * (np.asarray(Y, float) - yc)
        val = ndimage.map_coordinates(self.coef, [v.ravel(), u.ravel()], order=3, prefilter=False,
                                      mode="constant", cval=0.0).reshape(np.shape(X))
        return val * self.o ** 2


def gaussian_model(X, Y, xc, yc, s):
    return np.exp(-((X - xc) ** 2 + (Y - yc) ** 2) / (2 * s * s))


def _box(image, variance, bad, x0, y0, box=BOX):
    ny, nx = image.shape
    xi, yi = int(round(x0)), int(round(y0))
    ys = slice(max(yi - box, 0), min(yi + box + 1, ny))
    xs = slice(max(xi - box, 0), min(xi + box + 1, nx))
    Y, X = np.mgrid[ys, xs]
    d, v, b = image[ys, xs], variance[ys, xs], bad[ys, xs]
    ok = ~b & np.isfinite(d) & np.isfinite(v) & (v > 0)
    return X[ok].astype(float), Y[ok].astype(float), d[ok], np.sqrt(v[ok]), (ys, xs), ok


def _finish(r, X, Y, d, e, names, flux_index, extra=None):
    n, k = len(d), len(r.x)
    dof = max(n - k, 1)
    chi2 = float((r.fun ** 2).sum())
    try:
        cov = np.linalg.inv(r.jac.T @ r.jac)
    except np.linalg.LinAlgError:
        return None
    p = dict(zip(names, map(float, r.x)))
    out = {"x": p["xc"], "y": p["yc"], "cov_px": cov[1:3, 1:3].tolist(),
           "ex": float(math.sqrt(max(cov[1, 1], 0))), "ey": float(math.sqrt(max(cov[2, 2], 0))),
           "chi2": chi2, "dof": dof, "chi2_dof": chi2 / dof, "n_pix": n, "background": p["b"],
           "residual_rms_sigma": float(np.sqrt(np.mean(r.fun ** 2)))}
    out.update(extra or {})
    return out, cov, p


def fit_epsf(image, variance, bad, x0, y0, model: EPSFModel, box: int = BOX, max_shift: float = 2.0) -> dict | None:
    X, Y, d, e, _, _ = _box(image, variance, bad, x0, y0, box)
    if len(d) < 12:
        return None
    b0 = float(np.median(d[np.argsort(d)[: max(3, len(d) // 4)]]))
    f0 = float(max(np.sum(d - b0), 1e-9))

    def resid(p):
        f, xc, yc, b = p
        return (f * model(X, Y, xc, yc) + b - d) / e
    try:
        r = least_squares(resid, [f0, x0, y0, b0],
                          bounds=([-np.inf, x0 - max_shift, y0 - max_shift, -np.inf], [np.inf, x0 + max_shift, y0 + max_shift, np.inf]))
    except Exception:  # noqa: BLE001
        return None
    if not r.success:
        return None
    res = _finish(r, X, Y, d, e, ["flux", "xc", "yc", "b"], 0)
    if res is None:
        return None
    out, cov, p = res
    out.update({"model": "epsf", "flux": p["flux"], "flux_err": float(math.sqrt(max(cov[0, 0], 0))),
                "pinned": bool(abs(p["xc"] - x0) > max_shift - 0.05 or abs(p["yc"] - y0) > max_shift - 0.05)})
    out["snr"] = out["flux"] / out["flux_err"] if out["flux_err"] > 0 else 0.0
    return out


def fit_gaussian(image, variance, bad, x0, y0, box: int = BOX, max_shift: float = 2.0) -> dict | None:
    """The pre-existing model (point-sampled Gaussian + background), kept as the baseline."""
    X, Y, d, e, _, _ = _box(image, variance, bad, x0, y0, box)
    if len(d) < 12:
        return None
    b0 = float(np.median(d[np.argsort(d)[: max(3, len(d) // 4)]]))
    a0 = float(max(d.max() - b0, 1e-9))

    def resid(p):
        a, xc, yc, s, b = p
        return (a * gaussian_model(X, Y, xc, yc, s) + b - d) / e
    try:
        r = least_squares(resid, [a0, x0, y0, 0.55, b0],
                          bounds=([-np.inf, x0 - max_shift, y0 - max_shift, 0.25, -np.inf],
                                  [np.inf, x0 + max_shift, y0 + max_shift, 3.0, np.inf]))
    except Exception:  # noqa: BLE001
        return None
    if not r.success:
        return None
    res = _finish(r, X, Y, d, e, ["a", "xc", "yc", "s", "b"], 0)
    if res is None:
        return None
    out, cov, p = res
    flux = 2 * math.pi * p["s"] ** 2 * p["a"]
    # var(flux) by the delta method on (a, s)
    g = np.array([2 * math.pi * p["s"] ** 2, 0, 0, 4 * math.pi * p["s"] * p["a"], 0])
    out.update({"model": "gaussian", "flux": flux, "flux_err": float(math.sqrt(max(g @ cov @ g, 0))),
                "sigma_px": p["s"],
                "pinned": bool(abs(p["xc"] - x0) > max_shift - 0.05 or abs(p["yc"] - y0) > max_shift - 0.05)})
    out["snr"] = out["flux"] / out["flux_err"] if out["flux_err"] > 0 else 0.0
    return out


@lru_cache(maxsize=256)
def _blurred(key: bytes, oversample: int, w: float, shape: tuple) -> EPSFModel:
    e = np.frombuffer(key, dtype=float).reshape(shape)
    return EPSFModel(e, oversample, blur_px=w)


def extendedness(image, variance, bad, x0, y0, epsf: np.ndarray, oversample: int = 5) -> dict | None:
    """Profile the ePSF ⊗ Gaussian(w) fit over w; Δχ² vs the point-source fit and its p-value."""
    from scipy import stats
    key = np.ascontiguousarray(epsf, float).tobytes()
    chis, fits = [], []
    for w in EXT_W_GRID:
        m = _blurred(key, oversample, float(w), epsf.shape)
        f = fit_epsf(image, variance, bad, x0, y0, m, box=4)
        chis.append(np.inf if f is None else f["chi2"])
        fits.append(f)
    chis = np.asarray(chis)
    if not np.isfinite(chis[0]):
        return None
    j = int(np.argmin(chis))
    dchi = float(max(chis[0] - chis[j], 0.0))
    p = float(0.5 * stats.chi2.sf(dchi, 1)) if dchi > 0 else 1.0
    return {"best_blur_px": float(EXT_W_GRID[j]), "delta_chi2": dchi, "p_point": p,
            "chi2_dof_point": fits[0]["chi2_dof"], "chi2_dof_best": fits[j]["chi2_dof"] if fits[j] else None}
