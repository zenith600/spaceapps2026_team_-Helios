"""API route tests against the committed SAMPLE bundle, with an in-memory SQLite store."""
import os

import pytest

os.environ["DEMO_MODE"] = "1"
os.environ["DATA_DIR"] = "data/samples"
os.environ["SQLITE_PATH"] = ":memory:"
os.environ["TASK_SEED"] = "7"

from fastapi.testclient import TestClient  # noqa: E402

from deepfield_api.main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["bundle"] == "SAMPLE"


def test_map(client):
    r = client.get("/map")
    assert r.status_code == 200
    j = r.json()
    assert 0 < j["frac_excluded_prior"] < 1
    assert j["frac_excluded_total"] >= j["frac_excluded_prior"]
    assert j["n_patches_searched"] == 3
    assert len(j["cells"]) > 100
    assert {"hpix", "ra_deg", "dec_deg", "p_remaining", "searched"} <= set(j["cells"][0])
    assert "source" in j and "explanation" in j


def test_candidates_and_detail(client):
    r = client.get("/candidates")
    j = r.json()
    assert r.status_code == 200 and len(j["candidates"]) == 12
    c0 = j["candidates"][0]
    for k in ("candidate_id", "is_simulated", "snr_stack", "snr_single_max", "methane_score", "stamps", "source"):
        assert k in c0
    assert c0["stamps"]["stack"].startswith("stamps/")
    r = client.get(f"/candidates/{c0['candidate_id']}")
    d = r.json()
    assert r.status_code == 200
    assert len(d["spectrum"]) > 0 and "wavelength_um" in d["spectrum"][0]
    assert d["dossier"]["candidate_id"] == c0["candidate_id"]
    assert d["dossier"]["is_simulated"] == c0["is_simulated"]
    r = client.get("/candidates?patch=P001&include_simulated=false")
    assert all(not c["is_simulated"] for c in r.json()["candidates"])
    assert client.get("/candidates/NOPE").status_code == 404


def test_static_files(client):
    c = client.get("/candidates").json()["candidates"][0]
    r = client.get("/files/" + c["stamps"]["stack"])
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    r = client.get(c["dossier_url"])
    assert r.status_code == 200


def test_task_and_vote_flow(client):
    r = client.get("/task", params={"display_name": "tester"})
    assert r.status_code == 200
    t = r.json()
    assert "is_simulated" not in t["candidate"], "task must be blind"
    assert "truth" not in t
    uid, tid = t["user_id"], t["task_id"]
    r = client.post("/vote", json={"user_id": uid, "task_id": tid, "answer": "real", "click_x": 0.5, "click_y": 0.5})
    assert r.status_code == 200
    v = r.json()
    assert v["user"]["n_votes"] == 1
    assert "map" in v and "frac_excluded_total" in v["map"]
    if v["is_test"]:
        assert "correct" in v and "reveal" in v
    else:
        assert 0 < v["consensus"]["p_real"] < 1 and v["consensus"]["n_votes"] == 1
    # double vote is rejected
    assert client.post("/vote", json={"user_id": uid, "task_id": tid, "answer": "real"}).status_code == 409
    # wrong user rejected
    r2 = client.get("/task", params={"user_id": uid}).json()
    assert client.post("/vote", json={"user_id": "someone-else", "task_id": r2["task_id"], "answer": "real"}).status_code == 403
    # bad answer rejected by validation
    assert client.post("/vote", json={"user_id": uid, "task_id": r2["task_id"], "answer": "maybe"}).status_code == 422


def test_many_votes_hit_tests_and_move_counter(client):
    uid = None
    seen_test = False
    before = client.get("/map", params={"cells": False}).json()["frac_excluded_total"]
    for _ in range(40):
        t = client.get("/task", params={"user_id": uid}).json()
        uid = t["user_id"]
        v = client.post("/vote", json={"user_id": uid, "task_id": t["task_id"], "answer": "real"}).json()
        seen_test |= v["is_test"]
    assert seen_test, "10% test-card rate should surface at least one test in 40 draws"
    after = client.get("/map", params={"cells": False}).json()
    assert after["n_votes"] >= 40
    assert after["frac_excluded_total"] >= before
    lb = client.get("/leaderboard").json()["users"]
    assert any(u["id"] == uid for u in lb)


def test_completeness_and_manifest(client):
    j = client.get("/completeness").json()
    assert {"axis", "bin_lo", "fraction"} <= set(j["rows"][0])
    m = client.get("/manifest").json()
    assert any(d["id"] == "spherex_dr1" for d in m["datasets"])
