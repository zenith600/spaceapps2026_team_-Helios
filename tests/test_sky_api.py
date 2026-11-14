"""Sky Viewer routes, plus the service maths that does not need the network.

The heavy path (fetch from IRSA) is exercised by building a synthetic bundle on disk
rather than downloading, so these tests run offline and in seconds.
"""
from __future__ import annotations

import json
import os

import numpy as np
import pytest

os.environ.setdefault("DEMO_MODE", "1")
os.environ.setdefault("DATA_DIR", "data/samples")
os.environ.setdefault("SQLITE_PATH", ":memory:")

from fastapi.testclient import TestClient  # noqa: E402

from deepfield.sky import releases as REL  # noqa: E402
from deepfield.sky import render as RENDER  # noqa: E402
from deepfield.sky import service as SVC  # noqa: E402
from deepfield_api.main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# Request shaping
# ---------------------------------------------------------------------------

def test_npix_follows_field_of_view():
    """0.1 deg at 6.15 arcsec/px is 58.5 px -> 59, odd so there is a centre pixel."""
    assert SVC.SkyRequest(10.0, 10.0, 0.1).npix == 59
    assert SVC.SkyRequest(10.0, 10.0, 0.05).npix == 29
    for fov in (0.02, 0.05, 0.1, 0.25, 0.5):
        assert SVC.SkyRequest(10.0, 10.0, fov).npix % 2 == 1


def test_cutout_is_requested_larger_than_the_display_field():
    """Reprojection onto a rotated grid needs margin, or the corners come back empty."""
    r = SVC.SkyRequest(10.0, 10.0, 0.1)
    assert r.cutout_deg > r.fov_deg


@pytest.mark.parametrize("ra,dec,fov", [(-1, 0, 0.1), (0, 91, 0.1), (0, 0, 0.9), (0, 0, 0.001)])
def test_out_of_range_requests_are_refused(ra, dec, fov):
    with pytest.raises(ValueError):
        SVC.SkyRequest(ra, dec, fov)


def test_slug_is_positional_so_a_name_and_its_coordinates_share_one_bundle():
    """Searching "WISE 0855" and typing its coordinates must hit the same cached view."""
    from deepfield.sky.resolver import resolve
    named = SVC.SkyRequest(133.795129, -7.245147, 0.1, target=resolve("WISE 0855", allow_network=False))
    typed = SVC.SkyRequest(133.795129, -7.245147, 0.1)
    assert named.slug == typed.slug
    assert "wise" not in named.slug.lower()


def test_slug_separates_different_fields_of_view_and_positions():
    a = SVC.SkyRequest(133.79513, -7.245147, 0.1)
    assert a.slug == SVC.SkyRequest(133.79513, -7.245147, 0.1).slug
    assert a.slug != SVC.SkyRequest(133.79513, -7.245147, 0.2).slug
    assert a.slug != SVC.SkyRequest(133.79513, +7.245147, 0.1).slug, "sign of Dec must matter"
    assert "133.7951" in a.slug and "-7.2451" in a.slug


def test_slug_rounds_sub_pixel_differences_together():
    """0.36 arcsec apart is the same patch of sky at 6.15 arcsec pixels."""
    assert SVC.SkyRequest(133.79513, -7.245147, 0.1).slug == \
           SVC.SkyRequest(133.795131, -7.2451468, 0.1).slug


# ---------------------------------------------------------------------------
# Exposure selection
# ---------------------------------------------------------------------------

def _fake_exposures(n_visits=4, per_visit=30) -> "object":
    import pandas as pd
    rows = []
    for v in range(n_visits):
        t0 = 60800.0 + 180.0 * v
        for i in range(per_visit):
            rows.append({"obs_id": f"V{v}_{i:03d}", "detector": 1 + (i % 6), "collection": "spherex_dr1",
                         "t_min": t0 + i * 0.01, "t_max": t0 + i * 0.01 + 0.001, "visit": v})
    return pd.DataFrame(rows)


def test_selection_keeps_every_visit():
    """Motion lives in the time baseline, so thin inside visits -- never drop one."""
    df = _fake_exposures(n_visits=11, per_visit=30)
    sel = SVC.select_exposures(df, max_frames=12, per_visit=16)
    assert sel["visit"].nunique() == 11, "a whole visit was dropped to meet the frame budget"


def test_a_visit_never_collapses_to_a_single_arbitrary_detector():
    """R Draconis has 31 visits; a flat budget of 48 gave each one exposure, which means
    one detector, which means one wavelength picked at random. Blinking that shows band
    changes masquerading as variability -- on a Mira variable, the worst possible place
    for that artefact."""
    df = _fake_exposures(n_visits=31, per_visit=18)
    sel = SVC.select_exposures(df, max_frames=48, per_visit=16)
    per_visit = sel.groupby("visit").size()
    assert per_visit.min() >= SVC.MIN_PER_VISIT
    assert sel["visit"].nunique() == 31


def test_selection_respects_the_hard_cap():
    df = _fake_exposures(n_visits=80, per_visit=20)
    sel = SVC.select_exposures(df, max_frames=48, per_visit=16, hard_cap=100)
    assert len(sel) <= 100


def test_selection_does_not_invent_exposures_a_visit_does_not_have():
    df = _fake_exposures(n_visits=5, per_visit=1)
    sel = SVC.select_exposures(df, max_frames=48, per_visit=16)
    assert len(sel) == 5


def test_selection_spreads_within_a_visit():
    df = _fake_exposures(n_visits=1, per_visit=40)
    sel = SVC.select_exposures(df, max_frames=8, per_visit=8)
    assert len(sel) == 8
    gaps = np.diff(sel["t_min"].to_numpy())
    assert gaps.std() < gaps.mean(), "picks are clumped instead of spread in time"


def test_selection_handles_an_empty_table():
    import pandas as pd
    assert len(SVC.select_exposures(pd.DataFrame(), 10, 5)) == 0


# ---------------------------------------------------------------------------
# Combination maths
# ---------------------------------------------------------------------------

def _frame(value, var, good=True, npix=8, visit=0, detector=1, mjd=60800.0, wave=1.5):
    import pandas as pd

    class _C:
        pass
    c = _C()
    c.obs_id, c.detector, c.mjd, c.wave_um, c.bandwidth_um, c.psf_fwhm_arcsec = "X", detector, mjd, wave, 0.01, 7.5
    return SVC.LoadedFrame(
        row=pd.Series({"collection": "spherex_dr1", "visit": visit}), cutout=c,
        image=np.full((npix, npix), value, np.float32), variance=np.full((npix, npix), var, np.float32),
        good=np.full((npix, npix), good, bool), flags=np.zeros((npix, npix), np.int64), visit=visit)


def test_coadd_is_inverse_variance_weighted():
    """A noisy frame must not pull the mean as hard as a clean one."""
    img, var, n = SVC.coadd([_frame(10.0, 1.0), _frame(20.0, 4.0)])
    assert n == 2
    assert img[0, 0] == pytest.approx((10 / 1 + 20 / 4) / (1 / 1 + 1 / 4))   # = 12.0
    assert var[0, 0] == pytest.approx(1 / (1 / 1 + 1 / 4))                   # < either input


def test_coadd_beats_a_single_frame_on_noise():
    frames = [_frame(10.0, 1.0) for _ in range(9)]
    _img, var, _ = SVC.coadd(frames)
    assert var[0, 0] == pytest.approx(1 / 9)


def test_coadd_ignores_flagged_pixels():
    img, _var, _ = SVC.coadd([_frame(10.0, 1.0), _frame(1000.0, 1.0, good=False)])
    assert img[0, 0] == pytest.approx(10.0)


def test_coadd_yields_nan_where_nothing_was_good():
    img, _var, _ = SVC.coadd([_frame(10.0, 1.0, good=False)])
    assert np.isnan(img).all()


def test_coadd_refuses_an_empty_set():
    with pytest.raises(ValueError):
        SVC.coadd([])


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def test_one_stretch_is_shared_so_frames_do_not_flicker():
    """Frames of the same sky at different noise must map to the same grey level."""
    a, b = np.full((4, 4), 5.0), np.full((4, 4), 5.0)
    vmin, vmax = RENDER.robust_limits([a, b])
    assert (RENDER.stretch(a, vmin, vmax) == RENDER.stretch(b, vmin, vmax)).all()


def test_robust_limits_survive_all_nan():
    lo, hi = RENDER.robust_limits([np.full((4, 4), np.nan)])
    assert np.isfinite(lo) and np.isfinite(hi) and hi > lo


def test_stretch_is_monotonic_and_bounded():
    v = RENDER.stretch(np.linspace(-5, 20, 50), 0.0, 10.0)
    assert (np.diff(v) >= -1e-9).all()
    assert v.min() >= 0.0 and v.max() <= 1.0


def test_flag_summary_reports_only_present_bits(tmp_path):
    from deepfield.data.spherex import FLAG_BITS
    flags = np.zeros((10, 10), np.int64)
    flags[0:5, :] = FLAG_BITS["SOURCE"]
    s = RENDER.flag_summary(flags)
    assert s == {"SOURCE": 0.5}
    p = RENDER.write_flag_png(flags, tmp_path / "f.png", source="test")
    assert p.exists()


def test_png_round_trips_with_provenance(tmp_path):
    from PIL import Image
    arr = np.random.default_rng(0).normal(size=(12, 12))
    arr[0, 0] = np.nan
    p = RENDER.write_png(arr, tmp_path / "a.png", source="NASA SPHEREx via IRSA", vmin=-1, vmax=1)
    im = Image.open(p)
    assert im.size == (12, 12)
    assert "SPHEREx" in im.text["source"]
    assert im.getpixel((0, 11)) == 0, "NaN should render black"   # (0,0) flipped to the bottom row


# ---------------------------------------------------------------------------
# Release discovery
# ---------------------------------------------------------------------------

def test_searchable_pattern_excludes_non_image_products():
    ok = ["spherex_dr1", "spherex_qr3", "spherex_dr2"]
    no = ["spherex_dr1_cal", "spherex_dr1_cube", "spherex_dr1_deep", "spitzer_sha"]
    for c in ok:
        assert REL.SEARCHABLE_RE.match(c), c
    for c in no:
        assert not REL.SEARCHABLE_RE.match(c), c


def test_compare_detects_new_exposures_and_new_releases():
    built = {"spherex_dr1": {"n": 282, "latest_mjd": 61174.29}}
    now = {"spherex_dr1": {"n": 310, "latest_mjd": 61200.0},
           "spherex_dr2": {"n": 120, "latest_mjd": 61250.0}}
    d = REL.compare(built, now)
    assert d["new_exposures"] == 28 + 120
    assert d["new_collections"] == ["spherex_dr2"]
    assert d["stale"] is True
    assert d["latest_mjd"] == 61250.0


def test_compare_is_quiet_when_nothing_changed():
    snap = {"spherex_dr1": {"n": 282, "latest_mjd": 61174.29}}
    d = REL.compare(snap, snap)
    assert d["new_exposures"] == 0 and d["stale"] is False


def test_discovery_falls_back_without_network(monkeypatch):
    monkeypatch.setattr(REL, "_query_tap", lambda timeout: (_ for _ in ()).throw(RuntimeError("down")))
    monkeypatch.setattr(REL, "CACHE_PATH", REL.CACHE_PATH.parent / "does-not-exist.json")
    info = REL.discover(force=True)
    assert info["searchable"] == list(REL.FALLBACK)
    assert "fallback" in info["source"]


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

def test_targets_route_lists_the_five_test_targets(client):
    r = client.get("/sky/targets")
    assert r.status_code == 200
    body = r.json()
    names = {t["name"] for t in body["targets"] if t["featured"]}
    assert names == {"Barnard's Star", "Epsilon Indi Ba/Bb", "WISE 0855-0714",
                     "RW Aurigae", "R Draconis"}
    assert body["fov_range"] == [SVC.FOV_MIN, SVC.FOV_MAX]


def test_resolve_route_offline(client):
    r = client.get("/sky/resolve", params={"q": "WISE 0855", "network": False})
    assert r.status_code == 200
    assert r.json()["ra_deg"] == pytest.approx(133.795129)


def test_resolve_route_parses_the_briefs_sexagesimal(client):
    r = client.get("/sky/resolve", params={"q": "08 55 10.831 -07 14 42.53", "network": False})
    assert r.status_code == 200
    assert r.json()["resolver"] == "coords"
    assert r.json()["ra_deg"] == pytest.approx(133.795129, abs=1e-4)


def test_resolve_route_404s_on_nonsense(client):
    r = client.get("/sky/resolve", params={"q": "zzzz not an object", "network": False})
    assert r.status_code == 404


def test_unknown_bundle_404s(client):
    assert client.get("/sky/bundle/nope").status_code == 404
    assert client.get("/sky/spectrum/nope", params={"x": 1, "y": 1}).status_code == 404


def test_bundle_slug_cannot_escape_the_data_directory(client):
    for bad in ("../../etc", "a/b", "..\\..\\x"):
        assert client.get(f"/sky/bundle/{bad}").status_code in (400, 404)


def test_job_validation_rejects_a_bad_field_of_view(client):
    r = client.post("/sky/jobs", json={"ra_deg": 10, "dec_deg": 10, "fov_deg": 5.0})
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# A synthetic bundle on disk: serving, spectra, freshness
# ---------------------------------------------------------------------------

@pytest.fixture
def fake_bundle(tmp_path, monkeypatch):
    """A complete bundle written by hand, so the read path can be tested offline."""
    slug = SVC.SkyRequest(10.0, 20.0, 0.1).slug
    d = tmp_path / slug
    (d / "frames").mkdir(parents=True)
    npix, n = 9, 5
    rng = np.random.default_rng(3)
    flux = rng.normal(0, 0.1, (n, npix, npix)).astype(np.float32)
    flux[:, 4, 4] += np.array([1.0, 2.0, 3.0, 2.0, 1.0], np.float32)      # a peak at the centre
    np.savez_compressed(
        d / "cube.npz", flux=flux, var=np.full((n, npix, npix), 0.01, np.float32),
        good=np.ones((n, npix, npix), bool), mjd=np.linspace(60800, 61100, n),
        wave_um=np.array([0.9, 1.4, 2.1, 2.1, 4.2], np.float32),
        bandwidth_um=np.full(n, 0.01, np.float32), detector=np.array([1, 2, 3, 3, 6], np.int16),
        visit=np.array([0, 1, 2, 2, 3], np.int16),
        obs_id=np.array([f"OBS{i}" for i in range(n)], dtype=object))
    (d / "frames" / "e000.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    (d / "sky.json").write_text(json.dumps({
        "schema_version": 1, "slug": slug, "ra_deg": 10.0, "dec_deg": 20.0, "fov_deg": 0.1,
        "npix": npix, "source": "NASA SPHEREx via IRSA", "generated_at": "2026-11-14T00:00:00+00:00",
        "wcs": {"ctype": ["RA---TAN", "DEC--TAN"], "crval": [10.0, 20.0],
                "crpix": [npix / 2 + 0.5, npix / 2 + 0.5], "cdelt": [-6.15 / 3600, 6.15 / 3600]},
        "coverage": {"n_used": n, "n_bands": 4, "bands_total": 102},
        "freshness": {"built_from": {"spherex_dr1": {"n": 100, "latest_mjd": 61100.0}},
                      "built_at": "2026-11-14T00:00:00+00:00"},
        "frames": {"epochs": [], "detectors": [], "visits": []},
    }))
    monkeypatch.setattr(SVC, "SKY_DIR", tmp_path)
    import deepfield_api.sky as API_SKY
    monkeypatch.setattr(API_SKY.SVC, "SKY_DIR", tmp_path)
    return slug, d


def test_bundle_is_served(client, fake_bundle):
    slug, _ = fake_bundle
    r = client.get(f"/sky/bundle/{slug}")
    assert r.status_code == 200
    assert r.json()["file_base"] == f"/sky/files/{slug}"


def test_files_are_served_and_traversal_is_blocked(client, fake_bundle):
    slug, _ = fake_bundle
    assert client.get(f"/sky/files/{slug}/frames/e000.png").status_code == 200
    assert client.get(f"/sky/files/{slug}/../../../etc/passwd").status_code in (400, 404)


def test_spectrum_returns_one_point_per_exposure_sorted_by_wavelength(client, fake_bundle):
    slug, _ = fake_bundle
    r = client.get(f"/sky/spectrum/{slug}", params={"x": 4, "y": 4, "r": 0})
    assert r.status_code == 200
    s = r.json()
    assert s["n_points"] == 5
    assert s["n_bands"] == 4, "two exposures share 2.1 um, so 5 points are 4 distinct bands"
    waves = [p["wave_um"] for p in s["points"]]
    assert waves == sorted(waves)
    assert s["points"][0]["wave_um"] == 0.9
    assert s["bands_total"] == 102


def test_spectrum_box_average_reduces_the_error(client, fake_bundle):
    slug, _ = fake_bundle
    one = client.get(f"/sky/spectrum/{slug}", params={"x": 4, "y": 4, "r": 0}).json()
    box = client.get(f"/sky/spectrum/{slug}", params={"x": 4, "y": 4, "r": 1}).json()
    assert box["points"][0]["n_pixels"] == 9
    assert box["points"][0]["flux_err_mjysr"] < one["points"][0]["flux_err_mjysr"]


def test_spectrum_off_field_is_a_400(client, fake_bundle):
    slug, _ = fake_bundle
    assert client.get(f"/sky/spectrum/{slug}", params={"x": 999, "y": 0}).status_code == 400


def test_spectrum_reports_sky_coordinates_of_the_pixel(client, fake_bundle):
    slug, _ = fake_bundle
    s = client.get(f"/sky/spectrum/{slug}", params={"x": 4, "y": 4}).json()
    assert s["ra_deg"] == pytest.approx(10.0, abs=1e-3)
    assert s["dec_deg"] == pytest.approx(20.0, abs=1e-3)


# ---------------------------------------------------------------------------
# Pixel quality: a saturated core is an instrumental limit, not an empty panel
# ---------------------------------------------------------------------------

@pytest.fixture
def saturated_bundle(tmp_path, monkeypatch):
    """A bundle whose centre is flagged in every exposure, like a star that saturates.

    R Draconis does exactly this on real data: 0 of 91 exposures are usable at the centre
    pixel, 26 at 5 px out, 75 at 8 px out. SPHEREx zeroes and flags the saturated core.
    """
    slug = SVC.SkyRequest(40.0, 10.0, 0.1).slug
    d = tmp_path / slug
    d.mkdir(parents=True)
    npix, n = 21, 8
    rng = np.random.default_rng(11)
    flux = rng.normal(1.0, 0.05, (n, npix, npix)).astype(np.float32)
    good = np.ones((n, npix, npix), bool)
    c = npix // 2
    good[:, c - 2:c + 3, c - 2:c + 3] = False          # the flagged core, every exposure
    flag_class = np.zeros((npix, npix), np.uint16)
    flag_class[c - 2:c + 3, c - 2:c + 3] = (1 << 0) | (1 << 3)      # source + bad_pixel
    np.savez_compressed(
        d / "cube.npz", flux=flux, var=np.full((n, npix, npix), 0.01, np.float32), good=good,
        flag_class=flag_class, mjd=np.linspace(60800, 61100, n),
        wave_um=np.linspace(1.0, 4.0, n).astype(np.float32),
        bandwidth_um=np.full(n, 0.01, np.float32), detector=np.arange(n, dtype=np.int16) % 6 + 1,
        visit=np.arange(n, dtype=np.int16), obs_id=np.array([f"O{i}" for i in range(n)], dtype=object))
    (d / "sky.json").write_text(json.dumps({
        "schema_version": 1, "slug": slug, "ra_deg": 40.0, "dec_deg": 10.0, "fov_deg": 0.1,
        "npix": npix, "source": "NASA SPHEREx via IRSA", "generated_at": "2026-11-14T00:00:00+00:00",
        "wcs": {"ctype": ["RA---TAN", "DEC--TAN"], "crval": [40.0, 10.0],
                "crpix": [npix / 2 + 0.5, npix / 2 + 0.5], "cdelt": [-6.15 / 3600, 6.15 / 3600]},
        "coverage": {"n_used": n, "n_bands": n, "bands_total": 102},
        "pixel_quality": {"flag_class": [int(v) for v in flag_class.ravel()],
                          "classes": ["source", "transient", "artifact", "bad_pixel"], "note": ""},
        "freshness": {"built_from": {}, "built_at": ""},
        "frames": {"epochs": [], "detectors": [], "visits": []},
    }))
    monkeypatch.setattr(SVC, "SKY_DIR", tmp_path)
    import deepfield_api.sky as API_SKY
    monkeypatch.setattr(API_SKY.SVC, "SKY_DIR", tmp_path)
    return slug, d, npix, n


def test_saturated_core_explains_itself(client, saturated_bundle):
    """Clicking the obvious bright blob must say why there is nothing, not just return nothing."""
    slug, _d, npix, n = saturated_bundle
    c = npix // 2
    s = client.get(f"/sky/spectrum/{slug}", params={"x": c, "y": c, "r": 0}).json()
    assert s["n_points"] == 0
    assert s["n_exposures"] == n and s["n_excluded"] == n
    q = s["quality"]
    assert q["n_usable"] == 0
    assert q["saturated"] is True
    assert "saturate" in q["reason"]
    assert "bad_pixel" in q["flags"]


def test_saturated_core_points_at_a_usable_pixel(client, saturated_bundle):
    slug, _d, npix, n = saturated_bundle
    c = npix // 2
    q = client.get(f"/sky/spectrum/{slug}", params={"x": c, "y": c, "r": 0}).json()["quality"]
    near = q["nearest_usable"]
    assert near is not None
    assert near["n_usable"] >= n // 2
    assert max(abs(near["dx"]), abs(near["dy"])) == 3, "the flagged core is 5 px across"
    assert near["distance_arcsec"] > 0
    # and that pixel really does give a spectrum
    s2 = client.get(f"/sky/spectrum/{slug}", params={"x": near["x"], "y": near["y"], "r": 0}).json()
    assert s2["n_points"] == n
    assert s2["quality"]["reason"] is None


def test_a_healthy_pixel_says_nothing(client, saturated_bundle):
    """No nagging on pixels that are fine."""
    slug, _d, npix, _n = saturated_bundle
    s = client.get(f"/sky/spectrum/{slug}", params={"x": 1, "y": 1, "r": 0}).json()
    assert s["quality"]["reason"] is None
    assert s["quality"]["nearest_usable"] is None
    assert s["n_excluded"] == 0


def test_partially_flagged_pixel_reports_how_many_survived(client, saturated_bundle, tmp_path):
    slug, d, npix, n = saturated_bundle
    with np.load(d / "cube.npz", allow_pickle=True) as z:
        data = {k: z[k] for k in z.files}
    good = data["good"]
    good[: n - 2, 0, 0] = False          # only 2 of 8 usable at (0,0)
    data["good"] = good
    np.savez_compressed(d / "cube.npz", **data)
    s = client.get(f"/sky/spectrum/{slug}", params={"x": 0, "y": 0, "r": 0}).json()
    assert s["n_points"] == 2
    assert s["quality"]["n_usable"] == 2
    assert "Only 2 of 8" in s["quality"]["reason"]
    assert s["quality"]["saturated"] is False


def test_freshness_flags_new_data(client, fake_bundle, monkeypatch):
    slug, _ = fake_bundle
    import deepfield_api.sky as API_SKY
    API_SKY._FRESH.pop(slug, None)
    monkeypatch.setattr(API_SKY.SVC.REL, "coverage_snapshot",
                        lambda *a, **k: {"spherex_dr1": {"n": 140, "latest_mjd": 61300.0}})
    r = client.get(f"/sky/bundle/{slug}/freshness")
    assert r.status_code == 200
    body = r.json()
    assert body["new_exposures"] == 40
    assert body["stale"] is True
    assert body["slug"] == slug


# ---------------------------------------------------------------------------
# The background refresher
# ---------------------------------------------------------------------------

def test_freshness_is_cached_so_pollers_do_not_hammer_irsa(client, fake_bundle, monkeypatch):
    """Many clients polling must not become many SIA2 queries against someone else's archive."""
    slug, _ = fake_bundle
    import deepfield_api.sky as API_SKY
    API_SKY._FRESH.pop(slug, None)
    calls = []
    monkeypatch.setattr(API_SKY.SVC.REL, "coverage_snapshot",
                        lambda *a, **k: (calls.append(1), {"spherex_dr1": {"n": 140, "latest_mjd": 61300.0}})[1])

    first = client.get(f"/sky/bundle/{slug}/freshness").json()
    assert first["cached"] is False and len(calls) == 1
    for _ in range(5):
        again = client.get(f"/sky/bundle/{slug}/freshness").json()
        assert again["cached"] is True
    assert len(calls) == 1, "a cached answer still queried IRSA"

    forced = client.get(f"/sky/bundle/{slug}/freshness", params={"force": True}).json()
    assert forced["cached"] is False and len(calls) == 2


def test_sweep_records_new_releases_and_stale_views(fake_bundle, monkeypatch):
    """A whole new collection appearing must be noticed, not just new exposures."""
    slug, _ = fake_bundle
    import deepfield_api.sky as API_SKY
    API_SKY._FRESH.pop(slug, None)
    monkeypatch.setattr(API_SKY.REL, "discover", lambda **kw: {
        "all": ["spherex_dr1", "spherex_dr2"] if kw.get("force") else ["spherex_dr1"],
        "searchable": ["spherex_dr1"], "discovered_at": "", "source": "test", "stale_cache": False})
    monkeypatch.setattr(API_SKY.SVC.REL, "coverage_snapshot",
                        lambda *a, **k: {"spherex_dr1": {"n": 400, "latest_mjd": 61400.0}})

    state = API_SKY.refresh_sweep()
    assert state["new_releases"] == ["spherex_dr2"]
    assert slug in state["stale"]
    # The sweep covers every built view, which here includes the five baked targets.
    assert state["n_checked"] >= 1
    assert API_SKY._FRESH[slug]["new_exposures"] == 300


def test_sweep_survives_one_bad_bundle(fake_bundle, monkeypatch):
    slug, _ = fake_bundle
    import deepfield_api.sky as API_SKY
    monkeypatch.setattr(API_SKY.SVC, "bundle_freshness",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("IRSA down")))
    state = API_SKY.refresh_sweep()
    assert state["n_checked"] == 0 and state["n_stale"] == 0


def test_auto_rebuild_is_off_by_default():
    """Spending bandwidth and disk without being asked should take a deliberate switch."""
    import deepfield_api.sky as API_SKY
    assert API_SKY.AUTO_REBUILD is False


def test_refresher_can_be_disabled(monkeypatch):
    import deepfield_api.sky as API_SKY
    monkeypatch.setattr(API_SKY, "REFRESH_MINUTES", 0.0)
    assert API_SKY.start_refresher() is False


def test_releases_route_reports_the_refresher(client):
    import deepfield_api.sky as API_SKY
    body = client.get("/sky/releases").json()
    assert "searchable" in body and "refresher" in body
    assert body["refresher"]["interval_minutes"] == API_SKY.REFRESH_MINUTES


# ---------------------------------------------------------------------------
# Cross-language agreement
# ---------------------------------------------------------------------------

def test_slug_format_matches_the_typescript_port():
    """lib/sky.ts computes slugs independently; if the formats drift, DEMO mode and the
    API address different bundles for the same request. The TS side asserts these exact
    strings in apps/web/lib/sky.test.ts."""
    assert SVC.SkyRequest(133.795129, -7.245147, 0.1).slug == "ra133.7951-dec-7.2451-fov0.100"
    assert SVC.SkyRequest(269.45207696, 4.69336497, 0.1).slug == "ra269.4521-dec+4.6934-fov0.100"
