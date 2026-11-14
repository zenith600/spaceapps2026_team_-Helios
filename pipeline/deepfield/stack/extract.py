"""Candidate extraction from the per-pixel max-over-trials SNR map."""
from __future__ import annotations

import numpy as np
from scipy.ndimage import maximum_filter


def find_peaks(snr: np.ndarray, nden: np.ndarray, threshold: float = 5.0, edge: int = 8, min_sep: int = 4,
               min_coverage: float = 0.5, max_peaks: int = 50) -> list[dict]:
    """Local maxima of the SNR map above threshold, away from the edges and in well-covered pixels."""
    s = np.where(np.isfinite(snr), snr, -np.inf)
    cov_ok = nden >= min_coverage * np.nanmedian(nden[nden > 0]) if np.any(nden > 0) else np.ones_like(nden, bool)
    local = maximum_filter(s, size=2 * min_sep + 1)
    mask = (s >= threshold) & (s == local) & cov_ok
    mask[:edge, :] = mask[-edge:, :] = False
    mask[:, :edge] = mask[:, -edge:] = False
    ys, xs = np.nonzero(mask)
    peaks = [{"x": int(x), "y": int(y), "snr": float(s[y, x])} for y, x in zip(ys, xs)]
    peaks.sort(key=lambda p: -p["snr"])
    return peaks[:max_peaks]


def peak_near(snr: np.ndarray, x: float, y: float, radius: float = 2.5) -> tuple[float, float, float]:
    """Max SNR within `radius` pixels of (x, y): returns (snr, x_peak, y_peak)."""
    h = int(np.ceil(radius))
    ix, iy = int(round(x)), int(round(y))
    y0, y1 = max(0, iy - h), min(snr.shape[0], iy + h + 1)
    x0, x1 = max(0, ix - h), min(snr.shape[1], ix + h + 1)
    sub = np.where(np.isfinite(snr[y0:y1, x0:x1]), snr[y0:y1, x0:x1], -np.inf)
    if sub.size == 0 or not np.isfinite(sub).any():
        return float("nan"), x, y
    yy, xx = np.mgrid[y0:y1, x0:x1]
    inside = np.hypot(xx - x, yy - y) <= radius
    sub = np.where(inside, sub, -np.inf)
    k = np.unravel_index(np.argmax(sub), sub.shape)
    return float(sub[k]), float(xx[k]), float(yy[k])


def rule_score(snr_stack: float, snr_single_max: float, stationary: bool, known: bool) -> float:
    """Transparent heuristic score in [0, 1]: high stacked SNR, invisible in singles, not stationary, not known."""
    s = 1 / (1 + np.exp(-(snr_stack - 5.0) / 1.5))
    if snr_single_max > 4:
        s *= 0.5      # visible in a single frame: more likely a static residual or artifact
    if stationary:
        s *= 0.3      # best trial has no parallax: not a distant mover
    if known:
        s *= 0.1
    return float(np.clip(s, 0, 1))
