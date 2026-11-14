"""Sky Viewer routes: resolve a position, see what SPHEREx has, build a view, read it back.

A live view of an arbitrary coordinate means downloading tens of ~4 MB cutouts from
IRSA, so building one is a **job**: POST /sky/jobs returns immediately and the client
polls GET /sky/jobs/{id} for progress. Pre-baked targets skip all of that.

Routes
  GET  /sky/targets                 built-in catalogue + what is already built
  GET  /sky/resolve?q=              name or coordinates -> RA/Dec
  GET  /sky/releases                which SPHEREx collections IRSA publishes today
  GET  /sky/epochs?ra=&dec=&fov=    coverage at a position, no downloads
  POST /sky/jobs                    start building a view
  GET  /sky/jobs/{job_id}           progress
  GET  /sky/bundle/{slug}           the built sky.json
  GET  /sky/bundle/{slug}/freshness has new data landed since it was built?
  GET  /sky/spectrum/{slug}?x=&y=   on-the-fly spectrum at one pixel
  files are served from /sky/files/{slug}/...
"""
from __future__ import annotations

import logging
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from deepfield.sky import bake as BAKE
from deepfield.sky import releases as REL
from deepfield.sky import resolver as RES
from deepfield.sky import service as SVC

log = logging.getLogger("deepfield_api.sky")
router = APIRouter(prefix="/sky", tags=["sky"])

#: Refuse to start live builds when the deployment is meant to serve frozen data only.
ALLOW_LIVE = os.environ.get("SKY_ALLOW_LIVE", "1") == "1"
MAX_ACTIVE_JOBS = int(os.environ.get("SKY_MAX_ACTIVE_JOBS", "2"))
FRESHNESS_TTL_HOURS = float(os.environ.get("SKY_FRESHNESS_TTL_HOURS", "0.25"))
#: How often the background refresher re-asks IRSA what it has. 0 turns it off.
REFRESH_MINUTES = float(os.environ.get("SKY_REFRESH_MINUTES", "30"))
#: Rebuild a view by itself when new exposures land. Off by default: it spends
#: bandwidth and disk without anyone asking.
AUTO_REBUILD = os.environ.get("SKY_AUTO_REBUILD", "0") == "1"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Where bundles live: the built directory first, then the frozen web demo copy.
# ---------------------------------------------------------------------------

def bundle_dir(slug: str) -> Path:
    if "/" in slug or "\\" in slug or ".." in slug:
        raise HTTPException(400, "bad slug")
    for root in (SVC.SKY_DIR, BAKE.WEB_SKY_DIR):
        p = root / slug
        if (p / "sky.json").exists():
            return p
    raise HTTPException(404, f"no sky bundle {slug!r}. Build one with POST /sky/jobs.")


def _built_slugs() -> list[str]:
    seen, out = set(), []
    for root in (SVC.SKY_DIR, BAKE.WEB_SKY_DIR):
        if not root.exists():
            continue
        for p in sorted(root.glob("*")):
            if (p / "sky.json").exists() and p.name not in seen:
                seen.add(p.name)
                out.append(p.name)
    return out


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

class Job:
    def __init__(self, job_id: str, req: SVC.SkyRequest):
        self.id = job_id
        self.req = req
        self.state = "queued"          # queued | running | done | error
        self.done = 0
        self.total = 0
        self.message = "queued"
        self.slug = req.slug
        self.error: str | None = None
        self.started_at = _now_iso()
        self.finished_at: str | None = None

    def as_dict(self) -> dict:
        return {"job_id": self.id, "state": self.state, "slug": self.slug,
                "n_done": self.done, "n_total": self.total, "message": self.message,
                "error": self.error, "started_at": self.started_at, "finished_at": self.finished_at,
                "progress": (self.done / self.total) if self.total else 0.0,
                "bundle_url": f"/sky/bundle/{self.slug}" if self.state == "done" else None}


_JOBS: dict[str, Job] = {}
_JOBS_LOCK = threading.Lock()

# ---------------------------------------------------------------------------
# Background refresher: "new SPHEREx data is arriving fast", so keep asking.
# ---------------------------------------------------------------------------
_FRESH: dict[str, dict] = {}
_REFRESH_STATE: dict = {"last_sweep": None, "last_error": None, "running": False}
_STOP = threading.Event()


def refresh_sweep() -> dict:
    """Re-ask IRSA what it has for every built view, and note what is new.

    Also re-runs release discovery, so a brand new collection (spherex_dr2, say) starts
    being searched without a redeploy -- the whole point of treating the release list as
    data rather than code.
    """
    before = set(REL.discover(allow_network=False)["all"])
    disc = REL.discover(force=True)
    new_releases = sorted(set(disc["all"]) - before)
    checked, stale = 0, []
    for slug in _built_slugs():
        if _STOP.is_set():
            break
        try:
            out = SVC.bundle_freshness(SVC.SKY_DIR / slug if (SVC.SKY_DIR / slug / "sky.json").exists()
                                       else BAKE.WEB_SKY_DIR / slug, max_age_hours=0.0)
        except Exception as exc:
            log.warning("freshness sweep failed for %s: %s", slug, exc)
            continue
        checked += 1
        _FRESH[slug] = {**out, "cached": True}
        if out["stale"]:
            stale.append(slug)
            if AUTO_REBUILD and ALLOW_LIVE:
                _auto_rebuild(slug)
    state = {"last_sweep": _now_iso(), "n_checked": checked, "n_stale": len(stale),
             "stale": stale, "new_releases": new_releases, "collections": disc["all"]}
    _REFRESH_STATE.update(state)
    if new_releases:
        log.info("new SPHEREx collections published: %s", ", ".join(new_releases))
    return state


def _auto_rebuild(slug: str) -> None:
    meta = SVC.load_bundle(bundle_dir(slug))
    req = SVC.SkyRequest(meta["ra_deg"], meta["dec_deg"], meta["fov_deg"],
                         label=meta.get("target", {}).get("name", ""))
    with _JOBS_LOCK:
        if any(j.slug == req.slug and j.state in ("queued", "running") for j in _JOBS.values()):
            return
        job = Job(uuid.uuid4().hex[:12], req)
        _JOBS[job.id] = job
    log.info("auto-rebuilding %s after new data", slug)
    threading.Thread(target=_run_job, args=(job,), daemon=True, name=f"sky-auto-{job.id}").start()


def _refresher() -> None:
    _REFRESH_STATE["running"] = True
    # A first sweep on startup would make every cold start hit IRSA several times, so
    # wait one interval and let the on-demand path fill the cache meanwhile.
    while not _STOP.wait(REFRESH_MINUTES * 60):
        try:
            refresh_sweep()
        except Exception as exc:
            log.exception("refresh sweep failed")
            _REFRESH_STATE["last_error"] = f"{type(exc).__name__}: {exc}"
    _REFRESH_STATE["running"] = False


def start_refresher() -> bool:
    """Called from the app lifespan. Returns whether the thread was started."""
    if REFRESH_MINUTES <= 0 or _REFRESH_STATE["running"]:
        return False
    _STOP.clear()
    threading.Thread(target=_refresher, daemon=True, name="sky-refresher").start()
    return True


def stop_refresher() -> None:
    _STOP.set()


def _run_job(job: Job) -> None:
    def progress(done, total, msg):
        job.done, job.total, job.message = done, total, msg

    job.state = "running"
    try:
        SVC.build_sky_bundle(job.req, progress=progress)
        job.state, job.message = "done", "complete"
    except Exception as exc:
        log.exception("sky job %s failed", job.id)
        job.state = "error"
        job.error = f"{type(exc).__name__}: {exc}"
        job.message = job.error
    finally:
        job.finished_at = _now_iso()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/targets")
def sky_targets():
    """The built-in catalogue, flagged with whether a view is already built."""
    built = set(_built_slugs())
    out = []
    for entry in RES.catalogue():
        t = RES.resolve(entry["name"], allow_network=False)
        req = SVC.SkyRequest(t.ra_deg, t.dec_deg, BAKE.DEFAULT_FOV, target=t)
        out.append({**entry, "slug": req.slug, "built": req.slug in built})
    return {"targets": out, "built": sorted(built),
            "default_fov_deg": BAKE.DEFAULT_FOV, "fov_range": [SVC.FOV_MIN, SVC.FOV_MAX]}


@router.get("/resolve")
def sky_resolve(q: str = Query(..., min_length=1), network: bool = True):
    try:
        t = RES.resolve(q, allow_network=network)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    return t.as_dict()


@router.get("/releases")
def sky_releases(force: bool = False):
    return {**REL.discover(force=force),
            "searchable_pattern": REL.SEARCHABLE_RE.pattern,
            "refresher": {"interval_minutes": REFRESH_MINUTES,
                          "running": _REFRESH_STATE.get("running", False),
                          "last_sweep": _REFRESH_STATE.get("last_sweep"),
                          "new_releases_last_sweep": _REFRESH_STATE.get("new_releases", [])}}


@router.post("/refresh")
def sky_refresh_now():
    """Run a refresh sweep immediately. Useful from a cron job or after a release."""
    return refresh_sweep()


@router.get("/epochs")
def sky_epochs(ra: float = Query(..., ge=0, le=360), dec: float = Query(..., ge=-90, le=90),
               fov: float = Query(0.1, ge=SVC.FOV_MIN, le=SVC.FOV_MAX),
               max_frames: int = 48, per_visit: int = 16, refresh: bool = False):
    """What SPHEREx has at this position. One cached SIA2 query per collection, no images."""
    df, meta = SVC.search_epochs(ra, dec, fov, max_age_hours=(FRESHNESS_TTL_HOURS if refresh else None))
    if len(df) == 0:
        return {"ra_deg": ra, "dec_deg": dec, "fov_deg": fov, "n_exposures": 0, "visits": [],
                "search": meta, "estimate": None,
                "message": ("No SPHEREx exposures cover this position in the releases published so far. "
                            "SPHEREx maps the whole sky every six months, so check again after the next release.")}
    sel = SVC.select_exposures(df, max_frames, per_visit)
    req = SVC.SkyRequest(ra, dec, fov, max_frames=max_frames, per_visit=per_visit)
    return {
        "ra_deg": ra, "dec_deg": dec, "fov_deg": fov, "npix": req.npix, "slug": req.slug,
        "n_exposures": int(meta["n_exposures"]), "n_visits": int(meta["n_visits"]),
        "mjd_min": meta["mjd_min"], "mjd_max": meta["mjd_max"],
        "baseline_days": meta["mjd_max"] - meta["mjd_min"],
        "detectors": meta["detectors"], "visits": SVC.visit_table(df), "search": meta,
        "estimate": {"n_frames": int(len(sel)), "download_mb": round(len(sel) * 4.3, 1),
                     "seconds": int(len(sel) * 12 / max(SVC.FETCH_WORKERS, 1))},
        "already_built": req.slug in set(_built_slugs()),
    }


class JobIn(BaseModel):
    ra_deg: float = Field(..., ge=0, le=360)
    dec_deg: float = Field(..., ge=-90, le=90)
    fov_deg: float = Field(0.1, ge=SVC.FOV_MIN, le=SVC.FOV_MAX)
    max_frames: int = Field(48, ge=2, le=200)
    per_visit: int = Field(16, ge=1, le=60)
    label: str = ""
    force: bool = False


@router.post("/jobs")
def sky_job_create(body: JobIn):
    if not ALLOW_LIVE:
        raise HTTPException(503, "live building is disabled on this deployment (SKY_ALLOW_LIVE=0). "
                                 "The pre-baked targets at /sky/targets are available.")
    try:
        req = SVC.SkyRequest(body.ra_deg, body.dec_deg, body.fov_deg, max_frames=body.max_frames,
                             per_visit=body.per_visit, label=body.label)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    if not body.force and req.slug in set(_built_slugs()):
        return {"job_id": None, "state": "done", "slug": req.slug, "progress": 1.0,
                "message": "already built", "bundle_url": f"/sky/bundle/{req.slug}"}

    with _JOBS_LOCK:
        active = [j for j in _JOBS.values() if j.state in ("queued", "running")]
        for j in active:
            if j.slug == req.slug:
                return j.as_dict()
        if len(active) >= MAX_ACTIVE_JOBS:
            raise HTTPException(429, f"{len(active)} builds already running; try again shortly")
        job = Job(uuid.uuid4().hex[:12], req)
        _JOBS[job.id] = job
    threading.Thread(target=_run_job, args=(job,), daemon=True, name=f"sky-{job.id}").start()
    return job.as_dict()


@router.get("/jobs/{job_id}")
def sky_job_status(job_id: str):
    job = _JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "unknown job")
    return job.as_dict()


@router.get("/jobs")
def sky_jobs():
    return {"jobs": [j.as_dict() for j in _JOBS.values()]}


@router.get("/bundle/{slug}")
def sky_bundle(slug: str):
    import json
    b = json.loads((bundle_dir(slug) / "sky.json").read_text())
    b["file_base"] = f"/sky/files/{slug}"
    return b


@router.get("/bundle/{slug}/freshness")
def sky_freshness(slug: str, force: bool = False):
    """Has new SPHEREx data landed at this position since the view was built?

    This is the live-refresh hook: the web app polls it and offers a Rebuild when the
    answer is yes. It also reports collections that did not exist at build time, so a
    whole new data release shows up here.

    Answers come from the background refresher's cache. Every check is a SIA2 query per
    collection against IRSA, so serving a cached answer to many pollers -- rather than
    one upstream query per poll -- is the difference between a feature and an abuse of
    someone else's service.
    """
    d = bundle_dir(slug)
    cached = _FRESH.get(slug)
    if cached is not None and not force:
        return cached
    try:
        out = SVC.bundle_freshness(d, max_age_hours=FRESHNESS_TTL_HOURS)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, f"freshness check failed: {type(exc).__name__}: {exc}") from exc
    out["cached"] = False
    _FRESH[slug] = {**out, "cached": True}
    return out


@router.get("/freshness")
def sky_freshness_all():
    """Every built view and whether new data has landed for it. Served from cache."""
    return {"refresher": {"interval_minutes": REFRESH_MINUTES, "auto_rebuild": AUTO_REBUILD,
                          "last_sweep": _REFRESH_STATE.get("last_sweep"),
                          "last_error": _REFRESH_STATE.get("last_error")},
            "bundles": {s: _FRESH.get(s) for s in _built_slugs()}}


@router.get("/spectrum/{slug}")
def sky_spectrum(slug: str, x: float = Query(...), y: float = Query(...), r: int = Query(1, ge=0, le=4)):
    d = bundle_dir(slug)
    if not (d / "cube.npz").exists():
        raise HTTPException(404, "this bundle was exported without its pixel cube, so spectra are "
                                 "not available for it; rebuild it with POST /sky/jobs")
    try:
        return SVC.spectrum_at(d, x, y, r)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/files/{slug}/{path:path}")
def sky_file(slug: str, path: str):
    root = bundle_dir(slug).resolve()
    target = (root / path).resolve()
    if not str(target).startswith(str(root)) or not target.is_file():
        raise HTTPException(404, "no such file")
    return FileResponse(target)
