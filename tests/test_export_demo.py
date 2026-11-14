"""Exporting the Planet X bundle must not destroy what other steps own, and must leave the
API able to serve everything the web app asks for.

Both of these were real failures:

* `export()` rmtree'd the whole web demo folder, which silently deleted `sky/` -- the five
  baked challenge targets, several MB of real IRSA data that take minutes to rebuild.
* The globe texture was written only into the web folder, never into the bundle. The API
  serves /files out of the bundle, so in API mode the home page asked for
  /files/map_equirect.png, got a 404, and the Three.js globe threw and took the page down.
"""
from __future__ import annotations

import json
import os

import pytest

os.environ.setdefault("DEMO_MODE", "1")
os.environ.setdefault("DATA_DIR", "data/samples")
os.environ.setdefault("SQLITE_PATH", ":memory:")

from fastapi.testclient import TestClient  # noqa: E402

from deepfield.config import REPO_ROOT  # noqa: E402
from deepfield.export_demo import MAP_TEXTURE, PRESERVE, export  # noqa: E402
from deepfield_api.main import app  # noqa: E402

SAMPLES = REPO_ROOT / "data" / "samples"


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# The exporter must not delete other steps' output
# ---------------------------------------------------------------------------

def test_export_preserves_the_baked_sky_bundles(tmp_path):
    out = tmp_path / "demo"
    sky = out / "sky" / "ra133.7951-dec-7.2451-fov0.100"
    sky.mkdir(parents=True)
    (sky / "sky.json").write_text('{"slug": "keep me"}')
    (sky / "cube.u16").write_bytes(b"\x01\x02\x03\x04")
    (out / "sky" / "index.json").write_text('{"targets": []}')
    stale = out / "candidates.json"
    stale.write_text("stale content this export should replace")

    export(SAMPLES, out)

    assert (sky / "sky.json").read_text() == '{"slug": "keep me"}', "a baked sky bundle was destroyed"
    assert (sky / "cube.u16").read_bytes() == b"\x01\x02\x03\x04"
    assert (out / "sky" / "index.json").exists()
    assert "stale content" not in stale.read_text(), "the exporter should still refresh its own files"


def test_export_still_clears_its_own_stale_output(tmp_path):
    out = tmp_path / "demo"
    (out / "stamps" / "GHOST").mkdir(parents=True)
    (out / "stamps" / "GHOST" / "stack.png").write_bytes(b"old")
    export(SAMPLES, out)
    assert not (out / "stamps" / "GHOST").exists(), "a candidate removed from the bundle lingered"


def test_sky_is_the_only_preserved_name():
    """If this grows, every entry needs the same reasoning: owned by another step, expensive."""
    assert PRESERVE == ("sky",)


def test_export_into_a_fresh_directory_works(tmp_path):
    out = tmp_path / "brand-new"
    info = export(SAMPLES, out)
    assert info["candidates"] > 0
    assert (out / "map.json").exists()
    assert (out / MAP_TEXTURE).exists()


# ---------------------------------------------------------------------------
# The bundle must carry everything the API has to serve
# ---------------------------------------------------------------------------

def test_the_sample_bundle_carries_the_globe_texture():
    assert (SAMPLES / MAP_TEXTURE).exists(), (
        "data/samples has no globe texture, so the API cannot serve /files/map_equirect.png "
        "and the home page globe 404s in API mode")
    assert (SAMPLES / MAP_TEXTURE).stat().st_size > 1000


def test_api_serves_the_globe_texture(client):
    r = client.get(f"/files/{MAP_TEXTURE}")
    assert r.status_code == 200, "the globe texture must be reachable through the API"
    assert r.headers["content-type"] == "image/png"
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_api_serves_every_stamp_the_candidates_reference(client):
    """Whatever /candidates hands the UI as a URL has to actually resolve."""
    rows = client.get("/candidates").json()["candidates"]
    assert rows
    checked = 0
    for c in rows[:3]:
        for rel in [c["stamps"]["stack"], c["stamps"]["static"], *c["stamps"]["singles"][:2]]:
            assert client.get(f"/files/{rel}").status_code == 200, rel
            checked += 1
    assert checked > 0


def test_stamp_tensors_are_exported_in_the_shape_the_model_expects(tmp_path):
    """The browser classifier needs the same normalised float stamps training used.
    Display PNGs are 8-bit and stretched, so scoring them would mean scoring a picture."""
    import numpy as np
    out = tmp_path / "demo"
    info = export(SAMPLES, out)
    assert info["browser_model"]["tensors"] > 0
    rows = json.loads((out / "candidates.json").read_text())["candidates"]
    with_tensor = [c for c in rows if c.get("tensor")]
    assert with_tensor, "candidates.json must advertise each tensor's path"
    for c in with_tensor[:3]:
        raw = (out / c["tensor"]).read_bytes()
        arr = np.frombuffer(raw, dtype=np.float32)
        assert arr.size == 3 * 32 * 32, f"{c['candidate_id']}: wrong tensor size"
        assert np.isfinite(arr).all()


def test_tensors_match_what_training_feeds_the_network(tmp_path):
    """Exactly the normalisation `load_stamp_set` applies -- not an approximation of it."""
    import numpy as np
    from deepfield.ml.model import load_stamp_set
    out = tmp_path / "demo"
    export(SAMPLES, out)
    c = next(c for c in json.loads((out / "candidates.json").read_text())["candidates"] if c.get("tensor"))
    shipped = np.frombuffer((out / c["tensor"]).read_bytes(), dtype=np.float32).reshape(3, 32, 32)
    expected = load_stamp_set(SAMPLES / "stamps" / c["candidate_id"]).astype(np.float32)
    assert np.array_equal(shipped, expected)


def test_api_serves_the_dossiers_it_advertises(client):
    rows = client.get("/candidates").json()["candidates"]
    for c in rows[:3]:
        r = client.get(c["dossier_url"])
        assert r.status_code == 200, c["dossier_url"]
        assert json.loads(r.content)["candidate_id"] == c["candidate_id"]
