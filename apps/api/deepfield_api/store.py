"""Crowd store: users, votes, consensus. SQLite by default; Supabase when configured.

Both backends expose the same small interface so routes don't care. The Supabase
schema is supabase/migrations/0001_init.sql and mirrors the SQLite one.
"""
from __future__ import annotations

import os
import sqlite3
import threading
import time
import uuid
from dataclasses import dataclass

from deepfield.crowd.consensus import Skill

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, display_name TEXT, points INTEGER DEFAULT 0,
  real_correct REAL DEFAULT 0, real_seen REAL DEFAULT 0, bogus_correct REAL DEFAULT 0, bogus_seen REAL DEFAULT 0,
  n_votes INTEGER DEFAULT 0, created_at REAL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, user_id TEXT, candidate_id TEXT, is_test INTEGER, truth TEXT, created_at REAL, answered INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS votes (
  id TEXT PRIMARY KEY, user_id TEXT, task_id TEXT, candidate_id TEXT, answer TEXT,
  click_x REAL, click_y REAL, weight REAL, created_at REAL
);
CREATE TABLE IF NOT EXISTS consensus (
  candidate_id TEXT PRIMARY KEY, p_real REAL, n_votes INTEGER DEFAULT 0, weighted_votes REAL DEFAULT 0, updated_at REAL
);
CREATE TABLE IF NOT EXISTS patch_credit (
  patch_id TEXT PRIMARY KEY, weighted_votes REAL DEFAULT 0, updated_at REAL
);
"""


@dataclass
class UserRow:
    id: str
    display_name: str
    points: int
    skill: Skill
    n_votes: int


class SQLiteStore:
    def __init__(self, path: str):
        self.path = path
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._conn:
            self._conn.executescript(SCHEMA)

    # users ---------------------------------------------------------------
    def get_or_create_user(self, user_id: str | None, display_name: str | None = None) -> UserRow:
        uid = user_id or uuid.uuid4().hex
        with self._lock, self._conn:
            row = self._conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
            if row is None:
                self._conn.execute("INSERT INTO users (id, display_name, created_at) VALUES (?,?,?)",
                                   (uid, display_name or "anonymous", time.time()))
                row = self._conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        return self._user(row)

    def _user(self, row) -> UserRow:
        return UserRow(row["id"], row["display_name"], int(row["points"]),
                       Skill(row["real_correct"], row["real_seen"], row["bogus_correct"], row["bogus_seen"]),
                       int(row["n_votes"]))

    def save_user(self, u: UserRow) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "UPDATE users SET points=?, real_correct=?, real_seen=?, bogus_correct=?, bogus_seen=?, n_votes=? WHERE id=?",
                (u.points, u.skill.real_correct, u.skill.real_seen, u.skill.bogus_correct, u.skill.bogus_seen, u.n_votes, u.id))

    def leaderboard(self, n: int = 10) -> list[dict]:
        rows = self._conn.execute("SELECT id, display_name, points, n_votes FROM users ORDER BY points DESC LIMIT ?", (n,)).fetchall()
        return [dict(r) for r in rows]

    # tasks ---------------------------------------------------------------
    def create_task(self, user_id: str, candidate_id: str, is_test: bool, truth: str | None) -> str:
        tid = uuid.uuid4().hex
        with self._lock, self._conn:
            self._conn.execute("INSERT INTO tasks (id,user_id,candidate_id,is_test,truth,created_at) VALUES (?,?,?,?,?,?)",
                               (tid, user_id, candidate_id, int(is_test), truth, time.time()))
        return tid

    def get_task(self, task_id: str) -> dict | None:
        row = self._conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        return dict(row) if row else None

    def mark_answered(self, task_id: str) -> None:
        with self._lock, self._conn:
            self._conn.execute("UPDATE tasks SET answered=1 WHERE id=?", (task_id,))

    def seen_candidates(self, user_id: str) -> set[str]:
        rows = self._conn.execute("SELECT candidate_id FROM tasks WHERE user_id=? AND answered=1", (user_id,)).fetchall()
        return {r["candidate_id"] for r in rows}

    # votes / consensus -----------------------------------------------------
    def record_vote(self, user_id: str, task_id: str, candidate_id: str, answer: str,
                    click: tuple[float, float] | None, weight: float) -> str:
        vid = uuid.uuid4().hex
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO votes (id,user_id,task_id,candidate_id,answer,click_x,click_y,weight,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (vid, user_id, task_id, candidate_id, answer, click[0] if click else None, click[1] if click else None,
                 weight, time.time()))
        return vid

    def get_consensus(self, candidate_id: str, prior: float) -> dict:
        row = self._conn.execute("SELECT * FROM consensus WHERE candidate_id=?", (candidate_id,)).fetchone()
        if row is None:
            return {"candidate_id": candidate_id, "p_real": prior, "n_votes": 0, "weighted_votes": 0.0}
        return dict(row)

    def save_consensus(self, candidate_id: str, p_real: float, n_votes: int, weighted_votes: float) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO consensus (candidate_id,p_real,n_votes,weighted_votes,updated_at) VALUES (?,?,?,?,?) "
                "ON CONFLICT(candidate_id) DO UPDATE SET p_real=excluded.p_real, n_votes=excluded.n_votes, "
                "weighted_votes=excluded.weighted_votes, updated_at=excluded.updated_at",
                (candidate_id, p_real, n_votes, weighted_votes, time.time()))

    def all_consensus(self) -> dict[str, dict]:
        rows = self._conn.execute("SELECT * FROM consensus").fetchall()
        return {r["candidate_id"]: dict(r) for r in rows}

    def add_patch_credit(self, patch_id: str, weight: float) -> float:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO patch_credit (patch_id,weighted_votes,updated_at) VALUES (?,?,?) "
                "ON CONFLICT(patch_id) DO UPDATE SET weighted_votes=patch_credit.weighted_votes+excluded.weighted_votes, "
                "updated_at=excluded.updated_at", (patch_id, weight, time.time()))
            row = self._conn.execute("SELECT weighted_votes FROM patch_credit WHERE patch_id=?", (patch_id,)).fetchone()
        return float(row["weighted_votes"])

    def patch_credits(self) -> dict[str, float]:
        rows = self._conn.execute("SELECT patch_id, weighted_votes FROM patch_credit").fetchall()
        return {r["patch_id"]: float(r["weighted_votes"]) for r in rows}

    def total_votes(self) -> int:
        return int(self._conn.execute("SELECT COUNT(*) FROM votes").fetchone()[0])


class SupabaseStore(SQLiteStore):
    """Supabase (PostgREST) backend. Same tables as supabase/migrations/0001_init.sql.

    Implemented as thin overrides on top of the SQLite interface using the
    supabase-py client; only active when SUPABASE_URL and SUPABASE_SERVICE_KEY are set.
    """

    def __init__(self, url: str, key: str):
        from supabase import create_client  # type: ignore
        self.client = create_client(url, key)
        self._lock = threading.Lock()

    def _t(self, name: str):
        return self.client.table(name)

    def get_or_create_user(self, user_id, display_name=None):
        uid = user_id or uuid.uuid4().hex
        res = self._t("users").select("*").eq("id", uid).execute()
        if not res.data:
            self._t("users").insert({"id": uid, "display_name": display_name or "anonymous"}).execute()
            res = self._t("users").select("*").eq("id", uid).execute()
        r = res.data[0]
        return UserRow(r["id"], r["display_name"], int(r["points"]),
                       Skill(r["real_correct"], r["real_seen"], r["bogus_correct"], r["bogus_seen"]), int(r["n_votes"]))

    def save_user(self, u):
        self._t("users").update({"points": u.points, "real_correct": u.skill.real_correct, "real_seen": u.skill.real_seen,
                                 "bogus_correct": u.skill.bogus_correct, "bogus_seen": u.skill.bogus_seen,
                                 "n_votes": u.n_votes}).eq("id", u.id).execute()

    def leaderboard(self, n=10):
        return self._t("users").select("id,display_name,points,n_votes").order("points", desc=True).limit(n).execute().data

    def create_task(self, user_id, candidate_id, is_test, truth):
        tid = uuid.uuid4().hex
        self._t("tasks").insert({"id": tid, "user_id": user_id, "candidate_id": candidate_id, "is_test": is_test, "truth": truth}).execute()
        return tid

    def get_task(self, task_id):
        d = self._t("tasks").select("*").eq("id", task_id).execute().data
        return d[0] if d else None

    def mark_answered(self, task_id):
        self._t("tasks").update({"answered": True}).eq("id", task_id).execute()

    def seen_candidates(self, user_id):
        d = self._t("tasks").select("candidate_id").eq("user_id", user_id).eq("answered", True).execute().data
        return {r["candidate_id"] for r in d}

    def record_vote(self, user_id, task_id, candidate_id, answer, click, weight):
        vid = uuid.uuid4().hex
        self._t("votes").insert({"id": vid, "user_id": user_id, "task_id": task_id, "candidate_id": candidate_id,
                                 "answer": answer, "click_x": click[0] if click else None,
                                 "click_y": click[1] if click else None, "weight": weight}).execute()
        return vid

    def get_consensus(self, candidate_id, prior):
        d = self._t("consensus").select("*").eq("candidate_id", candidate_id).execute().data
        return d[0] if d else {"candidate_id": candidate_id, "p_real": prior, "n_votes": 0, "weighted_votes": 0.0}

    def save_consensus(self, candidate_id, p_real, n_votes, weighted_votes):
        self._t("consensus").upsert({"candidate_id": candidate_id, "p_real": p_real, "n_votes": n_votes,
                                     "weighted_votes": weighted_votes}).execute()

    def all_consensus(self):
        return {r["candidate_id"]: r for r in self._t("consensus").select("*").execute().data}

    def add_patch_credit(self, patch_id, weight):
        d = self._t("patch_credit").select("weighted_votes").eq("patch_id", patch_id).execute().data
        total = (d[0]["weighted_votes"] if d else 0.0) + weight
        self._t("patch_credit").upsert({"patch_id": patch_id, "weighted_votes": total}).execute()
        return float(total)

    def patch_credits(self):
        return {r["patch_id"]: float(r["weighted_votes"]) for r in self._t("patch_credit").select("*").execute().data}

    def total_votes(self):
        return int(self._t("votes").select("id", count="exact").execute().count or 0)


def make_store() -> SQLiteStore:
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_KEY")
    if url and key and os.environ.get("DEMO_MODE", "1") != "1":
        return SupabaseStore(url, key)
    path = os.environ.get("SQLITE_PATH", ":memory:" if os.environ.get("DEMO_MODE", "1") == "1" else "deepfield_local.sqlite")
    return SQLiteStore(path)
