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


def cube(n=16, npix=24, sigma=0.05, seed=0):
    """Synthetic stack in which, as on SPHEREx, wavelength is unrelated to observing order."""
    rng = np.random.default_rng(seed)
    flux = rng.normal(1.0, sigma, (n, npix, npix)).astype(np.float32)
    var = np.full((n, npix, npix), sigma ** 2, np.float32)
    good = np.ones((n, npix, npix), bool)
    wave = rng.permutation(np.linspace(0.8, 4.8, n)).astype(np.float32)
    return flux, var, good, wave


# ---------------------------------------------------------------------------
# Change detection
# ---------------------------------------------------------------------------

def test_a_constant_field_scores_about_one():
    """chi2 per degree of freedom is ~1 when the only variation is the noise we modelled."""
    flux, var, good, wave = cube()
    cm = change_map(flux, var, good, wave)
    assert 0.6 < cm["median"] < 1.5
    assert cm["n_significant"] <= 1, "pure noise must not look like something happened"


def test_a_source_whose_brightness_follows_its_colour_is_not_flagged():
    """The bug that shipped first. SPHEREx sees a different wavelength in every exposure, so
    a red star is legitimately brighter in the long-wavelength frames. A constant-brightness
    model called that 'change' and lit up every star in the field. It is colour."""
    flux, var, good, wave = cube()
    flux[:, 10, 10] += (0.5 + 1.2 * wave + 0.15 * wave ** 2).astype(np.float32)   # a red star
    flux[:, 4, 17] += (3.0 - 0.4 * wave).astype(np.float32)                        # a blue one
    cm = change_map(flux, var, good, wave)
    assert cm["z"][10, 10] < CHANGE_THRESHOLD, "a star's spectrum was mistaken for change"
    assert cm["z"][4, 17] < CHANGE_THRESHOLD


def test_a_shifting_background_is_not_flagged():
    """Zodiacal light differs from frame to frame. On real data removing it took the median
    chi2/dof on Barnard's Star from 7.1 to 0.95."""
    flux, var, good, wave = cube()
    rng = np.random.default_rng(9)
    flux += rng.uniform(-0.5, 0.5, (flux.shape[0], 1, 1)).astype(np.float32)
    cm = change_map(flux, var, good, wave)
    assert cm["n_significant"] <= 1
    assert 0.6 < cm["median"] < 1.5


def test_a_source_that_moves_lights_up_both_pixels():
    """A mover leaves one pixel and enters another, so both disagree with a steady spectrum."""
    flux, var, good, wave = cube()
    flux[:8, 6, 6] += 2.0          # present in the first half of the visits...
    flux[8:, 15, 15] += 2.0        # ...and somewhere else in the second
    cm = change_map(flux, var, good, wave)
    found = {(p["x"], p["y"]) for p in change_peaks(cm)}
    assert (6, 6) in found and (15, 15) in found


def test_a_source_that_pulses_in_place_lights_up():
    flux, var, good, wave = cube()
    flux[:, 8, 3] += np.linspace(0, 3, flux.shape[0]).astype(np.float32)   # row 8, column 3
    cm = change_map(flux, var, good, wave)
    assert cm["z"][8, 3] > CHANGE_THRESHOLD                     # maps are [y, x]
    assert (3, 8) in {(p["x"], p["y"]) for p in change_peaks(cm)}   # peaks report x, y


def test_too_few_exposures_are_undefined_not_guessed():
    flux, var, good, wave = cube()
    good[3:, 0, 0] = False          # only 3 usable; a quadratic needs at least 5
    cm = change_map(flux, var, good, wave)
    assert not np.isfinite(cm["chi2_per_dof"][0, 0])
    assert cm["n_used"][0, 0] == 3


def test_flagged_values_do_not_contribute():
    flux, var, good, wave = cube()
    flux[3, 5, 5] = 1000.0          # a wild value...
    good[3, 5, 5] = False           # ...that NASA already flagged
    cm = change_map(flux, var, good, wave)
    assert cm["z"][5, 5] < CHANGE_THRESHOLD


def test_peaks_come_back_strongest_first_and_capped():
    flux, var, good, wave = cube(npix=40)
    for k, (x, y) in enumerate([(6, 6), (14, 24), (30, 9), (22, 33)]):
        flux[:8, y, x] += 1.0 + k
    cm = change_map(flux, var, good, wave)
    peaks = change_peaks(cm, max_peaks=3)
    assert len(peaks) == 3
    zs = [p["z"] for p in peaks]
    assert zs == sorted(zs, reverse=True)
    assert (22, 33) == (peaks[0]["x"], peaks[0]["y"]), "the biggest jump should rank first"


def test_without_wavelengths_it_falls_back_to_a_constant_model():
    """Callers that have no wavelength information still get a sensible answer."""
    flux, var, good, _wave = cube()
    flux[:8, 6, 6] += 2.0
    cm = change_map(flux, var, good, None)
    assert cm["z"][6, 6] > CHANGE_THRESHOLD


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


def test_a_spectrum_our_templates_explain_is_not_flagged_odd():
    res = classify_point(synth("planet"))
    assert res["unexplained"] is False
    assert res["anomaly_note"] is None
    assert res["best_chi2_per_dof"] < 5.0


def test_a_spectrum_none_of_the_templates_fit_is_flagged_odd():
    """The only honest 'anomaly' available: our three shapes all fail. That is a statement
    about our model library, not a claim about the object, and the note says so."""
    rng = np.random.default_rng(5)
    w = np.array([0.8, 1.0, 1.3, 1.6, 2.0, 2.5, 3.1, 3.9, 4.7])
    # A sawtooth no smooth template can follow, with small error bars so it cannot be noise.
    f = 1.0 + 0.8 * ((np.arange(w.size) % 2) * 2 - 1) + rng.normal(0, 0.01, w.size)
    pts = [{"wave_um": float(a), "flux_mjysr": float(b), "flux_err_mjysr": 0.01}
           for a, b in zip(w, f)]
    res = classify_point(pts)
    assert res["available"] is True
    assert res["unexplained"] is True
    assert res["best_chi2_per_dof"] > 5.0
    assert "not evidence of something new" in res["anomaly_note"]


def test_confident_and_odd_one_out_never_appear_together():
    """Winning among three shapes that all fail is not confidence. The first version showed
    both badges at once on Barnard's Star."""
    rng = np.random.default_rng(5)
    w = np.array([0.8, 1.0, 1.3, 1.6, 2.0, 2.5, 3.1, 3.9, 4.7])
    f = 1.0 + 0.8 * ((np.arange(w.size) % 2) * 2 - 1) + rng.normal(0, 0.01, w.size)
    res = classify_point([{"wave_um": float(a), "flux_mjysr": float(b), "flux_err_mjysr": 0.01}
                          for a, b in zip(w, f)])
    assert res["unexplained"] is True
    assert res["confident"] is False


def test_a_bright_star_is_not_flagged_odd_just_for_being_bright():
    """Tiny statistical error bars on a bright source would make any simple template 'fail'.
    The systematic floor stops odd-one-out firing on every bright star in the sky."""
    w = np.array([0.80, 0.95, 1.10, 1.25, 1.45, 1.70, 2.00, 2.35, 2.80, 3.30, 4.10, 4.80])
    f = 400.0 * template_fnu("star", w) * (1 + 0.04 * np.sin(5 * w))   # 4% wiggle off-model
    pts = [{"wave_um": float(a), "flux_mjysr": float(b), "flux_err_mjysr": 0.05} for a, b in zip(w, f)]
    res = classify_point(pts)
    assert res["unexplained"] is False
    assert res["best"] == "star"


def test_odd_one_out_is_judged_against_the_field_not_a_fixed_number():
    """On real SPHEREx data a fixed threshold flagged all five targets: random sky pixels have
    a median best-fit chi2/dof of 13-19. The field supplies its own yardstick."""
    rng = np.random.default_rng(5)
    w = np.array([0.8, 1.0, 1.3, 1.6, 2.0, 2.5, 3.1, 3.9, 4.7])
    f = 1.0 + 0.8 * ((np.arange(w.size) % 2) * 2 - 1) + rng.normal(0, 0.01, w.size)
    pts = [{"wave_um": float(a), "flux_mjysr": float(b), "flux_err_mjysr": 0.01} for a, b in zip(w, f)]
    misfit = classify_point(pts)["best_chi2_per_dof"]
    assert classify_point(pts, odd_threshold=misfit - 1)["unexplained"] is True
    assert classify_point(pts, odd_threshold=misfit + 1)["unexplained"] is False
    assert classify_point(pts, odd_threshold=misfit + 1)["odd_threshold"] == pytest.approx(misfit + 1)


def test_field_threshold_is_calibrated_from_the_fields_own_points(tmp_path):
    """Build a tiny bundle where most pixels are ordinary and check the threshold lands in
    their distribution, not at the fixed fallback."""
    import json
    from deepfield.sky.analyse import UNEXPLAINED_CHI2, field_odd_threshold
    from deepfield.spectral.templates import template_fnu
    rng = np.random.default_rng(2)
    n, npix = 12, 24
    wave = np.linspace(0.8, 4.8, n).astype(np.float32)
    base = (3.0 * template_fnu("star", wave)).astype(np.float32)
    flux = (base[:, None, None] * rng.uniform(0.5, 2.0, (1, npix, npix))
            + rng.normal(0, 0.05, (n, npix, npix))).astype(np.float32)
    np.savez_compressed(tmp_path / "cube.npz", flux=flux, var=np.full_like(flux, 0.0025),
                        good=np.ones_like(flux, bool), mjd=np.linspace(60800, 61100, n), wave_um=wave,
                        bandwidth_um=np.full(n, 0.01, np.float32), detector=np.ones(n, np.int16),
                        visit=np.arange(n, dtype=np.int16), obs_id=np.array(["o"] * n, dtype=object))
    (tmp_path / "sky.json").write_text(json.dumps({
        "slug": "t", "ra_deg": 10.0, "dec_deg": 0.0, "fov_deg": 0.04, "npix": npix, "source": "test",
        "wcs": {"ctype": ["RA---TAN", "DEC--TAN"], "crval": [10.0, 0.0],
                "crpix": [npix / 2 + 0.5, npix / 2 + 0.5], "cdelt": [-6.15 / 3600, 6.15 / 3600]}}))
    out = field_odd_threshold(tmp_path, n_sample=60)
    assert out["n_sampled"] >= 20
    assert out["odd_percentile"] == 95.0
    assert out["odd_threshold"] != UNEXPLAINED_CHI2
    assert out["odd_threshold"] >= out["field_median_chi2_per_dof"]


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
