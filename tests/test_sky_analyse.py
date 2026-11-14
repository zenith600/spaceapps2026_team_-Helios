"""Change detection and spectral classification: the two things the viewer infers from data.

Both are deliberately untrained methods, so the tests are about whether the maths says what
we claim it says -- a constant source scores ~1, a mover scores high, a methane spectrum is
recognised, a noisy one refuses to be confident.
"""
from __future__ import annotations

import numpy as np
import pytest

from deepfield.sky.analyse import (CHANGE_THRESHOLD, change_map, change_peaks, classify_point,
                                   fit_temperature)
from deepfield.spectral.templates import template_fnu


def cube(n=10, npix=16, sigma=0.05, seed=0):
    rng = np.random.default_rng(seed)
    flux = rng.normal(1.0, sigma, (n, npix, npix)).astype(np.float32)
    var = np.full((n, npix, npix), sigma ** 2, np.float32)
    good = np.ones((n, npix, npix), bool)
    return flux, var, good


# ---------------------------------------------------------------------------
# Change detection
# ---------------------------------------------------------------------------

def test_a_constant_field_scores_about_one():
    """chi2 per degree of freedom is 1 when the only variation is the noise we modelled."""
    flux, var, good = cube()
    cm = change_map(flux, var, good)
    assert 0.6 < cm["median"] < 1.5
    assert cm["n_significant"] == 0, "pure noise must not look like something happened"


def test_a_source_that_moves_lights_up_both_pixels():
    """A mover leaves one pixel and enters another, so both disagree with 'constant'."""
    flux, var, good = cube(n=12, sigma=0.05)
    flux[:6, 4, 4] += 2.0          # present in the first half
    flux[6:, 9, 9] += 2.0          # and somewhere else in the second
    cm = change_map(flux, var, good)
    assert cm["chi2_per_dof"][4, 4] > CHANGE_THRESHOLD
    assert cm["chi2_per_dof"][9, 9] > CHANGE_THRESHOLD
    peaks = change_peaks(cm)
    found = {(p["x"], p["y"]) for p in peaks}
    assert (4, 4) in found and (9, 9) in found


def test_a_source_that_pulses_in_place_lights_up():
    flux, var, good = cube(n=12, sigma=0.05)
    flux[:, 8, 3] += np.linspace(0, 3, 12).astype(np.float32)   # row 8, column 3
    cm = change_map(flux, var, good)
    assert cm["chi2_per_dof"][8, 3] > CHANGE_THRESHOLD          # maps are [y, x]
    peaks = change_peaks(cm)
    assert (3, 8) in {(p["x"], p["y"]) for p in peaks}          # peaks report x, y


def test_pixels_seen_fewer_than_three_times_are_undefined_not_guessed():
    flux, var, good = cube(n=10)
    good[2:, 0, 0] = False          # only 2 usable
    cm = change_map(flux, var, good)
    assert not np.isfinite(cm["chi2_per_dof"][0, 0])
    assert cm["n_used"][0, 0] == 2


def test_flagged_values_do_not_contribute():
    flux, var, good = cube(n=10, sigma=0.05)
    flux[3, 5, 5] = 1000.0          # a wild value...
    good[3, 5, 5] = False           # ...that NASA already flagged
    cm = change_map(flux, var, good)
    assert cm["chi2_per_dof"][5, 5] < CHANGE_THRESHOLD


def test_peaks_come_back_strongest_first_and_capped():
    flux, var, good = cube(n=12, sigma=0.05, npix=32)
    rng = np.random.default_rng(1)
    for k, (x, y) in enumerate([(5, 5), (12, 20), (25, 8), (18, 28)]):
        flux[: 6, y, x] += 1.0 + k
    cm = change_map(flux, var, good)
    peaks = change_peaks(cm, max_peaks=3)
    assert len(peaks) == 3
    vals = [p["chi2_per_dof"] for p in peaks]
    assert vals == sorted(vals, reverse=True)


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

def synth(kind, waves=None, scale=3.0, noise=0.02, seed=3):
    rng = np.random.default_rng(seed)
    w = np.array(waves if waves is not None else
                 [0.80, 0.95, 1.10, 1.25, 1.45, 1.70, 2.00, 2.35, 2.80, 3.30, 4.10, 4.80])
    f = scale * template_fnu(kind, w) + rng.normal(0, noise, w.size)
    return [{"wave_um": float(a), "flux_mjysr": float(b), "flux_err_mjysr": float(max(noise, 1e-3))}
            for a, b in zip(w, f)]


@pytest.mark.parametrize("kind", ["planet", "asteroid", "star"])
def test_a_clean_template_is_recognised(kind):
    res = classify_point(synth(kind))
    assert res["available"] is True
    assert res["best"] == kind
    assert res["confident"] is True


def test_methane_score_is_high_for_the_methane_template_and_low_otherwise():
    assert classify_point(synth("planet"))["methane_score"] > 0.9
    assert classify_point(synth("star"))["methane_score"] < 0.1


def test_too_few_colours_refuses_rather_than_guessing():
    pts = [{"wave_um": 1.0 + 0.001 * i, "flux_mjysr": 1.0, "flux_err_mjysr": 0.1} for i in range(5)]
    res = classify_point(pts)
    assert res["available"] is False
    assert "three" in res["reason"]


def test_no_points_at_all():
    assert classify_point([])["available"] is False


def test_very_noisy_data_is_not_called_confident():
    res = classify_point(synth("star", noise=2.0))
    assert res["available"] is True
    assert res["confident"] is False, "a fit this noisy must not claim to have decided"


def test_every_verdict_carries_its_method_and_caveat():
    res = classify_point(synth("planet"))
    assert "trained" in res["method"] and "templates" in res["method"]
    assert "not an identification" in res["caveat"]


# ---------------------------------------------------------------------------
# Colour temperature
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("T", [300.0, 1200.0, 5000.0])
def test_blackbody_temperature_is_recovered(T):
    from deepfield.spectral.templates import planck_nu
    w = np.array([0.9, 1.2, 1.6, 2.1, 2.8, 3.6, 4.6])
    f = 7.0 * planck_nu(w, T) / planck_nu(w, T).max()
    got = fit_temperature(w, f, np.full(w.size, 0.01))["temperature_k"]
    assert abs(got - T) / T < 0.2, f"recovered {got} K for a {T} K source"


def test_temperature_needs_three_distinct_colours():
    w = np.array([1.0, 1.0005, 1.001])
    out = fit_temperature(w, np.ones(3), np.full(3, 0.1))
    assert out["temperature_k"] is None
