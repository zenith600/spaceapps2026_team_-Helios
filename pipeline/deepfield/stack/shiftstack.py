"""Shift-and-stack with a matched filter, batched over trial motions in PyTorch (GPU if available).

Pipeline for one patch:
  1. frames (reprojected, common grid) -> static-sky template (per-pixel median over epochs),
     per-epoch linear fit of the template (absorbs band-to-band brightness changes), residual images.
  2. matched filter per epoch:  num_k = PSF * (w_k * resid_k),  den_k = PSF^2 * w_k,  with w = good / var,
     SOURCE-flagged pixels (known static sources) get w = 0.
  3. for each trial: shift num_k, den_k by the trial's per-epoch offset and sum ->
     SNR(x) = sum(num) / sqrt(sum(den)),  flux(x) = sum(num) / sum(den).
  4. keep per-pixel max over trials (and argmax) for candidate extraction.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import torch
import torch.nn.functional as F

from deepfield.config import SPHEREX_PIXEL_ARCSEC
from deepfield.stack.geometry import Trial, default_trial_grid, trial_offsets
from deepfield.stack.reproject import Frame


def device() -> torch.device:
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


@dataclass
class Prepared:
    num: torch.Tensor      # (N, H, W)
    den: torch.Tensor      # (N, H, W)
    resid: np.ndarray      # (N, H, W) residual images (static removed), NaN where bad
    static: np.ndarray     # (H, W)
    sigma: np.ndarray      # (N, H, W) per-pixel noise
    mjds: np.ndarray
    psf: np.ndarray


def _conv(img: torch.Tensor, kernel: torch.Tensor) -> torch.Tensor:
    k = kernel.flip(0, 1)[None, None]
    return F.conv2d(img[:, None], k, padding=k.shape[-1] // 2)[:, 0]


def visit_groups(mjds: np.ndarray, gap_days: float = 30.0) -> np.ndarray:
    """Label epochs by visit: consecutive (sorted) epochs closer than gap_days share a label."""
    order = np.argsort(mjds)
    lab = np.zeros(len(mjds), dtype=int)
    cur = 0
    for i in range(1, len(order)):
        if mjds[order[i]] - mjds[order[i - 1]] > gap_days:
            cur += 1
        lab[order[i]] = cur
    return lab


def prepare(frames: list[Frame], mask_known_sources: bool = True, dev: torch.device | None = None) -> Prepared:
    """Static-sky removal + matched filter.

    SPHEREx observes at ~90 deg solar elongation, where a distant object's parallax motion within one visit is
    sub-pixel. A per-pixel median over all epochs would therefore absorb the object. With two or more visits
    (months apart) each visit's static template is the median of the *other* visits: stars cancel, a mover that
    sits at different positions in different visits survives. With one visit we fall back to the global median
    and the search is a plain co-add (no distance information) - this is reported in the patch summary.
    """
    dev = dev or device()
    imgs = np.stack([f.image for f in frames]).astype(np.float32)
    var = np.stack([f.variance for f in frames]).astype(np.float32)
    good = np.stack([f.good for f in frames])
    src = np.stack([f.source for f in frames])
    imgs[~good] = np.nan
    mjds_arr = np.array([f.mjd for f in frames])
    groups = visit_groups(mjds_arr)
    with np.errstate(all="ignore"):
        global_static = np.nanmedian(imgs, axis=0)
    templates = {}
    for g in np.unique(groups):
        others = imgs[groups != g]
        if len(np.unique(groups)) >= 2 and len(others) >= 3:
            with np.errstate(all="ignore"):
                t = np.nanmedian(others, axis=0)
        else:
            t = global_static
        templates[g] = np.where(np.isfinite(t), t, 0.0).astype(np.float32)
    static = np.where(np.isfinite(global_static), global_static, 0.0).astype(np.float32)
    resid = np.empty_like(imgs)
    sig_t = np.sqrt(np.nanmedian(var))
    for k in range(len(frames)):
        tmpl = templates[groups[k]]
        # Fit the template only where it carries signal (stars), so band-to-band / variability
        # changes of the static sky are absorbed; noise pixels would otherwise dominate the fit.
        m = good[k] & np.isfinite(imgs[k]) & (tmpl > 3 * sig_t)
        if m.sum() > 20:
            A = np.vstack([tmpl[m], np.ones(m.sum())]).T
            coef, *_ = np.linalg.lstsq(A, imgs[k][m], rcond=None)
            scale = coef[0] if 0.2 < coef[0] < 5 else 1.0
            resid[k] = imgs[k] - (scale * tmpl + coef[1])
        else:
            resid[k] = imgs[k] - tmpl
    w = np.where(good & np.isfinite(var) & (var > 0), 1.0 / np.maximum(var, 1e-12), 0.0).astype(np.float32)
    if mask_known_sources:
        w[src] = 0.0
    w[~np.isfinite(resid)] = 0.0
    r0 = np.nan_to_num(resid, nan=0.0)
    psf = frames[0].psf.astype(np.float32)
    pk = torch.tensor(psf, device=dev)
    W = torch.tensor(w, device=dev)
    R = torch.tensor(r0, device=dev)
    num = _conv(W * R, pk)
    den = _conv(W, pk * pk)
    return Prepared(num, den, resid, static, np.sqrt(np.where(w > 0, 1 / np.maximum(w, 1e-12), np.nan)),
                    np.array([f.mjd for f in frames]), psf)


def offsets_pixels(trials: list[Trial], ra0: float, dec0: float, mjds: np.ndarray, observer_xyz: np.ndarray,
                   mjd_ref: float | None = None) -> np.ndarray:
    """(T, N, 2) pixel offsets (dx, dy) of each trial at each epoch. +x = east on the target grid? No: the
    target WCS has CDELT1 < 0, so east is -x. We return offsets in *pixel* coordinates of that grid."""
    out = np.zeros((len(trials), len(mjds), 2))
    for t, tr in enumerate(trials):
        xi, eta = trial_offsets(tr, ra0, dec0, mjds, observer_xyz, mjd_ref)
        out[t, :, 0] = -xi / SPHEREX_PIXEL_ARCSEC
        out[t, :, 1] = eta / SPHEREX_PIXEL_ARCSEC
    return out


def collapse_visits(prep: Prepared, gap_days: float = 30.0) -> Prepared:
    """Sum the matched-filter num/den over each visit (sub-pixel motion inside a visit is ignored).

    Returns a Prepared with one 'epoch' per visit at the visit's mean MJD, so a dense trial grid (thousands of
    distance/rate trials) costs only n_visits shifts per trial instead of n_epochs.
    """
    groups = visit_groups(prep.mjds, gap_days)
    ids = np.unique(groups)
    dev = prep.num.device
    g = torch.tensor(groups, device=dev)
    num = torch.stack([prep.num[g == i].sum(0) for i in ids])
    den = torch.stack([prep.den[g == i].sum(0) for i in ids])
    mjds = np.array([prep.mjds[groups == i].mean() for i in ids])
    return Prepared(num, den, prep.resid, prep.static, prep.sigma, mjds, prep.psf)


def dense_trial_grid(mjd_span_days: float, pixel_arcsec: float = SPHEREX_PIXEL_ARCSEC,
                     d_min: float = 250.0, d_max: float = 1500.0, rate_max: float = 0.6) -> list[Trial]:
    """Distance list fine enough that neighbouring trials differ by ~1 pixel over the given baseline (no rates)."""
    shift_max_arcsec = np.degrees(2.0 / d_min) * 3600 * min(1.0, mjd_span_days / 182.6)
    n_d = int(np.ceil(np.log(d_max / d_min) / np.log(1 + pixel_arcsec / max(shift_max_arcsec, pixel_arcsec)))) + 1
    distances = tuple(np.geomspace(d_min, d_max, max(n_d, 8))) + (np.inf,)
    return default_trial_grid(distances=distances, rates=(0.0,))


def two_visit_trials(ra0: float, dec0: float, mjds_v: np.ndarray, observer_v: np.ndarray, mjd_ref: float,
                     rate_max_arcsec_day: float = 0.6, pixel_arcsec: float = SPHEREX_PIXEL_ARCSEC,
                     d_min: float = 250.0, d_max: float = 1500.0) -> tuple[list[Trial], np.ndarray]:
    """Dense (distance x 2-D rate) trials for collapsed visits, deduplicated to distinct integer-pixel shifts.

    Returns (trials, offsets_px[T, n_visits, 2]). The parallax offsets are computed per distance; the linear
    rate term is added analytically in pixel space, so hundreds of thousands of (d, rate) combinations reduce to
    the few thousand distinct shift patterns the pixel grid can actually tell apart.
    """
    span = float(mjds_v.max() - mjds_v.min())
    base = dense_trial_grid(span, pixel_arcsec, d_min, d_max)
    par = offsets_pixels(base, ra0, dec0, mjds_v, observer_v, mjd_ref)          # (D, V, 2)
    dt = (mjds_v - mjd_ref) / pixel_arcsec                                     # days per pixel-arcsec
    step = pixel_arcsec / max(span, 1.0)                                       # rate step = 1 px over the baseline
    n_r = int(np.ceil(rate_max_arcsec_day / step))
    rates = np.linspace(-n_r * step, n_r * step, 2 * n_r + 1)
    RX, RY = np.meshgrid(rates, rates, indexing="ij")
    rx, ry = RX.ravel(), RY.ravel()                                            # (R,)
    # offsets[D, R, V, 2] = par[D, V, 2] + rate[R, 2] * dt[V]   (x: -east, so -rate_ra)
    offs = (par[:, None, :, :] + np.stack([-rx[None, :, None] * dt[None, None, :], ry[None, :, None] * dt[None, None, :]], axis=-1))
    D, R, V, _ = offs.shape
    flat = offs.reshape(D * R, V * 2)
    key = np.round(flat).astype(np.int64)
    _, idx = np.unique(key, axis=0, return_index=True)
    idx = np.sort(idx)
    trials = []
    for i in idx:
        d_i, r_i = divmod(int(i), R)
        trials.append(Trial(base[d_i].distance_au, float(rx[r_i]), float(ry[r_i])))
    return trials, flat[idx].reshape(len(idx), V, 2)


def stack_trials(prep: Prepared, offsets_px: np.ndarray, chunk: int = 24) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Return (snr_max, flux_at_max, best_trial, nden) maps over all trials, shape (H, W)."""
    N, H, W = prep.num.shape
    dev = prep.num.device
    T = offsets_px.shape[0]
    best_snr = torch.full((H, W), -np.inf, device=dev)
    best_flux = torch.zeros((H, W), device=dev)
    best_t = torch.zeros((H, W), dtype=torch.int32, device=dev)
    best_den = torch.zeros((H, W), device=dev)
    for t0 in range(0, T, chunk):
        off = torch.tensor(offsets_px[t0:t0 + chunk], dtype=torch.float32, device=dev)  # (C, N, 2)
        C = off.shape[0]
        theta = torch.zeros((C * N, 2, 3), device=dev)
        theta[:, 0, 0] = 1; theta[:, 1, 1] = 1
        theta[:, 0, 2] = (2 * off[..., 0] / W).reshape(-1)
        theta[:, 1, 2] = (2 * off[..., 1] / H).reshape(-1)
        grid = F.affine_grid(theta, (C * N, 1, H, W), align_corners=False)
        num = prep.num[None].expand(C, N, H, W).reshape(C * N, 1, H, W)
        den = prep.den[None].expand(C, N, H, W).reshape(C * N, 1, H, W)
        snum = F.grid_sample(num, grid, mode="bilinear", padding_mode="zeros", align_corners=False).reshape(C, N, H, W).sum(1)
        sden = F.grid_sample(den, grid, mode="bilinear", padding_mode="zeros", align_corners=False).reshape(C, N, H, W).sum(1)
        snr = snum / torch.sqrt(sden.clamp_min(1e-20))
        snr[sden <= 0] = -np.inf
        m, idx = snr.max(0)
        better = m > best_snr
        best_snr = torch.where(better, m, best_snr)
        best_flux = torch.where(better, (snum / sden.clamp_min(1e-20)).gather(0, idx[None])[0], best_flux)
        best_den = torch.where(better, sden.gather(0, idx[None])[0], best_den)
        best_t = torch.where(better, (idx + t0).to(torch.int32), best_t)
    return (best_snr.cpu().numpy(), best_flux.cpu().numpy(), best_t.cpu().numpy(), best_den.cpu().numpy())


def stack_one(prep: Prepared, offsets_px_one: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Stack for a single trial: returns (snr_map, flux_map)."""
    snr, flux, _, _ = stack_trials(prep, offsets_px_one[None], chunk=1)
    return snr, flux


def single_epoch_snr_along(prep: Prepared, offsets_px_one: np.ndarray, x: float, y: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per-epoch matched-filter (snr, flux, flux_err) at the trajectory position of one trial through (x, y)."""
    N, H, W = prep.num.shape
    num = prep.num.cpu().numpy(); den = prep.den.cpu().numpy()
    snr, flux, err = np.full(N, np.nan), np.full(N, np.nan), np.full(N, np.nan)
    for k in range(N):
        xk, yk = x + offsets_px_one[k, 0], y + offsets_px_one[k, 1]
        ix, iy = int(round(xk)), int(round(yk))
        if 0 <= ix < W and 0 <= iy < H and den[k, iy, ix] > 0:
            snr[k] = num[k, iy, ix] / np.sqrt(den[k, iy, ix])
            flux[k] = num[k, iy, ix] / den[k, iy, ix]
            err[k] = 1 / np.sqrt(den[k, iy, ix])
    return snr, flux, err


def stamp_along(arr: np.ndarray, x: float, y: float, size: int = 32) -> np.ndarray:
    """Cut a size x size stamp centred on (x, y) from a 2-D array (zero padded)."""
    h = size // 2
    ix, iy = int(round(x)), int(round(y))
    out = np.zeros((size, size), dtype=np.float32)
    y0, y1, x0, x1 = iy - h, iy + h, ix - h, ix + h
    sy0, sy1 = max(0, y0), min(arr.shape[0], y1)
    sx0, sx1 = max(0, x0), min(arr.shape[1], x1)
    if sy1 > sy0 and sx1 > sx0:
        out[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = np.nan_to_num(arr[sy0:sy1, sx0:sx1], nan=0.0)
    return out


def shifted_stamps(prep: Prepared, offsets_px_one: np.ndarray, x: float, y: float, size: int = 32, max_n: int = 12):
    """Single-epoch residual stamps re-centred on the trial trajectory (for the blink viewer), plus static stamp."""
    N = prep.resid.shape[0]
    idx = np.linspace(0, N - 1, min(N, max_n)).round().astype(int)
    singles = np.stack([stamp_along(prep.resid[k] / np.nanmedian(prep.sigma[k]), x + offsets_px_one[k, 0], y + offsets_px_one[k, 1], size)
                        for k in idx])
    static = stamp_along(prep.static, x, y, size)
    return singles, static
