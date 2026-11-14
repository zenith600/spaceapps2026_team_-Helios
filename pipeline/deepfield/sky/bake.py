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

import numpy as np

from deepfield.config import REPO_ROOT
from deepfield.sky import releases as REL
from deepfield.sky import service as SVC
from deepfield.sky.resolver import featured, resolve

log = logging.getLogger("deepfield.sky.bake")

WEB_SKY_DIR = REPO_ROOT / "apps" / "web" / "public" / "demo" / "sky"
DEFAULT_FOV = 0.1
DEFAULT_MAX_FRAMES = 48

WEB_FILES = ("sky.json", "stack.png", "static.png", "colour.png", "overlay.json", "explain.json")
WEB_DIRS = ("frames", "visits", "detectors", "diff", "flags", "colour")


def enrich_one(slug: str, *, overlays: bool = True, explain: bool = True) -> dict:
    """Add the slow, optional extras to a built bundle: catalogue overlays and a caption.

    Both are written into the bundle so the demo serves them instantly. Both are allowed to
    fail: an archive that is down costs that layer, not the view.
    """
    src = SVC.SKY_DIR / slug
    meta = SVC.load_bundle(src)
    out = {"overlay": None, "explain": None}

    if overlays:
        try:
            from deepfield.sky.catalogs import write_overlay
            ov = write_overlay(meta, src / "overlay.json")
            out["overlay"] = {L["id"]: L["n"] for L in ov["layers"]}
        except Exception as exc:
            log.warning("%s: overlay failed: %s: %s", slug, type(exc).__name__, exc)

    if explain:
        try:
            from deepfield.ai.explain import explain_field
            known = []
            try:
                from deepfield.data.sbident import known_bodies
                rows = known_bodies(meta["ra_deg"], meta["dec_deg"], meta["fov_deg"] * 0.75,
                                    0.5 * (meta["coverage"]["mjd_min"] + meta["coverage"]["mjd_max"]))
                known = rows.to_dict("records") if hasattr(rows, "to_dict") else list(rows)
            except Exception:
                pass
            ex = explain_field(meta, known_bodies=known)
            (src / "explain.json").write_text(json.dumps(ex, indent=1))
            out["explain"] = ex["generator"]
        except Exception as exc:
            log.warning("%s: explain failed: %s: %s", slug, type(exc).__name__, exc)
    return out


def export_cube_u16(src: Path, dst: Path) -> dict:
    """Re-encode the pixel cube so the browser can build spectra with no API.

    `cube.npz` is float32 NumPy inside a zip -- neither of which JavaScript reads
    without a library. This writes a flat little-endian uint16 buffer the browser maps
    straight onto a `Uint16Array`, with one (offset, scale) pair per frame in sky.json:

        value = offset + code * scale

    Quantisation error is 1/65534 of each frame's own range, which is orders of
    magnitude below the per-pixel noise, and it halves the payload against float32.
    Flux and variance are stored back to back in one file.

    Two details that are not optional:

    * The `good` mask is folded in as the no-data code. The browser has no other copy
      of it, so without this it would average flagged pixels that `spectrum_at` in
      Python excludes, and the same click would give two different answers.
    * The range is taken over good pixels only. Reprojection fills unusable variance
      with 1e6, and letting that into the range would make the quantisation step ~15
      MJy^2/sr^2 and destroy the error bars on every real pixel.
    """
    with np.load(src / "cube.npz", allow_pickle=True) as z:
        flux, var, good = z["flux"], z["var"], z["good"]
        meta = {k: z[k] for k in ("mjd", "wave_um", "bandwidth_um", "detector", "visit")}
        obs = [str(o) for o in z["obs_id"]]

    n, ny, nx = flux.shape
    valid = np.asarray(good, dtype=bool) & np.isfinite(flux) & np.isfinite(var) & (np.asarray(var) > 0)
    planes, codec = [], []
    for name, cube in (("flux", flux), ("var", var)):
        for i in range(n):
            a = np.asarray(cube[i], dtype=np.float64)
            ok = valid[i]
            lo = float(a[ok].min()) if ok.any() else 0.0
            hi = float(a[ok].max()) if ok.any() else 1.0
            scale = (hi - lo) / 65534.0 if hi > lo else 1.0
            # 65535 is reserved as the "no data" code, so masked pixels survive the trip.
            code = np.where(ok, np.clip((a - lo) / scale, 0, 65534).round(), 65535)
            planes.append(code.astype("<u2"))
            codec.append({"plane": name, "i": i, "offset": lo, "scale": scale,
                          "n_valid": int(ok.sum())})

    (dst / "cube.u16").write_bytes(np.stack(planes).tobytes())
    return {
        "file": "cube.u16", "dtype": "uint16-le", "shape": [2, n, ny, nx],
        "planes": ["flux", "var"], "nodata_code": 65535, "codec": codec,
        "mjd": [float(v) for v in meta["mjd"]],
        "wave_um": [round(float(v), 4) for v in meta["wave_um"]],
        "bandwidth_um": [round(float(v), 4) for v in meta["bandwidth_um"]],
        "detector": [int(v) for v in meta["detector"]],
        "visit": [int(v) for v in meta["visit"]],
        "obs_id": obs,
        "note": ("value = offset + code * scale, per plane and frame; code 65535 means no data "
                 "(flagged, non-finite, or zero variance) and must be skipped, exactly as the "
                 "good mask is applied in Python"),
    }


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


def export_one(slug: str, web_dir: Path | None = None, *, with_cube: bool = True) -> Path:
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
    if with_cube and (src / "cube.npz").exists():
        meta = json.loads((dst / "sky.json").read_text())
        meta["cube_u16"] = export_cube_u16(src, dst)
        (dst / "sky.json").write_text(json.dumps(meta, indent=1))
    return dst


def export_catalogue(web_dir: Path | None = None) -> Path:
    """The built-in target catalogue, so the web app can resolve names with no API."""
    from deepfield.sky.resolver import catalogue
    web_dir = Path(web_dir) if web_dir else WEB_SKY_DIR
    web_dir.mkdir(parents=True, exist_ok=True)
    path = web_dir / "catalogue.json"
    path.write_text(json.dumps({"generated_at": _now_iso(), "targets": catalogue()}, indent=1))
    return path


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
                  export: bool = True, enrich: bool = True) -> dict:
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
        if enrich:
            enrich_one(res["slug"])
        if export:
            export_one(res["slug"])
        # Descriptive copy comes from the live catalogue, not from the bundle's frozen copy of
        # it: rewording "what to look for" must not require re-downloading images.
        t = resolve(q, allow_network=False)
        entries.append({
            "slug": res["slug"], "status": res["status"],
            "query": q, "name": t.name, "note": t.note,
            "look_for": t.look_for, "kind": t.kind,
            "ra_deg": b["ra_deg"], "dec_deg": b["dec_deg"], "fov_deg": b["fov_deg"],
            "n_frames": b["coverage"]["n_used"], "n_visits": b["coverage"]["n_visits"],
            "n_bands": b["coverage"]["n_bands"], "bands_total": b["coverage"]["bands_total"],
            "baseline_days": round(b["coverage"]["baseline_days"], 1),
            "mjd_min": b["coverage"]["mjd_min"], "mjd_max": b["coverage"]["mjd_max"],
            "generated_at": b["generated_at"],
        })
    if export and entries:
        write_index(entries)
        export_catalogue()
    return {"targets": entries, "failures": failures}
