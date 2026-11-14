"""Pre-bake sky bundles for the challenge test targets and export them to the web app.

A live view of an arbitrary coordinate costs ~12 s per exposure from IRSA, so the demo
cannot depend on it: the five targets named in the brief are built ahead of time and
committed, which also means the demo survives an IRSA outage during judging.

    python -m deepfield.cli sky bake                 # build any missing featured target
    python -m deepfield.cli sky bake --refresh       # rebuild the ones with new data
    python -m deepfield.cli sky bake --force         # rebuild everything
"""
from __future__ import annotations

import json
import logging
import shutil
from datetime import datetime, timezone
from pathlib import Path

from deepfield.config import REPO_ROOT
from deepfield.sky import releases as REL
from deepfield.sky import service as SVC
from deepfield.sky.resolver import featured, resolve

log = logging.getLogger("deepfield.sky.bake")

WEB_SKY_DIR = REPO_ROOT / "apps" / "web" / "public" / "demo" / "sky"
DEFAULT_FOV = 0.1
DEFAULT_MAX_FRAMES = 48

#: Files copied into the web bundle. `cube.npz` stays server-side: it is the biggest
#: file and the browser never reads it directly -- spectra come from the API, or from
#: the pre-extracted `spectra.json` below.
WEB_FILES = ("sky.json", "stack.png", "static.png")
WEB_DIRS = ("frames", "visits", "detectors", "diff", "flags")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def bake_one(query: str, *, fov_deg: float = DEFAULT_FOV, max_frames: int = DEFAULT_MAX_FRAMES,
             force: bool = False, refresh: bool = False, progress=None) -> dict:
    """Build (or reuse) one bundle. Returns {slug, status, bundle|error}."""
    target = resolve(query, allow_network=False)
    req = SVC.SkyRequest(target.ra_deg, target.dec_deg, fov_deg, max_frames=max_frames, target=target)
    out = SVC.SKY_DIR / req.slug
    existing = out / "sky.json"

    if existing.exists() and not force:
        if not refresh:
            log.info("%s: already built, skipping", req.slug)
            return {"slug": req.slug, "status": "cached", "bundle": SVC.load_bundle(out)}
        fresh = SVC.bundle_freshness(out)
        if not fresh["stale"]:
            log.info("%s: up to date (%s)", req.slug, fresh.get("latest_mjd"))
            return {"slug": req.slug, "status": "fresh", "bundle": SVC.load_bundle(out), "freshness": fresh}
        log.info("%s: %d new exposures, rebuilding", req.slug, fresh["new_exposures"])

    bundle = SVC.build_sky_bundle(req, progress=progress)
    return {"slug": req.slug, "status": "built", "bundle": bundle}


def export_one(slug: str, web_dir: Path | None = None) -> Path:
    """Copy a built bundle into the web app's public demo folder."""
    web_dir = Path(web_dir) if web_dir else WEB_SKY_DIR
    src = SVC.SKY_DIR / slug
    dst = web_dir / slug
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True, exist_ok=True)
    for name in WEB_FILES:
        if (src / name).exists():
            shutil.copy2(src / name, dst / name)
    for d in WEB_DIRS:
        if (src / d).is_dir():
            shutil.copytree(src / d, dst / d)
    return dst


def write_index(entries: list[dict], web_dir: Path | None = None) -> Path:
    """The catalogue the web app reads in DEMO_MODE to know what is pre-baked."""
    web_dir = Path(web_dir) if web_dir else WEB_SKY_DIR
    web_dir.mkdir(parents=True, exist_ok=True)
    disc = REL.discover(allow_network=False)
    index = {
        "schema_version": SVC.SCHEMA_VERSION,
        "generated_at": _now_iso(),
        "source": "NASA SPHEREx Level 2 spectral images via IRSA (irsa.ipac.caltech.edu)",
        "collections_at_bake_time": disc["all"],
        "targets": entries,
        "note": ("Pre-baked so the viewer opens instantly and works with no API and no network. "
                 "Any other coordinate is fetched live from IRSA."),
    }
    path = web_dir / "index.json"
    path.write_text(json.dumps(index, indent=1))
    return path


def bake_featured(*, fov_deg: float = DEFAULT_FOV, max_frames: int = DEFAULT_MAX_FRAMES,
                  force: bool = False, refresh: bool = False, queries: list[str] | None = None,
                  export: bool = True) -> dict:
    """Build and export every featured target. Keeps going if one fails."""
    wanted = queries or [f["name"] for f in featured()]
    entries, failures = [], []
    for q in wanted:
        try:
            res = bake_one(q, fov_deg=fov_deg, max_frames=max_frames, force=force, refresh=refresh)
        except Exception as exc:
            log.error("%s: %s: %s", q, type(exc).__name__, exc)
            failures.append({"query": q, "error": f"{type(exc).__name__}: {exc}"})
            continue
        b = res["bundle"]
        if export:
            export_one(res["slug"])
        entries.append({
            "slug": res["slug"], "status": res["status"],
            "query": q, "name": b["target"]["name"], "note": b["target"].get("note", ""),
            "ra_deg": b["ra_deg"], "dec_deg": b["dec_deg"], "fov_deg": b["fov_deg"],
            "n_frames": b["coverage"]["n_used"], "n_visits": b["coverage"]["n_visits"],
            "n_bands": b["coverage"]["n_bands"], "bands_total": b["coverage"]["bands_total"],
            "baseline_days": round(b["coverage"]["baseline_days"], 1),
            "mjd_min": b["coverage"]["mjd_min"], "mjd_max": b["coverage"]["mjd_max"],
            "generated_at": b["generated_at"],
        })
    if export and entries:
        write_index(entries)
    return {"targets": entries, "failures": failures}
