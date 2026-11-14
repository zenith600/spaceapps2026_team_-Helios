import numpy as np
import pytest

from deepfield.stack import geometry as G


def circular_observer(mjds, mjd0=60000.0):
    """Earth-like circular orbit in the ecliptic (ICRS-ish, ignoring obliquity): 1 AU, 365.25 d."""
    ph = 2 * np.pi * (np.asarray(mjds) - mjd0) / 365.25
    return np.stack([np.cos(ph), np.sin(ph), np.zeros_like(ph)], axis=1)


def test_unit_vectors_and_tangent_basis_orthonormal():
    n = G.unit_vector(64.7, 13.2)
    e, nn = G.tangent_basis(64.7, 13.2)
    assert np.allclose([n @ n, e @ e, nn @ nn], 1)
    assert abs(n @ e) < 1e-12 and abs(n @ nn) < 1e-12 and abs(e @ nn) < 1e-12
    assert np.cross(e, nn) @ n > 0  # right-handed: east x north = outward


def test_parallax_amplitude_half_year():
    """An object at 500 AU seen at quadrature should shift by ~2 AU / 500 AU over half a year (~825\")."""
    mjds = np.array([60000.0, 60000.0 + 365.25 / 2])
    obs = circular_observer(mjds)
    ra0, dec0 = 90.0, 0.0  # line of sight along +y, observer at +x then -x: pure parallax
    xi, eta = G.trial_offsets(G.Trial(500.0), ra0, dec0, mjds, obs, mjd_ref=mjds[0])
    sep = np.hypot(xi[1] - xi[0], eta[1] - eta[0])
    expected = np.degrees(2 / 500.0) * 3600
    assert sep == pytest.approx(expected, rel=0.01)


def test_offsets_zero_at_reference_and_scale_with_inverse_distance():
    mjds = np.linspace(60907.6, 60914.0, 10)
    obs = circular_observer(mjds)
    for d in (300.0, 600.0):
        xi, eta = G.trial_offsets(G.Trial(d), 64.7, 13.2, mjds, obs, mjd_ref=mjds[0])
        assert abs(xi[0]) < 1e-9 and abs(eta[0]) < 1e-9
    xi3, eta3 = G.trial_offsets(G.Trial(300.0), 64.7, 13.2, mjds, obs, mjd_ref=mjds[0])
    xi6, eta6 = G.trial_offsets(G.Trial(600.0), 64.7, 13.2, mjds, obs, mjd_ref=mjds[0])
    r3, r6 = np.hypot(xi3[-1], eta3[-1]), np.hypot(xi6[-1], eta6[-1])
    assert r3 / r6 == pytest.approx(2.0, rel=0.01)
    # over ~6 days at quadrature-ish geometry the shift is tens of arcsec: enough to matter at 6" pixels
    assert 10 < r6 < 200


def test_rates_add_linearly_and_stationary_trial_has_none():
    mjds = np.array([60000.0, 60010.0])
    obs = circular_observer(mjds)
    xi, eta = G.trial_offsets(G.Trial(np.inf, 1.0, -0.5), 10.0, 10.0, mjds, obs, mjd_ref=60000.0)
    assert xi[1] == pytest.approx(10.0) and eta[1] == pytest.approx(-5.0)


def test_heliocentric_from_apparent_has_requested_distance():
    obs = np.array([0.9, 0.3, 0.1])
    P = G.heliocentric_from_apparent(64.7, 13.2, obs, 450.0)
    assert np.linalg.norm(P) == pytest.approx(450.0)
    rel = P - obs
    ra = np.degrees(np.arctan2(rel[1], rel[0])) % 360
    assert ra == pytest.approx(64.7, abs=1e-6)


def test_radec_offset_roundtrip():
    ra, dec = G.radec_offset(64.7, 13.2, 36.0, -72.0)
    assert dec == pytest.approx(13.2 - 0.02)
    assert (ra - 64.7) * np.cos(np.radians(13.2)) * 3600 == pytest.approx(36.0, rel=1e-6)


def test_trial_grid_contains_stationary_once():
    grid = G.default_trial_grid()
    stat = [t for t in grid if not np.isfinite(t.distance_au)]
    assert len(stat) == 1 and stat[0].rate_ra_arcsec_day == 0
    assert len(grid) == 8 * 25 + 1
