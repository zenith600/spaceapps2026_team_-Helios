"""Build a sky-viewer bundle for an arbitrary (RA, Dec, field of view).

This is the module behind the challenge's core objective: a user types a position, and
gets back a time-ordered series of SPHEREx images of that patch that plays like a video.

    search_epochs(...)       what SPHEREx has at this position, without downloading anything
    build_sky_bundle(...)    fetch, reproject, coadd, render -> data/sky/<slug>/
    spectrum_at(...)         flux vs wavelength at one pixel, from the stored cube

Design notes live in docs/SKY.md. The short version: each SPHEREx pixel sees one
wavelength set by its place on the linear variable filter, so a raw time sequence mixes
bands. The bundle therefore carries three framings of the same data -- per exposure, per
detector coadd, per visit coadd -- and always labels the wavelength.
"""
from __future__ import annotations

import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from deepfield.config import REPO_ROOT, SPHEREX_PIXEL_ARCSEC
from deepfield.data import spherex as SX
from deepfield.sky import releases as REL
from deepfield.sky import render as RENDER
from deepfield.sky.resolver import Target

log = logging.getLogger("deepfield.sky.service")

SCHEMA_VERSION = 1
BANDS_TOTAL = 102                      # SPHEREx spectral channels across the full survey
SKY_DIR = Path(os.environ.get("SKY_DIR", REPO_ROOT / "data" / "sky"))
FETCH_WORKERS = int(os.environ.get("SKY_FETCH_WORKERS", "6"))
VISIT_GAP_DAYS = float(os.environ.get("SKY_VISIT_GAP_DAYS", "2.0"))
MIN_GOOD_FRACTION = float(os.environ.get("SKY_MIN_GOOD_FRACTION", "0.25"))

FOV_MIN, FOV_MAX = 0.02, 0.5


# ---------------------------------------------------------------------------
# Request
# ---------------------------------------------------------------------------

@dataclass
class SkyRequest:
    ra_deg: float
    dec_deg: float
    fov_deg: float = 0.1
    max_frames: int = 48
    per_visit: int = 16
    collections: tuple[str, ...] | None = None
    target: Target | None = None
    label: str = ""

    def __post_init__(self):
        if not (0.0 <= self.ra_deg <= 360.0):
            raise ValueError(f"RA out of range: {self.ra_deg}")
        if not (-90.0 <= self.dec_deg <= 90.0):
            raise ValueError(f"Dec out of range: {self.dec_deg}")
        if not (FOV_MIN <= self.fov_deg <= FOV_MAX):
            raise ValueError(f"field of view must be {FOV_MIN}-{FOV_MAX} deg, got {self.fov_deg}")
        self.max_frames = int(np.clip(self.max_frames, 2, 200))

    @property
    def npix(self) -> int:
        n = int(round(self.fov_deg * 3600.0 / SPHEREX_PIXEL_ARCSEC))
        return max(9, n + (1 - n % 2))        # odd, so there is a true centre pixel

    @property
    def radius_deg(self) -> float:
        return self.fov_deg / 2.0

    @property
    def cutout_deg(self) -> float:
        """Ask IRSA for a little more than we display, so reprojection has no edge gap."""
        return min(round(self.fov_deg * 1.4, 4), 1.0)

    @property
    def slug(self) -> str:
        """Identity of a view: position and field of view, nothing else.

        Deliberately NOT the target name. Searching "WISE 0855" and typing its
        coordinates are the same request and must hit the same cached bundle; if the
        name were part of the slug they would build twice and the viewer would report
        "not built yet" for something it had already built. The name lives inside
        sky.json and in the demo index, where it belongs.

        4 decimal places is 0.36 arcsec, well inside one 6.15 arcsec pixel, so queries
        that round to the same slug really are the same patch of sky.
        """
        return f"ra{self.ra_deg:.4f}-dec{self.dec_deg:+.4f}-fov{self.fov_deg:.3f}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Step 1: what is there? (no downloads)
# ---------------------------------------------------------------------------

def search_epochs(ra: float, dec: float, fov_deg: float, collections=None, *,
                  max_age_hours: float | None = None) -> tuple[pd.DataFrame, dict]:
    """List the SPHEREx exposures covering this position, grouped into visits.

    Cheap: one cached SIA2 query per collection, no image data. `em_min`/`em_max` give a
    wavelength estimate per exposure; the exact value comes from the cutout's WCS-WAVE
    table once we actually download it.
    """
    disc = REL.discover(allow_network=True)
    cols = list(collections) if collections else disc["searchable"]
    frames = []
    per_collection = {}
    for col in cols:
        try:
            df = SX.sia_search(ra, dec, fov_deg / 2.0, col, max_age_hours=max_age_hours)
        except Exception as exc:
            log.warning("SIA search failed for %s at %.5f %.5f: %s", col, ra, dec, exc)
            per_collection[col] = {"n": 0, "latest_mjd": None, "earliest_mjd": None, "error": str(exc)[:160]}
            continue
        per_collection[col] = ({"n": 0, "latest_mjd": None, "earliest_mjd": None} if len(df) == 0 else
                               {"n": int(len(df)), "latest_mjd": float(df["t_max"].max()),
                                "earliest_mjd": float(df["t_min"].min())})
        if len(df):
            frames.append(df)

    meta = {"collections_searched": cols, "collections_available": disc["all"],
            "collection_source": disc["source"], "per_collection": per_collection,
            "searched_at": _now_iso()}

    if not frames:
        return pd.DataFrame(), meta

    df = pd.concat(frames, ignore_index=True)
    df = df.drop_duplicates(subset=["obs_id", "detector", "collection"]).reset_index(drop=True)
    df = SX.group_visits(df, gap_days=VISIT_GAP_DAYS)
    df["mjd_mid"] = 0.5 * (df["t_min"] + df["t_max"])
    # Wavelength estimate from the SIA energy bounds (metres -> microns), refined later.
    with np.errstate(invalid="ignore"):
        df["wave_um_est"] = 0.5 * (df["em_min"].astype(float) + df["em_max"].astype(float)) * 1e6
    meta["n_exposures"] = int(len(df))
    meta["n_visits"] = int(df["visit"].nunique())
    meta["mjd_min"] = float(df["t_min"].min())
    meta["mjd_max"] = float(df["t_max"].max())
    meta["detectors"] = sorted(int(d) for d in df["detector"].unique())
    return df, meta


def visit_table(df: pd.DataFrame) -> list[dict]:
    """One row per visit, for the 'what is available' panel."""
    if len(df) == 0:
        return []
    out = []
    for v, g in df.groupby("visit"):
        out.append({
            "visit": int(v),
            "n_exposures": int(len(g)),
            "mjd_start": float(g["t_min"].min()),
            "mjd_end": float(g["t_max"].max()),
            "span_days": float(g["t_max"].max() - g["t_min"].min()),
            "detectors": sorted(int(d) for d in g["detector"].unique()),
            "label": str(g.sort_values("t_min").iloc[0]["obs_id"]).split("_")[0],
            "collections": sorted(g["collection"].unique().tolist()),
        })
    return sorted(out, key=lambda r: r["mjd_start"])


def select_exposures(df: pd.DataFrame, max_frames: int, per_visit: int) -> pd.DataFrame:
    """Keep every visit (motion needs the time baseline), capping exposures within each.

    Visits are what carry the signal the challenge is about, so we never drop a whole
    visit to satisfy `max_frames`; we thin inside visits instead, spreading the picks
    evenly in time and across detectors.
    """
    if len(df) == 0:
        return df
    visits = sorted(df["visit"].unique())
    budget = max(1, max_frames // max(len(visits), 1))
    cap = max(1, min(per_visit, budget))
    parts = []
    for v in visits:
        g = df[df.visit == v].sort_values(["t_min", "detector"])
        if len(g) > cap:
            idx = np.unique(np.linspace(0, len(g) - 1, cap).round().astype(int))
            g = g.iloc[idx]
        parts.append(g)
    out = pd.concat(parts).sort_values("t_min").reset_index(drop=True)
    return out.head(max_frames) if len(out) > max_frames else out


# ---------------------------------------------------------------------------
# Step 2: fetch + reproject
# ---------------------------------------------------------------------------

@dataclass
class LoadedFrame:
    row: pd.Series
    cutout: SX.Cutout
    image: np.ndarray
    variance: np.ndarray
    good: np.ndarray
    flags: np.ndarray
    visit: int = 0
    extra: dict = field(default_factory=dict)


def _fetch_one(row: pd.Series, ra: float, dec: float, size_deg: float):
    path = SX.fetch_cutout(row, ra, dec, size_deg)
    return row, SX.load_cutout(path)


def _reproject_flags(c: SX.Cutout, wcs_out, npix: int) -> np.ndarray:
    """Nearest-neighbour reprojection of the integer FLAGS plane (no interpolation of bitmasks)."""
    from scipy.ndimage import map_coordinates
    yy, xx = np.mgrid[0:npix, 0:npix]
    ra, dec = wcs_out.all_pix2world(xx.ravel(), yy.ravel(), 0)
    sx, sy = c.wcs.all_world2pix(ra, dec, 0)
    coords = np.stack([sy.reshape(npix, npix), sx.reshape(npix, npix)])
    return map_coordinates(c.flags.astype(np.float64), coords, order=0, mode="constant",
                           cval=0).astype(np.int64)


def load_frames(req: SkyRequest, sel: pd.DataFrame, progress=None) -> tuple[list[LoadedFrame], list[dict], object]:
    """Download the selected exposures concurrently and reproject them onto one grid.

    Returns (frames sorted by MJD, skipped records, the common output WCS).
    """
    from deepfield.stack.reproject import reproject_cutout, target_wcs
    npix = req.npix
    wcs_out = target_wcs(req.ra_deg, req.dec_deg, npix)
    total = len(sel)
    done = 0
    loaded: list[LoadedFrame] = []
    skipped: list[dict] = []

    def report(msg: str):
        if progress:
            progress(done, total, msg)

    report("starting")
    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        futures = {pool.submit(_fetch_one, row, req.ra_deg, req.dec_deg, req.cutout_deg): i
                   for i, (_, row) in enumerate(sel.iterrows())}
        for fut in as_completed(futures):
            done += 1
            try:
                row, cut = fut.result()
            except Exception as exc:
                # 422 = the requested centre is not on this exposure; 5xx already retried.
                skipped.append({"reason": type(exc).__name__, "detail": str(exc)[:160]})
                report(f"skipped one exposure ({type(exc).__name__})")
                continue
            if cut.good.mean() < MIN_GOOD_FRACTION:
                skipped.append({"obs_id": cut.obs_id, "detector": cut.detector,
                                "reason": "mostly flagged", "good_fraction": float(cut.good.mean())})
                report("skipped a mostly-flagged exposure")
                continue
            fr = reproject_cutout(cut, wcs_out, npix)
            flags = _reproject_flags(cut, wcs_out, npix)
            loaded.append(LoadedFrame(row=row, cutout=cut, image=fr.image, variance=fr.variance,
                                      good=fr.good, flags=flags, visit=int(row["visit"])))
            report(f"{cut.obs_id} D{cut.detector}")

    loaded.sort(key=lambda f: f.cutout.mjd)
    log.info("loaded %d/%d exposures (%d skipped)", len(loaded), total, len(skipped))
    return loaded, skipped, wcs_out


# ---------------------------------------------------------------------------
# Step 3: combine
# ---------------------------------------------------------------------------

def coadd(frames: list[LoadedFrame]) -> tuple[np.ndarray, np.ndarray, int]:
    """Inverse-variance weighted mean of reprojected frames. NaN where nothing was good."""
    if not frames:
        raise ValueError("no frames to coadd")
    img = np.stack([f.image for f in frames])
    var = np.stack([f.variance for f in frames])
    good = np.stack([f.good for f in frames]) & np.isfinite(img) & np.isfinite(var) & (var > 0)
    w = np.where(good, 1.0 / np.where(var > 0, var, np.inf), 0.0)
    wsum = w.sum(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.where(wsum > 0, (w * np.nan_to_num(img)).sum(axis=0) / np.where(wsum > 0, wsum, 1), np.nan)
        out_var = np.where(wsum > 0, 1.0 / np.where(wsum > 0, wsum, 1), np.nan)
    return out.astype(np.float32), out_var.astype(np.float32), len(frames)


def _flag_union(frames: list[LoadedFrame]) -> np.ndarray:
    out = np.zeros_like(frames[0].flags)
    for f in frames:
        out |= f.flags
    return out


# ---------------------------------------------------------------------------
# Step 4: build the bundle
# ---------------------------------------------------------------------------

def build_sky_bundle(req: SkyRequest, out_root: Path | None = None, *, progress=None,
                     max_age_hours: float | None = None) -> dict:
    """Fetch, combine and render everything the viewer needs. Returns the sky.json dict."""
    t0 = time.time()
    out_root = Path(out_root) if out_root else SKY_DIR
    out = out_root / req.slug
    out.mkdir(parents=True, exist_ok=True)

    def step(msg, done=0, total=0):
        log.info("%s: %s", req.slug, msg)
        if progress:
            progress(done, total, msg)

    step("searching SPHEREx coverage")
    df, search_meta = search_epochs(req.ra_deg, req.dec_deg, req.fov_deg, req.collections,
                                    max_age_hours=max_age_hours)
    if len(df) == 0:
        raise LookupError(
            f"No SPHEREx exposures cover RA {req.ra_deg:.5f} Dec {req.dec_deg:+.5f} in "
            f"{', '.join(search_meta['collections_searched'])}. SPHEREx surveys the whole sky "
            f"every six months, so this position is most likely not in a published release yet.")

    sel = select_exposures(df, req.max_frames, req.per_visit)
    step(f"{len(df)} exposures available, fetching {len(sel)}", 0, len(sel))

    loaded, skipped, wcs_out = load_frames(req, sel, progress=progress)
    if len(loaded) < 2:
        raise LookupError(f"only {len(loaded)} usable exposures at this position "
                          f"({len(skipped)} skipped); try a larger field of view")

    source = SX.SOURCE
    npix = req.npix

    # Renumber visits densely over what actually loaded, keeping time order.
    visit_ids = sorted({f.visit for f in loaded})
    vmap = {v: i for i, v in enumerate(visit_ids)}
    for f in loaded:
        f.visit = vmap[f.visit]

    step("combining")
    stack_img, stack_var, n_stack = coadd(loaded)
    static_img = np.nanmedian(np.stack([f.image for f in loaded]), axis=0).astype(np.float32)

    by_visit: dict[int, list[LoadedFrame]] = {}
    by_visit_det: dict[tuple[int, int], list[LoadedFrame]] = {}
    for f in loaded:
        by_visit.setdefault(f.visit, []).append(f)
        by_visit_det.setdefault((f.visit, f.cutout.detector), []).append(f)

    visit_imgs = {v: coadd(fs)[0] for v, fs in by_visit.items()}
    det_imgs = {k: coadd(fs)[0] for k, fs in by_visit_det.items()}

    # One stretch for everything that shows sky brightness, so frames do not flicker.
    vmin, vmax = RENDER.robust_limits([f.image for f in loaded] + list(visit_imgs.values()))
    step("rendering")

    # --- per-exposure frames ------------------------------------------------
    epoch_frames = []
    for i, f in enumerate(loaded):
        c = f.cutout
        png = out / "frames" / f"e{i:03d}.png"
        RENDER.write_png(f.image, png, source=source, vmin=vmin, vmax=vmax,
                         extra={"obs_id": c.obs_id, "mjd": f"{c.mjd:.6f}", "wave_um": f"{c.wave_um:.4f}"})
        fpng = out / "flags" / f"e{i:03d}.png"
        RENDER.write_flag_png(f.flags, fpng, source=source)
        epoch_frames.append({
            "id": f"e{i:03d}", "png": "frames/" + png.name, "flag_png": "flags/" + fpng.name,
            "obs_id": c.obs_id, "detector": int(c.detector), "mjd": float(c.mjd),
            "wave_um": round(float(c.wave_um), 4), "bandwidth_um": round(float(c.bandwidth_um), 4),
            "visit": int(f.visit), "collection": str(f.row.get("collection", "")),
            "good_fraction": round(float(f.good.mean()), 4),
            "psf_fwhm_arcsec": round(float(c.psf_fwhm_arcsec), 2),
            "flags": RENDER.flag_summary(f.flags),
        })

    # --- per-detector coadds (the brief's own suggestion for depth) ----------
    det_frames = []
    for (v, d), fs in sorted(by_visit_det.items()):
        img = det_imgs[(v, d)]
        png = out / "detectors" / f"v{v}d{d}.png"
        RENDER.write_png(img, png, source=source, vmin=vmin, vmax=vmax)
        waves = [fr.cutout.wave_um for fr in fs]
        det_frames.append({
            "id": f"v{v}d{d}", "png": "detectors/" + png.name, "visit": int(v), "detector": int(d),
            "n": len(fs), "mjd": float(np.mean([fr.cutout.mjd for fr in fs])),
            "wave_um": round(float(np.mean(waves)), 4),
            "wave_min_um": round(float(np.min(waves)), 4), "wave_max_um": round(float(np.max(waves)), 4),
            "flags": RENDER.flag_summary(_flag_union(fs)),
        })

    # --- per-visit coadds (the motion movie) --------------------------------
    visit_frames = []
    for v, fs in sorted(by_visit.items()):
        img = visit_imgs[v]
        png = out / "visits" / f"v{v}.png"
        RENDER.write_png(img, png, source=source, vmin=vmin, vmax=vmax)
        mjds = [fr.cutout.mjd for fr in fs]
        visit_frames.append({
            "id": f"v{v}", "png": "visits/" + png.name, "visit": int(v), "n": len(fs),
            "mjd": float(np.mean(mjds)), "mjd_start": float(np.min(mjds)), "mjd_end": float(np.max(mjds)),
            "label": str(fs[0].cutout.obs_id).split("_")[0],
            "detectors": sorted({int(fr.cutout.detector) for fr in fs}),
            "n_bands": len({round(fr.cutout.wave_um, 2) for fr in fs}),
            "flags": RENDER.flag_summary(_flag_union(fs)),
        })

    # --- difference frames: every visit minus the first ---------------------
    diff_frames = []
    if len(visit_frames) >= 2:
        ref = visit_imgs[visit_frames[0]["visit"]]
        diffs = {v: visit_imgs[v] - ref for v in sorted(visit_imgs) if v != visit_frames[0]["visit"]}
        dmin, dmax = RENDER.robust_limits(list(diffs.values()), lo_pct=2.0, hi_pct=98.0)
        lim = max(abs(dmin), abs(dmax))
        for v, d in diffs.items():
            png = out / "diff" / f"d{v}.png"
            RENDER.write_png(d, png, source=source, vmin=-lim, vmax=lim, mode="linear")
            diff_frames.append({"id": f"d{v}", "png": "diff/" + png.name, "visit": int(v),
                                "reference_visit": int(visit_frames[0]["visit"]),
                                "mjd": float(np.mean([fr.cutout.mjd for fr in by_visit[v]])),
                                "label": f"visit {v} - visit {visit_frames[0]['visit']}"})

    # --- stack and static ---------------------------------------------------
    RENDER.write_png(stack_img, out / "stack.png", source=source, vmin=vmin, vmax=vmax)
    RENDER.write_png(static_img, out / "static.png", source=source, vmin=vmin, vmax=vmax)

    # --- the cube that makes spectra on-the-fly possible --------------------
    np.savez_compressed(
        out / "cube.npz",
        flux=np.stack([f.image for f in loaded]).astype(np.float32),
        var=np.stack([f.variance for f in loaded]).astype(np.float32),
        good=np.stack([f.good for f in loaded]),
        mjd=np.array([f.cutout.mjd for f in loaded], dtype=np.float64),
        wave_um=np.array([f.cutout.wave_um for f in loaded], dtype=np.float32),
        bandwidth_um=np.array([f.cutout.bandwidth_um for f in loaded], dtype=np.float32),
        detector=np.array([f.cutout.detector for f in loaded], dtype=np.int16),
        visit=np.array([f.visit for f in loaded], dtype=np.int16),
        obs_id=np.array([f.cutout.obs_id for f in loaded], dtype=object),
    )

    waves = np.array([f.cutout.wave_um for f in loaded])
    mjds = np.array([f.cutout.mjd for f in loaded])
    bundle = {
        "schema_version": SCHEMA_VERSION,
        "slug": req.slug,
        "generated_at": _now_iso(),
        "source": source,
        "is_simulated": False,
        "target": (req.target.as_dict() if req.target else
                   {"query": req.label or f"{req.ra_deg} {req.dec_deg}",
                    "name": req.label or f"RA {req.ra_deg:.5f} Dec {req.dec_deg:+.5f}",
                    "ra_deg": req.ra_deg, "dec_deg": req.dec_deg, "resolver": "coords", "note": "", "slug": ""}),
        "ra_deg": req.ra_deg, "dec_deg": req.dec_deg, "fov_deg": req.fov_deg,
        "npix": npix, "pixel_arcsec": SPHEREX_PIXEL_ARCSEC,
        "wcs": {"ctype": list(wcs_out.wcs.ctype), "crval": list(map(float, wcs_out.wcs.crval)),
                "crpix": list(map(float, wcs_out.wcs.crpix)), "cdelt": list(map(float, wcs_out.wcs.cdelt))},
        "coverage": {
            "n_exposures_available": int(len(df)),
            "n_requested": int(len(sel)),
            "n_used": int(len(loaded)),
            "n_skipped": len(skipped),
            "mjd_min": float(mjds.min()), "mjd_max": float(mjds.max()),
            "baseline_days": float(mjds.max() - mjds.min()),
            "n_visits": len(visit_frames),
            "n_bands": int(len({round(float(w), 2) for w in waves})),
            "bands_total": BANDS_TOTAL,
            "wave_min_um": round(float(waves.min()), 4), "wave_max_um": round(float(waves.max()), 4),
            "detectors": sorted({int(f.cutout.detector) for f in loaded}),
        },
        "search": search_meta,
        "visits": visit_table(df),
        "freshness": {"built_from": search_meta["per_collection"], "built_at": _now_iso()},
        "frames": {"epochs": epoch_frames, "detectors": det_frames, "visits": visit_frames},
        "difference": diff_frames,
        "stack": {"png": "stack.png", "n": int(n_stack),
                  "note": "inverse-variance weighted mean of every exposure used"},
        "static": {"png": "static.png", "method": "per-pixel median across exposures",
                   "note": "what stays put; subtract it mentally to see what moves"},
        "scale": {"mode": "asinh", "vmin": float(vmin), "vmax": float(vmax), "unit": "MJy/sr",
                  "note": "one stretch shared by every frame so brightness is comparable"},
        "flag_legend": RENDER.overlay_legend(),
        "cube": "cube.npz",
        "skipped": skipped[:20],
        "elapsed_s": round(time.time() - t0, 1),
        "limits": [
            f"SPHEREx pixels are {SPHEREX_PIXEL_ARCSEC} arcsec; close pairs blend together.",
            f"{len({round(float(w), 2) for w in waves})} distinct bands measured here, out of {BANDS_TOTAL} "
            "across the full survey. Each pixel sees one wavelength, set by its position on the filter.",
            "Brightness is Level 2 surface brightness in MJy/sr, as delivered by IRSA. No photometry of our own.",
            "Frames are bilinearly reprojected onto a common grid, which smooths noise slightly.",
            "This is a display of public NASA data, not a detection claim.",
        ],
    }
    (out / "sky.json").write_text(json.dumps(bundle, indent=1, default=float))
    step(f"done in {bundle['elapsed_s']}s: {len(loaded)} frames, {len(visit_frames)} visits")
    return bundle


# ---------------------------------------------------------------------------
# Step 5: spectra on demand
# ---------------------------------------------------------------------------

def spectrum_at(bundle_dir: Path, x: float, y: float, r: int = 1) -> dict:
    """Flux vs wavelength at one pixel, built from the stored cube at request time.

    An `r`-pixel box is averaged (r=1 -> 3x3, roughly the 7.5 arcsec PSF) and each
    exposure contributes one point at its own wavelength. That is what makes this a
    spectrum rather than a light curve: SPHEREx's filter means different exposures of
    the same sky position sample different bands.
    """
    bundle_dir = Path(bundle_dir)
    meta = json.loads((bundle_dir / "sky.json").read_text())
    with np.load(bundle_dir / "cube.npz", allow_pickle=True) as z:
        flux, var, good = z["flux"], z["var"], z["good"]
        wave, bw, mjd = z["wave_um"], z["bandwidth_um"], z["mjd"]
        det, visit, obs = z["detector"], z["visit"], z["obs_id"]

    n, ny, nx = flux.shape
    xi, yi = int(round(x)), int(round(y))
    if not (0 <= xi < nx and 0 <= yi < ny):
        raise ValueError(f"pixel ({xi}, {yi}) is outside the {nx}x{ny} field")
    r = int(np.clip(r, 0, 4))
    x0, x1 = max(0, xi - r), min(nx, xi + r + 1)
    y0, y1 = max(0, yi - r), min(ny, yi + r + 1)

    box = flux[:, y0:y1, x0:x1]
    vbox = var[:, y0:y1, x0:x1]
    gbox = good[:, y0:y1, x0:x1] & np.isfinite(box) & np.isfinite(vbox)
    npx = gbox.sum(axis=(1, 2))
    with np.errstate(invalid="ignore", divide="ignore"):
        f_mean = np.where(npx > 0, np.where(gbox, box, 0).sum(axis=(1, 2)) / np.maximum(npx, 1), np.nan)
        f_err = np.where(npx > 0, np.sqrt(np.where(gbox, vbox, 0).sum(axis=(1, 2))) / np.maximum(npx, 1), np.nan)

    from astropy.wcs import WCS
    w = WCS(naxis=2)
    w.wcs.ctype = meta["wcs"]["ctype"]
    w.wcs.crval = meta["wcs"]["crval"]
    w.wcs.crpix = meta["wcs"]["crpix"]
    w.wcs.cdelt = meta["wcs"]["cdelt"]
    ra, dec = w.all_pix2world([xi], [yi], 0)

    points = []
    for i in range(n):
        if not np.isfinite(f_mean[i]):
            continue
        points.append({
            "wave_um": round(float(wave[i]), 4), "bandwidth_um": round(float(bw[i]), 4),
            "flux_mjysr": float(f_mean[i]), "flux_err_mjysr": float(f_err[i]),
            "mjd": float(mjd[i]), "detector": int(det[i]), "visit": int(visit[i]),
            "obs_id": str(obs[i]), "n_pixels": int(npx[i]),
        })
    points.sort(key=lambda p: p["wave_um"])
    return {
        "slug": meta["slug"], "x": xi, "y": yi, "r": r,
        "ra_deg": float(ra[0]), "dec_deg": float(dec[0]),
        "n_points": len(points),
        "n_bands": len({round(p["wave_um"], 2) for p in points}),
        "bands_total": BANDS_TOTAL,
        "points": points,
        "unit": "MJy/sr",
        "source": meta["source"],
        "note": ("Each point is one SPHEREx exposure, at the wavelength that exposure's filter "
                 "position gave this pixel. Points at the same wavelength from different visits "
                 "show variability, not spectral structure."),
    }


def load_bundle(bundle_dir: Path) -> dict:
    return json.loads((Path(bundle_dir) / "sky.json").read_text())


def bundle_freshness(bundle_dir: Path, *, max_age_hours: float = 0.25) -> dict:
    """Has new SPHEREx data landed at this position since the bundle was built?"""
    meta = load_bundle(bundle_dir)
    now = REL.coverage_snapshot(meta["ra_deg"], meta["dec_deg"], meta["fov_deg"] / 2.0,
                                max_age_hours=max_age_hours)
    cmp = REL.compare(meta.get("freshness", {}).get("built_from", {}), now)
    cmp["built_at"] = meta.get("freshness", {}).get("built_at") or meta.get("generated_at")
    cmp["slug"] = meta["slug"]
    return cmp
