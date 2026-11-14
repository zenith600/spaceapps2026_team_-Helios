"""The shift-and-stack must recover a moving source that is invisible in any single frame."""
import numpy as np
import pytest
import torch

from deepfield.stack import geometry as G
from deepfield.stack import shiftstack as S
from deepfield.stack.reproject import Frame
from deepfield.config import SPHEREX_PIXEL_ARCSEC


def gaussian_psf(fwhm_px=1.22, size=7):
    s = fwhm_px / 2.3548
    y, x = np.mgrid[-(size // 2):size // 2 + 1, -(size // 2):size // 2 + 1]
    k = np.exp(-(x ** 2 + y ** 2) / (2 * s ** 2))
    return (k / k.sum()).astype(np.float32)


def add_source(img, x, y, amp, psf):
    h = psf.shape[0] // 2
    ix, iy = int(round(x)), int(round(y))
    img[iy - h:iy + h + 1, ix - h:ix + h + 1] += amp * psf


def synthetic_patch(n_epochs=30, size=96, amp=2.5, sigma=1.0, distance=500.0, seed=3, add_star=True):
    rng = np.random.default_rng(seed)
    mjds = np.linspace(60907.6, 60914.0, n_epochs)
    ph = 2 * np.pi * (mjds - 60000.0) / 365.25
    obs = np.stack([np.cos(ph), np.sin(ph), np.zeros_like(ph)], axis=1)
    ra0, dec0 = 0.0, 0.0  # observer velocity is perpendicular to this line of sight at these dates: large parallax
    psf = gaussian_psf()
    truth = G.Trial(distance, 0.0, 0.0)
    xi, eta = G.trial_offsets(truth, ra0, dec0, mjds, obs, mjd_ref=mjds.mean())
    x0, y0 = size / 2 + 3, size / 2 - 5
    frames = []
    for k in range(n_epochs):
        img = rng.normal(0, sigma, (size, size)).astype(np.float32)
        if add_star:
            add_source(img, 20, 70, 40.0 * (1 + 0.3 * np.sin(k)), psf)  # bright static star, varying brightness
        xk = x0 - xi[k] / SPHEREX_PIXEL_ARCSEC
        yk = y0 + eta[k] / SPHEREX_PIXEL_ARCSEC
        add_source(img, xk, yk, amp, psf)
        var = np.full((size, size), sigma ** 2, dtype=np.float32)
        good = np.ones((size, size), dtype=bool)
        src = np.zeros((size, size), dtype=bool)
        frames.append(Frame(f"E{k}", 1, float(mjds[k]), img, var, good, src, psf, 1.0 + 0.01 * k, 0.02))
    total_shift = np.hypot(xi[-1] - xi[0], eta[-1] - eta[0]) / SPHEREX_PIXEL_ARCSEC
    return frames, mjds, obs, ra0, dec0, (x0, y0), truth, total_shift


@pytest.mark.parametrize("dev", ["cpu"] + (["cuda"] if torch.cuda.is_available() else []))
def test_stack_recovers_injected_mover(dev):
    frames, mjds, obs, ra0, dec0, (x0, y0), truth, total_shift = synthetic_patch()
    assert total_shift > 4, "synthetic motion must exceed a few pixels or the test is trivial"
    prep = S.prepare(frames, dev=torch.device(dev))
    trials = G.default_trial_grid(distances=(300, 400, 500, 700, 1000, np.inf), rates=(-0.5, 0.0, 0.5))
    off = S.offsets_pixels(trials, ra0, dec0, mjds, obs, mjd_ref=mjds.mean())
    snr, flux, best_t, _ = S.stack_trials(prep, off)
    # single frames: matched-filter SNR of the source is amp * sqrt(sum psf^2) / sigma ~ 2.5*0.49 ~ 1.2
    single = prep.num[:, int(y0), int(x0)].cpu().numpy() / np.sqrt(prep.den[:, int(y0), int(x0)].cpu().numpy())
    iy, ix = np.unravel_index(np.nanargmax(np.where(np.isfinite(snr), snr, -np.inf)), snr.shape)
    assert abs(ix - x0) <= 1.5 and abs(iy - y0) <= 1.5, f"peak at {(ix, iy)} not at {(x0, y0)}"
    assert snr[iy, ix] > 5
    assert np.nanmax(np.abs(single)) < 3.5
    assert trials[best_t[iy, ix]].distance_au == truth.distance_au
    # the bright varying star must not produce a stronger peak than the planet after static subtraction
    assert snr[iy, ix] == np.nanmax(np.where(np.isfinite(snr), snr, -np.inf))
    # expected SNR ~ amp * sqrt(N * sum(psf^2)) / sigma
    psf = frames[0].psf
    expected = 2.5 * np.sqrt(len(frames) * (psf ** 2).sum()) / 1.0
    assert snr[iy, ix] == pytest.approx(expected, rel=0.35)


def test_wrong_distance_trial_is_weaker():
    frames, mjds, obs, ra0, dec0, (x0, y0), truth, _ = synthetic_patch(amp=4.0)
    prep = S.prepare(frames, dev=torch.device("cpu"))
    off_true = S.offsets_pixels([truth], ra0, dec0, mjds, obs, mjd_ref=mjds.mean())
    off_stat = S.offsets_pixels([G.Trial(np.inf)], ra0, dec0, mjds, obs, mjd_ref=mjds.mean())
    s_true, _ = S.stack_one(prep, off_true[0])
    s_stat, _ = S.stack_one(prep, off_stat[0])
    assert s_true[int(y0), int(x0)] > 2 * np.nanmax(s_stat[int(y0) - 3:int(y0) + 4, int(x0) - 3:int(x0) + 4])


def test_single_epoch_photometry_along_trajectory():
    frames, mjds, obs, ra0, dec0, (x0, y0), truth, _ = synthetic_patch(amp=20.0)
    prep = S.prepare(frames, dev=torch.device("cpu"))
    off = S.offsets_pixels([truth], ra0, dec0, mjds, obs, mjd_ref=mjds.mean())[0]
    snr, flux, err = S.single_epoch_snr_along(prep, off, x0, y0)
    assert np.nanmedian(flux) == pytest.approx(20.0, rel=0.25)
    assert np.isfinite(snr).sum() == len(frames)
    singles, static = S.shifted_stamps(prep, off, x0, y0, size=32, max_n=6)
    assert singles.shape == (6, 32, 32) and static.shape == (32, 32)
