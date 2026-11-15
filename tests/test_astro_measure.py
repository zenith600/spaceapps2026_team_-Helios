"""Variability, motion and source classification: numerical behaviour on controlled synthetic cases."""
from __future__ import annotations

import math

import numpy as np
import pytest

from deepfield.astro import motion_sky as M
from deepfield.astro import sources as SRC
from deepfield.astro import stats as S
from deepfield.astro import variability as V


def _sampling(rng, n_visits=6, per_visit=8):
    """SPHEREx-like: each visit samples random wavelengths, and visits overlap in wavelength."""
    lam, visit = [], []
    for v in range(n_visits):
        lam += list(rng.uniform(0.75, 5.0, per_visit))
        visit += [v] * per_visit
    return np.array(lam), np.array(visit)


def test_steep_constant_spectrum_is_not_called_variable_by_the_primary_test():
    rng = np.random.default_rng(1)
    p_primary, p_lrt = [], []
    for _ in range(60):
        lam, visit = _sampling(rng)
        F = 100.0 * (lam / 2.0) ** 3.0
        err = 0.02 * F
        Fobs = F + rng.normal(0, err)
        t = V.variability_test(lam, Fobs, err, visit, f_sys=0.01)
        if t["testable"]:
            p_primary.append(t["p_primary"])
            p_lrt.append(t["p_lrt"])
    assert len(p_primary) > 30
    assert np.mean(np.array(p_primary) < 0.0027) < 0.05          # calibrated: ~0.27 % expected
    assert np.mean(np.array(p_lrt) < 0.0027) > 0.5               # the model-based test fails here (why it is secondary)


def test_a_visit_to_visit_change_is_detected():
    rng = np.random.default_rng(2)
    hits = 0
    n = 0
    for _ in range(40):
        lam, visit = _sampling(rng)
        g = 1 + 0.3 * np.sin(visit * 1.7)
        F = 50.0 * (lam / 2.0) ** -1.0 * g
        err = 0.01 * F
        t = V.variability_test(lam, F + rng.normal(0, err), err, visit, f_sys=0.0)
        if t["testable"]:
            n += 1
            hits += t["p_primary"] < 0.0027
    assert n > 20 and hits / n > 0.8


def test_no_matched_wavelengths_means_inconclusive():
    lam = np.array([0.8, 0.85, 0.9, 2.0, 2.1, 2.2, 4.0, 4.2, 4.4])
    visit = np.array([0, 0, 0, 1, 1, 1, 2, 2, 2])
    t = V.variability_test(lam, np.ones(9), np.full(9, 0.01), visit)
    assert t["testable"] is False and t["verdict"] == "inconclusive"


def test_floor_calibration_returns_the_injected_scatter_level():
    rng = np.random.default_rng(3)
    stars = []
    for _ in range(40):
        lam, visit = _sampling(rng, 4, 6)
        F = 80 * (lam / 2) ** -0.5
        err = 0.005 * F
        stars.append((lam, F * (1 + rng.normal(0, 0.04, len(F))) + rng.normal(0, err), err, visit))
    f = V.calibrate_floor(stars)["f_sys"]
    assert 0.025 <= f <= 0.06


def test_motion_fit_recovers_known_pm_and_parallax_with_honest_errors():
    rng = np.random.default_rng(4)
    z = []
    for _ in range(200):
        t = np.sort(rng.uniform(-0.6, 0.6, 12))
        P = np.stack([np.sin(2 * np.pi * t), 0.5 * np.cos(2 * np.pi * t)], 1)
        mu, px = np.array([1.2, -0.7]), 0.3
        sig = 0.15
        y = mu[None, :] * t[:, None] + px * P + rng.normal(0, sig, (12, 2))
        f = M.fit_motion(t, y[:, 0], y[:, 1], [np.eye(2) * sig ** 2] * 12, P, parallax_mode="free", scale_by_chi2=False)
        z.append(S.mahalanobis2(np.asarray(f["pm_arcsec_yr"]) - mu, np.asarray(f["cov_pm"])))
        assert f["parallax_fitted"]
    cov = S.coverage_2d(z)["empirical"]
    assert abs(cov[0] - 0.683) < 0.07 and abs(cov[1] - 0.954) < 0.04


def test_compare_pm_is_a_proper_chi2_statistic():
    fit = {"pm_arcsec_yr": [0.010, 0.0], "cov_pm": [[1e-4, 0], [0, 1e-4]]}
    c = M.compare_pm(fit, [0.0, 0.0], np.zeros((2, 2)))
    assert abs(c["d2"] - 1.0) < 1e-9 and abs(c["p"] - math.exp(-0.5)) < 1e-9 and c["consistent"]
    far = M.compare_pm({"pm_arcsec_yr": [0.05, 0.0], "cov_pm": [[1e-4, 0], [0, 1e-4]]}, [0.0, 0.0], np.zeros((2, 2)))
    assert not far["consistent"]


def test_zero_point_rejects_an_outlier_star():
    rows = [{"class": "confirmed", "match": str(i), "dxi": 0.1 + 0.01 * i, "deta": -0.05, "cov_total": [[0.01, 0], [0, 0.01]]} for i in range(8)]
    rows.append({"class": "confirmed", "match": "x", "dxi": 5.0, "deta": 5.0, "cov_total": [[0.01, 0], [0, 0.01]]})
    zp = M.exposure_zero_point(rows)
    assert zp["n"] == 8 and abs(zp["mean"][0] - 0.135) < 0.01


def test_galaxy_is_never_inferred_from_a_missing_gaia_match():
    unresolved = {"resolved": False, "n": 4, "p_point_combined": 0.4, "median_blur_px": 0.0}
    c = SRC.classify(unresolved, [])
    assert "galaxy" not in c["class"] and c["confidence"] == "low"
    ned_gal = [{"catalog": "ned", "type": "G", "id": "NGC 1", "separation_arcsec": 1.0}]
    assert SRC.classify(unresolved, ned_gal)["class"].startswith("galaxy: catalogue match, unresolved")
    resolved = {"resolved": True, "n": 4, "p_point_combined": 1e-9, "median_blur_px": 1.2}
    assert SRC.classify(resolved, ned_gal)["confidence"] == "high"
    star = [{"catalog": "gaia", "parallax_over_error": 12.0, "id": "Gaia DR3 1", "separation_arcsec": 0.2}]
    assert SRC.classify(resolved, ned_gal + star)["class"].startswith("ambiguous")


def test_fisher_combination():
    assert SRC.fisher_combine([1.0, 1.0]) == pytest.approx(1.0)
    assert SRC.fisher_combine([1e-4, 1e-4, 1e-4]) < 1e-8


def test_injection_population_is_reproducible_from_its_seed():
    from deepfield.validation.inject import population
    cfg = {"snr_range": [2, 300], "pm_range_arcsec_yr": [0.5, 12], "var_amplitudes": [0.1], "var_period_days": [30, 400],
           "steep_beta": [3], "blur_px": [1.0], "blend_sep_px": [0.6, 2.5], "batch_size": 12}
    counts = {"static": 5, "moving": 5, "blend": 2}
    a = population(np.random.default_rng(9), (150.0, 2.0), 200, 60000, 0.1, counts, cfg)
    b = population(np.random.default_rng(9), (150.0, 2.0), 200, 60000, 0.1, counts, cfg)
    assert [(s.id, s.ra0, s.dec0, s.pm, s.flux0) for s in a] == [(s.id, s.ra0, s.dec0, s.pm, s.flux0) for s in b]
    assert sum(s.kind == "blend_partner" for s in a) == 2
