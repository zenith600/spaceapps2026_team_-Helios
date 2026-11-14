"""Proper-motion measurement (deepfield.sky.motion) on synthetic views with a known answer.

The real-data check -- Barnard's Star 10.39 +/- 0.54"/yr against Gaia DR3's 10.39, Epsilon
Indi Ba 4.49 +/- 0.30 against 4.68 -- needs the downloaded cubes and lives in docs/STATUS.md.
These tests pin the method itself, offline.
"""
from __future__ import annotations

import json
import math

import numpy as np
import pytest

from deepfield.sky import motion as M

PIX = 6.15
NPIX = 41


def _make_bundle(tmp_path, *, vx_px_yr=1.7, vy_px_yr=-0.4, amp=40.0, noise=1.0, seed=1,
                 n_visits=8, per_visit=3, x0=20.3, y0=19.6, span_days=400.0, star=True):
    """A view with one Gaussian star moving at (vx, vy) px/yr over `span_days`."""
    rng = np.random.default_rng(seed)
    n = n_visits * per_visit
    Y, X = np.mgrid[0:NPIX, 0:NPIX]
    flux = np.empty((n, NPIX, NPIX), np.float32)
    mjd = np.empty(n)
    visit = np.empty(n, int)
    t_mid = 60800 + span_days / 2
    for v in range(n_visits):
        t = 60800 + span_days * v / (n_visits - 1)
        for k in range(per_visit):
            i = v * per_visit + k
            mjd[i], visit[i] = t + 0.05 * k, v
            dt = (mjd[i] - t_mid) / 365.25
            xs, ys = x0 + vx_px_yr * dt, y0 + vy_px_yr * dt
            img = 5.0 + rng.normal(0, noise, (NPIX, NPIX))      # a sky level that each frame must lose
            if star:
                img += amp * np.exp(-((X - xs) ** 2 + (Y - ys) ** 2) / (2 * 0.6 ** 2))
            flux[i] = img
    var = np.full_like(flux, noise ** 2)
    good = np.ones_like(flux, bool)
    np.savez(tmp_path / "cube.npz", flux=flux, var=var, good=good, mjd=mjd, visit=visit,
             wave_um=np.linspace(0.75, 5.0, n), detector=np.ones(n, int), bandwidth_um=np.full(n, 0.02),
             obs_id=np.array([f"o{i}" for i in range(n)]))
    meta = {"slug": "synthetic", "pixel_arcsec": PIX, "npix": NPIX, "ra_deg": 10.0, "dec_deg": 20.0, "fov_deg": NPIX * PIX / 3600,
            "wcs": {"ctype": ["RA---TAN", "DEC--TAN"], "crval": [10.0, 20.0], "crpix": [21.0, 21.0],
                    "cdelt": [-PIX / 3600, PIX / 3600]}, "coverage": {"mjd_min": 60800, "mjd_max": 60800 + span_days},
            "target": {"name": "synthetic"}}
    (tmp_path / "sky.json").write_text(json.dumps(meta))
    return tmp_path


def test_recovers_a_known_motion_within_its_errors(tmp_path):
    d = _make_bundle(tmp_path)
    m = M.measure_motion(d, 20, 20)
    assert m["available"], m.get("reason")
    pm = m["pm"]
    # +x is west, so RA* motion is -vx * pixel scale; +y is north.
    assert pm["pmra_arcsec_yr"] == pytest.approx(-1.7 * PIX, abs=3 * pm["err_pmra"] + 0.05)
    assert pm["pmdec_arcsec_yr"] == pytest.approx(-0.4 * PIX, abs=3 * pm["err_pmdec"] + 0.05)
    assert pm["err_pmra"] < 0.5                       # a bright source is measured well
    assert len(m["visits"]) == 8


def test_static_star_is_consistent_with_zero(tmp_path):
    m = M.measure_motion(_make_bundle(tmp_path, vx_px_yr=0.0, vy_px_yr=0.0), 20, 20)
    assert m["available"]
    assert m["pm"]["total_arcsec_yr"] < 3 * m["pm"]["err_total"] + 0.05


def test_position_angle_and_comparison_follow_the_sky_convention(tmp_path):
    # Moving +y only: due north, PA 0. A reference that matches must "agree".
    m = M.measure_motion(_make_bundle(tmp_path, vx_px_yr=0.0, vy_px_yr=2.0), 20, 20,
                         reference={"pmra_mas": 0.0, "pmdec_mas": 2.0 * PIX * 1000, "source": "test"})
    assert min(m["pm"]["pa_deg"], 360 - m["pm"]["pa_deg"]) < 5
    assert m["comparison"]["agrees"] is True
    wrong = M.attach_reference(dict(m), {"pmra_mas": 5000.0, "pmdec_mas": 0.0, "source": "test"})
    assert wrong["comparison"]["agrees"] is False


def test_refuses_rather_than_inventing_a_measurement(tmp_path):
    m = M.measure_motion(_make_bundle(tmp_path, star=False), 20, 20)
    assert m["available"] is False and "no source" in m["reason"]
    few = M.measure_motion(_make_bundle(tmp_path, n_visits=2, per_visit=2), 20, 20)
    assert few["available"] is False and "visit" in few["reason"]


def test_motion_route_measures_and_serves_the_baked_file(tmp_path, monkeypatch):
    import os
    os.environ.setdefault("DEMO_MODE", "1")
    os.environ.setdefault("DATA_DIR", "data/samples")
    os.environ.setdefault("SQLITE_PATH", ":memory:")
    from fastapi.testclient import TestClient

    from deepfield.sky import service as SVC
    from deepfield_api.main import app

    root = tmp_path / "sky"
    (root / "synthetic").mkdir(parents=True)
    _make_bundle(root / "synthetic")
    monkeypatch.setattr(SVC, "SKY_DIR", root)
    monkeypatch.setattr(M, "gaia_reference", lambda *a, **k: None)   # offline
    with TestClient(app) as client:
        live = client.get("/sky/motion/synthetic", params={"x": 20, "y": 20}).json()
        assert live["available"] and live["pm"]["pmra_arcsec_yr"] < 0          # moving west
        assert client.get("/sky/motion/synthetic", params={"x": 20}).status_code == 400
        M.write_motion(root / "synthetic")
        baked = client.get("/sky/motion/synthetic").json()
        assert baked["pm"] == M.motion_for_bundle(root / "synthetic")["pm"]


def test_does_not_measure_the_centre_when_the_centre_is_known_not_to_be_the_target(tmp_path):
    """WISE 0855's view is the brief's 2010 position; whatever sits there now is another star,
    and reporting its motion would read as WISE 0855 standing still."""
    d = _make_bundle(tmp_path)
    meta = json.loads((d / "sky.json").read_text())
    meta["target"] = {"name": "WISE 0855-0714", "slug": "wise-0855", "resolver": "builtin"}
    (d / "sky.json").write_text(json.dumps(meta))
    m = M.motion_for_bundle(d)
    assert m["available"] is False and "not at the centre" in m["reason"]
    assert M.motion_for_bundle(d, 20, 20)["available"] is True     # an explicit position is still measured


def test_shift_and_baseline_are_reported(tmp_path):
    m = M.measure_motion(_make_bundle(tmp_path, vx_px_yr=1.5, vy_px_yr=0.0, span_days=365.25), 20, 20)
    assert m["baseline_days"] == pytest.approx(365.25, abs=0.2)
    assert m["shift_px"] == pytest.approx(1.5, abs=0.2)
    assert math.isfinite(m["fit"]["x0"])
