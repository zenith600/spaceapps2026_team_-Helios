"""Deep Field API. GET /map, /candidates, /task, POST /vote, plus static files for stamps/dossiers."""
from __future__ import annotations

import os
import random
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from deepfield.crowd import consensus as C
from deepfield_api.bundle import get_bundle, records
from deepfield_api.store import make_store

DEMO_MODE = os.environ.get("DEMO_MODE", "1") == "1"

from contextlib import asynccontextmanager


@asynccontextmanager
async def _lifespan(app_: FastAPI):
    root = get_bundle().root
    app_.mount("/files", StaticFiles(directory=str(root)), name="files")
    yield


app = FastAPI(title="Deep Field API", version="0.1.0", lifespan=_lifespan,
              description="Planet X x SPHEREx shift-and-stack search. NASA Space Apps 2026.")
app.add_middleware(CORSMiddleware,
                   allow_origins=[o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",")],
                   allow_methods=["*"], allow_headers=["*"])

store = make_store()
_rng = random.Random(int(os.environ.get("TASK_SEED", "0")) or None)


def bundle():
    return get_bundle()


# ---------------------------------------------------------------------------
# Map + counter
# ---------------------------------------------------------------------------

def compute_map_summary() -> dict:
    b = bundle()
    meta = b.prior_meta
    frac_prior = float(meta.get("frac_excluded_prior", 0.0))
    frac_df_full = float(meta.get("frac_excluded_deepfield", 0.0))  # if every patch were fully crowd-verified
    credits = store.patch_credits()
    targets = records(b.targets)
    searched = [t for t in targets if t["status"] == "searched"]
    # Each searched patch contributes an equal share of the Deep Field exclusion, scaled by crowd verification.
    per_patch = frac_df_full / max(len(searched), 1)
    verified = 0.0
    patch_rows = []
    for t in searched:
        credit = C.patch_credit(credits.get(t["patch_id"], 0.0))
        verified += per_patch * credit
        patch_rows.append({**t, "crowd_credit": credit, "exclusion_share": per_patch})
    surviving_total = 1.0 - frac_prior
    frac_df_abs = surviving_total * verified          # as a fraction of the whole population
    frac_total = frac_prior + frac_df_abs
    return {
        "frac_excluded_prior": frac_prior,
        "frac_excluded_deepfield": frac_df_abs,
        "frac_excluded_deepfield_potential": surviving_total * frac_df_full,
        "frac_excluded_total": frac_total,
        "n_patches_searched": len(searched),
        "n_votes": store.total_votes(),
        "patches": patch_rows,
        "bundle_kind": b.kind,
        "population_version": meta.get("population_version"),
        "epoch_mjd": meta.get("epoch_mjd"),
        "nside": int(meta.get("nside", 32)),
        "source": meta.get("data_source"),
        "explanation": ("Prior exclusion comes from the ZTF, DES and Pan-STARRS flags in the Caltech reference population. "
                        "Deep Field exclusion counts reference planets that crossed a searched patch brighter than our measured "
                        "completeness limit, credited as the crowd verifies each patch's injected test cards."),
    }


@app.get("/health")
def health():
    b = bundle()
    return {"ok": True, "demo_mode": DEMO_MODE, "bundle": b.kind, "data_dir": str(b.root), "n_candidates": int(len(b.candidates))}


@app.get("/map")
def get_map(cells: bool = True):
    s = compute_map_summary()
    if cells:
        b = bundle()
        df = b.prior_map[["hpix", "ra_deg", "dec_deg", "p_surviving", "p_remaining", "searched"]]
        s["cells"] = records(df[df.p_surviving > 0])
    return s


@app.get("/targets")
def get_targets():
    b = bundle()
    return {"targets": records(b.targets), "source": b.targets_meta.get("data_source")}


# ---------------------------------------------------------------------------
# Candidates
# ---------------------------------------------------------------------------

def _enrich(c: dict) -> dict:
    b = bundle()
    cons = store.get_consensus(c["candidate_id"], c.get("ml_score") or c.get("rule_score") or 0.5)
    c = {**c, "crowd_p_real": float(cons["p_real"]), "n_votes": int(cons["n_votes"]),
         "stamps": b.stamp_files(c["candidate_id"]), "dossier_url": f"/files/{c['dossier_path']}"}
    return c


@app.get("/candidates")
def get_candidates(patch: str | None = None, include_simulated: bool = True, limit: int = 100):
    b = bundle()
    df = b.candidates
    if patch:
        df = df[df.patch_id == patch]
    if not include_simulated:
        df = df[~df.is_simulated]
    df = df.sort_values(["is_simulated", "snr_stack"], ascending=[False, False]).head(limit)
    return {"candidates": [_enrich(c) for c in records(df)], "source": b.candidates_meta.get("data_source"),
            "n_total": int(len(b.candidates))}


@app.get("/candidates/{candidate_id}")
def get_candidate(candidate_id: str):
    b = bundle()
    c = b.candidate(candidate_id)
    if c is None:
        raise HTTPException(404, "unknown candidate")
    return {"candidate": _enrich(c), "spectrum": b.spectrum(candidate_id), "dossier": b.dossier(candidate_id),
            "spectrum_source": b.spectra_meta.get("data_source")}


@app.get("/completeness")
def get_completeness():
    b = bundle()
    return {"rows": records(b.completeness), "source": b.completeness_meta.get("data_source")}


@app.get("/manifest")
def get_manifest():
    return bundle().manifest()


# ---------------------------------------------------------------------------
# Crowd
# ---------------------------------------------------------------------------

class VoteIn(BaseModel):
    user_id: str
    task_id: str
    answer: str = Field(pattern="^(real|artifact|nothing)$")
    click_x: float | None = None
    click_y: float | None = None


def _pick_candidate(user_id: str) -> tuple[dict, bool, str | None]:
    """Choose the next card: ~10% secret tests, otherwise the most AI-uncertain unseen live candidate."""
    b = bundle()
    seen = store.seen_candidates(user_id)
    rows = records(b.candidates)
    tests = [c for c in rows if b.test_truth(c["candidate_id"]) is not None]
    live = [c for c in rows if b.test_truth(c["candidate_id"]) is None and c["candidate_id"] not in seen]
    want_test = C.is_test_card(_rng.random()) or not live
    if want_test and tests:
        unseen_tests = [c for c in tests if c["candidate_id"] not in seen] or tests
        c = _rng.choice(unseen_tests)
        return c, True, b.test_truth(c["candidate_id"])
    if not live:
        live = [c for c in rows if b.test_truth(c["candidate_id"]) is None] or rows
    live.sort(key=lambda c: abs((c.get("ml_score") or 0.5) - 0.5))
    return live[0], False, None


@app.get("/task")
def get_task(user_id: str | None = Query(default=None), display_name: str | None = None):
    u = store.get_or_create_user(user_id, display_name)
    c, is_test, truth = _pick_candidate(u.id)
    tid = store.create_task(u.id, c["candidate_id"], is_test, truth)
    b = bundle()
    public = {k: c[k] for k in ("candidate_id", "patch_id", "n_epochs", "n_bands", "snr_stack", "snr_single_max",
                                "best_distance_au", "ml_score", "source")}
    # Never reveal is_simulated / truth before the answer: the card is "blind".
    return {"task_id": tid, "user_id": u.id, "candidate": public, "stamps": b.stamp_files(c["candidate_id"]),
            "prompt": "Blink the frames, then look at the stack. Is there a real mover?",
            "user": {"points": u.points, "reliability": u.skill.reliability, "n_test": u.skill.n_test, "n_votes": u.n_votes}}


@app.post("/vote")
def post_vote(v: VoteIn):
    task = store.get_task(v.task_id)
    if task is None:
        raise HTTPException(404, "unknown task")
    if task["user_id"] != v.user_id:
        raise HTTPException(403, "task belongs to another user")
    if task["answered"]:
        raise HTTPException(409, "task already answered")
    b = bundle()
    cand = b.candidate(task["candidate_id"])
    if cand is None:
        raise HTTPException(404, "candidate vanished")
    u = store.get_or_create_user(v.user_id)
    is_test, truth = bool(task["is_test"]), task["truth"]
    weight = C.vote_weight(u.skill)
    click = (v.click_x, v.click_y) if v.click_x is not None and v.click_y is not None else None
    store.record_vote(u.id, v.task_id, cand["candidate_id"], v.answer, click, weight)
    store.mark_answered(v.task_id)

    result: dict = {"candidate_id": cand["candidate_id"], "is_test": is_test, "answer": v.answer}
    if is_test:
        u.skill = C.update_skill(u.skill, v.answer, truth)
        correct = C.normalise_answer(v.answer) == C.normalise_answer(truth)
        result.update({"truth": truth, "correct": correct,
                       "reveal": {"is_simulated": bool(cand["is_simulated"]), "injected_mag": cand.get("injected_mag"),
                                  "injected_distance_au": cand.get("injected_distance_au"), "status": cand["status"]}})
        # crowd verification of this patch's injections drives the counter
        if correct and cand["is_simulated"]:
            store.add_patch_credit(cand["patch_id"], max(weight, 0.1))
    else:
        cons = store.get_consensus(cand["candidate_id"], cand.get("ml_score") or cand.get("rule_score") or 0.5)
        p_new = C.update_probability(float(cons["p_real"]), v.answer, u.skill)
        store.save_consensus(cand["candidate_id"], p_new, int(cons["n_votes"]) + 1, float(cons["weighted_votes"]) + weight)
        result["consensus"] = {"p_real": p_new, "n_votes": int(cons["n_votes"]) + 1}
    pts = C.points_for(v.answer, truth if is_test else None)
    u.points += pts
    u.n_votes += 1
    store.save_user(u)
    result["points_awarded"] = pts
    result["user"] = {"points": u.points, "reliability": u.skill.reliability, "n_test": u.skill.n_test, "n_votes": u.n_votes}
    result["map"] = {k: v_ for k, v_ in compute_map_summary().items() if k.startswith("frac_") or k == "n_votes"}
    return result


@app.get("/leaderboard")
def leaderboard():
    return {"users": store.leaderboard(10)}
