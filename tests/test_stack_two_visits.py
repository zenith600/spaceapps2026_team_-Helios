"""Cross-visit stacking: what it can and cannot do, and why.

SPHEREx observes at ~90 deg solar elongation, so a distant object barely moves within one visit
(sub-pixel) and jumps hundreds of arcsec between visits months apart. Recovering it therefore
depends entirely on how many visits you have, and the answer is sharper than it looks:

  1 visit   a plain co-add. No distance information at all.
  2 visits  two time samples, and the model has distance *and* a 2-D proper motion. A wrong
            (distance, rate) pair reproduces the same single inter-visit shift and peaks
            somewhere else entirely. Position is not constrained.
  3+ visits parallax is curved in time, proper motion is linear, and they separate. Position
            and distance are both recovered.

These tests pin that down, because the failure mode at 2 visits is silent: the search returns a
confident, high-SNR peak in the wrong place rather than reporting nothing.
"""
import numpy as np
import pytest
import torch

from deepfield.config import SPHEREX_PIXEL_ARCSEC
from deepfield.data.horizons import earth_heliocentric_icrs
from deepfield.stack import geometry as G
from deepfield.stack import shiftstack as S
from deepfield.stack.extract import noise_threshold
from deepfield.stack.reproject import Frame
from tests.test_stack import add_source, gaussian_psf

VISIT_STARTS = [60907.6, 61083.5, 61265.0, 61448.0]


def multi_visit_patch(n_visits=2, amp=8.0, sigma=1.0, distance=500.0, size=160,
                      n_per_visit=12, seed=5, visit_days=7.0):
    """Synthetic patch: two variable stars (SOURCE-flagged, as SPHEREx flags catalogued sources)
    plus one moving object at `distance`, observed over `n_visits` visits months apart."""
    rng = np.random.default_rng(seed)
    mjds = np.concatenate([np.linspace(s, s + visit_days, n_per_visit) for s in VISIT_STARTS[:n_visits]])
    obs = earth_heliocentric_icrs(mjds + 2400000.5)       # astropy ephemeris, no network
    ra0, dec0 = 64.6875, 13.248
    psf = gaussian_psf()
    truth = G.Trial(distance, 0.0, 0.0)
    xi, eta = G.trial_offsets(truth, ra0, dec0, mjds, obs, mjd_ref=mjds.mean())
    x0, y0 = size / 2 + 5, size / 2 - 3
    yy, xx = np.mgrid[0:size, 0:size]
    src_mask = (np.hypot(xx - 30, yy - 120) <= 4) | (np.hypot(xx - 110, yy - 40) <= 4)
    frames = []
    for k in range(len(mjds)):
        img = rng.normal(0, sigma, (size, size)).astype(np.float32)
        add_source(img, 30, 120, 60.0 * (1 + 0.4 * np.sin(k)), psf)       # bright variable star
        add_source(img, 110, 40, 25.0 * (1 + 0.2 * np.cos(k / 3)), psf)
        add_source(img, x0 - xi[k] / SPHEREX_PIXEL_ARCSEC, y0 + eta[k] / SPHEREX_PIXEL_ARCSEC, amp, psf)
        frames.append(Frame(f"E{k}", 1, float(mjds[k]), img, np.full((size, size), sigma ** 2, np.float32),
                            np.ones((size, size), bool), src_mask, psf, 1.0, 0.02))
    return frames, mjds, obs, ra0, dec0, (x0, y0), truth


def two_visit_patch(amp=8.0, **kw):
    """Back-compatible helper: the two-visit case plus its shift scales."""
    frames, mjds, obs, ra0, dec0, xy, truth = multi_visit_patch(n_visits=2, amp=amp, **kw)
    xi, eta = G.trial_offsets(truth, ra0, dec0, mjds, obs, mjd_ref=mjds.mean())
    n_per_visit = len(mjds) // 2
    jump = np.hypot(xi[-1] - xi[0], eta[-1] - eta[0]) / SPHEREX_PIXEL_ARCSEC
    within = np.hypot(xi[n_per_visit - 1] - xi[0], eta[n_per_visit - 1] - eta[0]) / SPHEREX_PIXEL_ARCSEC
    return frames, mjds, obs, ra0, dec0, xy, truth, jump, within


def search(frames, mjds, obs, ra0, dec0, n_d=40, rates=(0.0,), template="auto"):
    """Collapse to one frame per visit and scan a bounded distance (and optionally rate) grid."""
    prep_v = S.collapse_visits(S.prepare(frames, dev=torch.device("cpu"), template=template))
    obs_v = np.stack([np.interp(prep_v.mjds, mjds, obs[:, k]) for k in range(3)], 1)
    trials = G.default_trial_grid(distances=tuple(np.geomspace(300, 900, n_d)) + (np.inf,), rates=rates)
    off = S.offsets_pixels(trials, ra0, dec0, prep_v.mjds, obs_v, mjds.mean())
    snr, flux, best_t, nden = S.stack_trials(prep_v, off, chunk=64)
    s = np.where(np.isfinite(snr), snr, -np.inf)
    iy, ix = np.unravel_index(np.argmax(s), s.shape)
    return {"snr": s, "x": int(ix), "y": int(iy), "peak": float(s[iy, ix]),
            "trial": trials[int(best_t[iy, ix])], "trials": trials, "prep_v": prep_v}


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------

def test_geometry_is_as_expected():
    _, _, _, _, _, _, _, jump, within = two_visit_patch()
    assert within < 3, "within a visit SPHEREx parallax is a few pixels at most"
    assert 60 < jump < 200, "between visits the shift is ~800 arcsec at 500 AU"


# ---------------------------------------------------------------------------
# The two-visit limitation
# ---------------------------------------------------------------------------

def test_two_visits_cannot_localise_even_a_strong_source():
    """The honest limit. An amp-8 source in unit noise is far above the noise, and the search
    still puts its peak in the wrong place, because two time samples cannot separate parallax
    from proper motion."""
    frames, mjds, obs, ra0, dec0, (x0, y0), _truth, _j, _w = two_visit_patch(amp=8.0)
    r = search(frames, mjds, obs, ra0, dec0, rates=(-0.3, 0.0, 0.3))
    miss = np.hypot(r["x"] - x0, r["y"] - y0)
    assert r["peak"] > 8, "the source is strong; this test is about position, not detectability"
    assert miss > 5, (f"two visits unexpectedly localised to {miss:.0f} px -- if this now works, "
                      "the restriction in run_patch and docs/STATUS.md should be revisited")


def test_two_visit_cross_template_stamps_negative_ghosts():
    """Why 'median of the other visits' is the wrong template at two visits.

    With V visits the source occupies 1/(V-1) of the frames in that median. At V == 2 that is
    100%: the template *is* the other visit, source included, so the residual gets a negative
    image of the source at the other visit's position. Those ghosts are signal, and the trial
    search locks onto them.
    """
    frames, mjds, obs, ra0, dec0, (x0, y0), truth, _j, _w = two_visit_patch(amp=8.0)
    prep = S.prepare(frames, dev=torch.device("cpu"), template="others")
    groups = S.visit_groups(mjds)
    xi, eta = G.trial_offsets(truth, ra0, dec0, mjds, obs, mjd_ref=mjds.mean())
    pos = [(x0 - xi[k] / SPHEREX_PIXEL_ARCSEC, y0 + eta[k] / SPHEREX_PIXEL_ARCSEC) for k in range(len(mjds))]
    v0 = [k for k in range(len(mjds)) if groups[k] == 0]
    v1 = [k for k in range(len(mjds)) if groups[k] == 1]
    p0 = tuple(int(round(c)) for c in pos[v0[len(v0) // 2]])

    mean_v1 = np.nanmean(prep.resid[groups == 1], axis=0)
    assert mean_v1[p0[1], p0[0]] < -2.0, (
        "visit 1's residual should carry a negative ghost of the source at visit 0's position")

    # The global median does not do this: the source is in only 1/V of the frames.
    prep_g = S.prepare(frames, dev=torch.device("cpu"), template="global")
    ghost_others = abs(float(np.nanmean(prep.resid[groups == 1], axis=0)[p0[1], p0[0]]))
    ghost_global = abs(float(np.nanmean(prep_g.resid[groups == 1], axis=0)[p0[1], p0[0]]))
    assert ghost_global < ghost_others


def test_prepare_rejects_an_unknown_template():
    frames, *_ = two_visit_patch()
    with pytest.raises(ValueError, match="template"):
        S.prepare(frames[:4], dev=torch.device("cpu"), template="nonsense")


# ---------------------------------------------------------------------------
# Three or more visits: the search works
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("n_visits", [3, 4])
def test_three_or_more_visits_recover_the_mover(n_visits):
    frames, mjds, obs, ra0, dec0, (x0, y0), truth = multi_visit_patch(n_visits=n_visits, amp=8.0)
    assert len(np.unique(S.visit_groups(mjds))) == n_visits
    r = search(frames, mjds, obs, ra0, dec0)
    assert abs(r["x"] - x0) <= 2 and abs(r["y"] - y0) <= 2, \
        f"peak at ({r['x']}, {r['y']}), expected ({x0}, {y0})"
    assert r["peak"] > noise_threshold(r["snr"]), "the recovered source must clear the map's own noise"
    assert np.isfinite(r["trial"].distance_au), "a stationary trial must not win over a real mover"


def test_four_visits_recover_the_distance():
    """Distance is the point of the parallax search, so check it is actually measured."""
    frames, mjds, obs, ra0, dec0, _xy, truth = multi_visit_patch(n_visits=4, amp=8.0)
    r = search(frames, mjds, obs, ra0, dec0, n_d=60)
    err = abs(r["trial"].distance_au - truth.distance_au) / truth.distance_au
    assert err < 0.10, f"recovered {r['trial'].distance_au:.0f} AU vs {truth.distance_au:.0f} AU"


def test_the_variable_stars_do_not_win():
    frames, mjds, obs, ra0, dec0, (x0, y0), _truth = multi_visit_patch(n_visits=3, amp=8.0)
    r = search(frames, mjds, obs, ra0, dec0)
    s = r["snr"]
    assert s[120, 30] < s[r["y"], r["x"]]
    assert s[40, 110] < s[r["y"], r["x"]]


# ---------------------------------------------------------------------------
# One visit
# ---------------------------------------------------------------------------

def test_single_visit_median_would_have_killed_it():
    """Documenting the failure mode: with one visit only, the global median absorbs a sub-pixel mover."""
    frames, mjds, obs, ra0, dec0, (x0, y0), truth, _, _ = two_visit_patch(amp=3.0)
    half = [f for f in frames if f.mjd < 61000]
    prep1 = S.prepare(half, dev=torch.device("cpu"))
    off = S.offsets_pixels([truth], ra0, dec0, np.array([f.mjd for f in half]), obs[: len(half)],
                           mjd_ref=np.mean([f.mjd for f in half]))
    s1, _ = S.stack_one(prep1, off[0])
    expected_if_not_subtracted = 3.0 * np.sqrt(len(half) * (frames[0].psf ** 2).sum())
    assert s1[int(y0), int(x0)] < 0.5 * expected_if_not_subtracted
