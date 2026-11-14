"""Which SPHEREx data releases exist right now, and has new data landed since we built a view?

The challenge asks for a tool that is easy to update as new data arrives. The answer here
is to treat the list of releases as *data*, not code: ask IRSA's ObsTAP service which
`spherex_*` collections it publishes, cache that for a few hours, and search whatever
comes back. When IRSA publishes spherex_dr2 the viewer picks it up with no code change.

Verified 2026-11-14:
  GET https://irsa.ipac.caltech.edu/TAP/sync?LANG=ADQL&FORMAT=csv
      &QUERY=SELECT DISTINCT obs_collection FROM ivoa.obscore WHERE obs_collection LIKE 'spherex%'
  -> spherex_dr1, spherex_dr1_cal, spherex_dr1_cube, spherex_dr1_deep, spherex_qr3, spherex_qr3_deep
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from datetime import datetime, timezone

from deepfield.config import CACHE_DIR

log = logging.getLogger("deepfield.sky.releases")

TAP_URL = "https://irsa.ipac.caltech.edu/TAP/sync"
COLLECTION_QUERY = ("SELECT DISTINCT obs_collection FROM ivoa.obscore "
                    "WHERE obs_collection LIKE 'spherex%'")

#: Collections the viewer searches: the per-exposure Level 2 image releases.
#: `_cal` (calibration) and `_cube` (spectral cubes) are different products; `_deep`
#: coadds have no single epoch, so none of them belong in a time-series blink movie.
SEARCHABLE_RE = re.compile(r"^spherex_(dr|qr)\d+$")

FALLBACK = ("spherex_dr1", "spherex_qr3")
CACHE_PATH = CACHE_DIR / "releases.json"
DEFAULT_TTL_HOURS = float(os.environ.get("SKY_RELEASES_TTL_HOURS", "6"))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _configured() -> tuple[str, ...] | None:
    raw = os.environ.get("SPHEREX_COLLECTIONS", "").strip()
    if not raw:
        return None
    return tuple(c.strip() for c in raw.split(",") if c.strip())


def _query_tap(timeout: float) -> list[str]:
    from deepfield.data.manifest import fetch
    r = fetch(TAP_URL, params={"QUERY": COLLECTION_QUERY, "LANG": "ADQL", "FORMAT": "csv"},
              timeout=timeout, retries=1)
    rows = [ln.strip() for ln in r.text.splitlines() if ln.strip()]
    if not rows or not rows[0].lower().startswith("obs_collection"):
        raise RuntimeError(f"unexpected TAP response: {r.text[:200]!r}")
    return sorted({ln.strip().strip('"') for ln in rows[1:]})


def discover(*, ttl_hours: float = DEFAULT_TTL_HOURS, force: bool = False,
             timeout: float = 240.0, allow_network: bool = True) -> dict:
    """Return {all, searchable, discovered_at, source, stale_cache}.

    Never raises: on any failure it falls back to the configured list, then to FALLBACK,
    and says so in `source`.
    """
    override = _configured()
    if override is not None:
        return {"all": list(override), "searchable": list(override), "discovered_at": _now_iso(),
                "source": "SPHEREX_COLLECTIONS environment override", "stale_cache": False}

    cached = None
    if CACHE_PATH.exists():
        try:
            cached = json.loads(CACHE_PATH.read_text())
            age_h = (time.time() - CACHE_PATH.stat().st_mtime) / 3600.0
            if not force and age_h < ttl_hours:
                return {**cached, "stale_cache": False}
        except Exception:
            cached = None

    if allow_network:
        try:
            found = _query_tap(timeout)
            out = {"all": found,
                   "searchable": [c for c in found if SEARCHABLE_RE.match(c)] or list(FALLBACK),
                   "discovered_at": _now_iso(),
                   "source": f"IRSA ObsTAP ({TAP_URL})"}
            CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
            CACHE_PATH.write_text(json.dumps(out, indent=1))
            return {**out, "stale_cache": False}
        except Exception as exc:
            log.warning("collection discovery failed (%s: %s); falling back", type(exc).__name__, exc)

    if cached is not None:
        return {**cached, "stale_cache": True}
    return {"all": list(FALLBACK), "searchable": list(FALLBACK), "discovered_at": _now_iso(),
            "source": "built-in fallback list (discovery unavailable)", "stale_cache": True}


def searchable(**kw) -> list[str]:
    return discover(**kw)["searchable"]


# ---------------------------------------------------------------------------
# Freshness
# ---------------------------------------------------------------------------
def coverage_snapshot(ra: float, dec: float, radius_deg: float, collections=None, *,
                      max_age_hours: float | None = None) -> dict:
    """How many exposures each collection has at this position right now.

    `max_age_hours` is passed to the SIA cache, so a freshness check can force a
    re-query while an ordinary build happily reuses yesterday's search.
    """
    from deepfield.data.spherex import sia_search
    cols = list(collections) if collections else searchable()
    snap: dict[str, dict] = {}
    for col in cols:
        try:
            df = sia_search(ra, dec, radius_deg, col, max_age_hours=max_age_hours)
        except Exception as exc:
            log.warning("SIA search failed for %s: %s", col, exc)
            continue
        if len(df) == 0:
            snap[col] = {"n": 0, "latest_mjd": None, "earliest_mjd": None}
            continue
        snap[col] = {"n": int(len(df)),
                     "latest_mjd": float(df["t_max"].max()),
                     "earliest_mjd": float(df["t_min"].min())}
    return snap


def compare(built_from: dict, now: dict) -> dict:
    """Diff a bundle's stored coverage against a fresh snapshot."""
    built_from = built_from or {}
    new_exposures = 0
    per_collection = {}
    for col, cur in now.items():
        was = built_from.get(col) or {"n": 0, "latest_mjd": None}
        delta = int(cur["n"]) - int(was.get("n") or 0)
        if delta > 0:
            new_exposures += delta
        per_collection[col] = {"n_now": cur["n"], "n_built": int(was.get("n") or 0),
                               "new": max(delta, 0), "latest_mjd": cur["latest_mjd"]}
    new_collections = [c for c in now if c not in built_from and now[c]["n"] > 0]
    latest = [v["latest_mjd"] for v in now.values() if v.get("latest_mjd") is not None]
    return {"new_exposures": new_exposures,
            "new_collections": new_collections,
            "per_collection": per_collection,
            "latest_mjd": max(latest) if latest else None,
            "stale": bool(new_exposures > 0 or new_collections),
            "checked_at": _now_iso()}
