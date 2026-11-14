"""Two visits six months apart: the cross-visit static template must keep a mover and cancel stars.

This is the geometry SPHEREx actually gives us (90 deg elongation -> sub-pixel parallax within a visit, hundreds
of arcsec between visits), so this test is the one that matters for the real search.
"""
import numpy as np
import pytest
import torch

from deepfield.config import SPHEREX_PIXEL_ARCSEC
from deepfield.stack import geometry as G
from deepfield.stack import shiftstack as S
from deepfield.stack.reproject import Frame
from tests.test_stack import add_source, gaussian_psf


def two_visit_patch(amp=4.0, sigma=1.0, distance=500.0, size=160, n_per_visit=15, seed=5):
    rng = np.random.default_rng(seed)
    mjds = np.concatenate([np.linspace(60907.6, 60914.0, n_per_visit), np.linspace(61083.5, 61092.7, n_per_visit)])
    # real observer track: astropy Earth ephemeris (no network)
    from deepfield.data.horizons import earth_heliocentric_icrs
    obs = earth_heliocentric_icrs(mjds + 2400000.5)
    ra0, dec0 = 64.6875, 13.248
    psf = gaussian_psf()
    truth = G.Trial(distance, 0.0, 0.0)
    xi, eta = G.trial_offsets(truth, ra0, dec0, mjds, obs, mjd_ref=mjds.mean())
    x0, y0 = size / 2 + 5, size / 2 - 3
    # SPHEREx flags pixels of catalogued sources (SOURCE bit); the search gives them zero weight. Mimic that.
    yy, xx = np.mgrid[0:size, 0:size]
    src_mask = (np.hypot(xx - 30, yy - 120) <= 4) | (np.hypot(xx - 110, yy - 40) <= 4)
    frames = []
    for k in range(len(mjds)):
        img = rng.normal(0, sigma, (size, size)).astype(np.float32)
        add_source(img, 30, 120, 60.0 * (1 + 0.4 * np.sin(k)), psf)        # bright variable star
        add_source(img, 110, 40, 25.0 * (1 + 0.2 * np.cos(k / 3)), psf)
        xk, yk = x0 - xi[k] / SPHEREX_PIXEL_ARCSEC, y0 + eta[k] / SPHEREX_PIXEL_ARCSEC
        add_source(img, xk, yk, amp, psf)
        frames.append(Frame(f"E{k}", 1, float(mjds[k]), img, np.full((size, size), sigma ** 2, np.float32),
                            np.ones((size, size), bool), src_mask, psf, 1.0, 0.02))
    jump = np.hypot(xi[-1] - xi[0], eta[-1] - eta[0]) / SPHEREX_PIXEL_ARCSEC
    within = np.hypot(xi[n_per_visit - 1] - xi[0], eta[n_per_visit - 1] - eta[0]) / SPHEREX_PIXEL_ARCSEC
    return frames, mjds, obs, ra0, dec0, (x0, y0), truth, jump, within


def test_geometry_is_as_expected():
    _, _, _, _, _, _, _, jump, within = two_visit_patch()
    assert within < 3, "within a visit SPHEREx parallax is a few pixels at most"
    assert 60 < jump < 200, "between visits the shift is ~800 arcsec at 500 AU"


def test_cross_visit_template_recovers_mover_and_cancels_stars():
    frames, mjds, obs, ra0, dec0, (x0, y0), truth, jump, _ = two_visit_patch()
    prep = S.prepare(frames, dev=torch.device("cpu"))
    groups = S.visit_groups(mjds)
    assert len(np.unique(groups)) == 2
    prep_v = S.collapse_visits(prep)
    assert prep_v.num.shape[0] == 2
    obs_v = np.stack([np.interp(prep_v.mjds, mjds, obs[:, k]) for k in range(3)], 1)
    trials, off = S.two_visit_trials(ra0, dec0, prep_v.mjds, obs_v, mjds.mean())
    assert 1000 < len(trials) < 60000, len(trials)
    snr, flux, best_t, _ = S.stack_trials(prep_v, off, chunk=256)
    s = np.where(np.isfinite(snr), snr, -np.inf)
    iy, ix = np.unravel_index(np.argmax(s), s.shape)
    assert abs(ix - x0) <= 2 and abs(iy - y0) <= 2, f"peak at {(ix, iy)}, expected {(x0, y0)}"
    assert s[iy, ix] > 5
    assert abs(trials[best_t[iy, ix]].distance_au - truth.distance_au) / truth.distance_au < 0.03
    # the variable stars must not win
    assert s[120, 30] < s[iy, ix] and s[40, 110] < s[iy, ix]
    # the stationary trial must be much weaker at the planet position
    stat = [i for i, t in enumerate(trials) if not np.isfinite(t.distance_au)][0]
    s_stat, _ = S.stack_one(prep_v, off[stat])
    assert s_stat[int(y0), int(x0)] < 0.6 * s[iy, ix]


def test_single_visit_median_would_have_killed_it():
    """Documenting the failure mode: with one visit only, the global median absorbs a sub-pixel mover."""
    frames, mjds, obs, ra0, dec0, (x0, y0), truth, _, _ = two_visit_patch(amp=3.0)
    half = [f for f in frames if f.mjd < 61000]
    prep1 = S.prepare(half, dev=torch.device("cpu"))
    off = S.offsets_pixels([truth], ra0, dec0, np.array([f.mjd for f in half]), obs[: len(half)], mjd_ref=np.mean([f.mjd for f in half]))
    s1, _ = S.stack_one(prep1, off[0])
    expected_if_not_subtracted = 3.0 * np.sqrt(len(half) * (frames[0].psf ** 2).sum())
    assert s1[int(y0), int(x0)] < 0.5 * expected_if_not_subtracted
