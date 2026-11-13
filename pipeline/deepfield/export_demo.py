"""Export a pipeline bundle to the static demo files the web app reads in DEMO_MODE.

Output (apps/web/public/demo/):
  map.json, map_equirect.png, targets.json, candidates.json, completeness.json,
  manifest.json, spectra/<id>.json, dossiers/<id>.json, stamps/<id>/*.png
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np
import pandas as pd
import yaml
from astropy_healpix import HEALPix
import astropy.units as u

from deepfield.config import REPO_ROOT
from deepfield.contracts import read_table

WEB_DEMO_DIR = REPO_ROOT / "apps" / "web" / "public" / "demo"


def _clean(v):
    if isinstance(v, (np.floating, float)):
        return None if np.isnan(v) else float(v)
    if isinstance(v, np.integer):
        return int(v)
    if isinstance(v, np.bool_):
        return bool(v)
    if v is pd.NA:
        return None
    return v


def records(df: pd.DataFrame) -> list[dict]:
    return [{k: _clean(v) for k, v in r.items()} for r in df.to_dict(orient="records")]


def _colormap(x: np.ndarray) -> np.ndarray:
    """0..1 -> RGB. Near-black to deep blue to amber accent (matches the UI palette)."""
    x = np.clip(x, 0, 1)[..., None]
    c0 = np.array([8, 10, 16]); c1 = np.array([30, 58, 138]); c2 = np.array([245, 158, 11])
    a = np.clip(x * 2, 0, 1); b = np.clip(x * 2 - 1, 0, 1)
    rgb = c0 * (1 - a) + c1 * a
    rgb = rgb * (1 - b) + c2 * b
    return rgb.astype(np.uint8)


def render_equirect(prior: pd.DataFrame, nside: int, width: int = 1440, height: int = 720) -> np.ndarray:
    from PIL import Image  # noqa: F401
    hp = HEALPix(nside=nside, order="ring")
    lon = (np.arange(width) + 0.5) / width * 360.0
    lat = 90.0 - (np.arange(height) + 0.5) / height * 180.0
    LON, LAT = np.meshgrid(lon, lat)
    # Equirectangular texture on a sphere: u runs 0..1 as lon goes 0..360 (RA increases to the east).
    pix = hp.lonlat_to_healpix(LON * u.deg, LAT * u.deg)
    p = np.zeros(hp.npix); p[prior.hpix.values] = prior.p_remaining.values
    s = np.zeros(hp.npix, dtype=bool); s[prior.hpix.values] = prior.searched.values
    v = p[pix]
    v = np.log10(v + 1e-6); v = (v - v.min()) / (v.max() - v.min() + 1e-9)
    rgb = _colormap(v ** 1.2)
    searched_mask = s[pix]
    if searched_mask.any():
        green = np.array([34, 197, 94], dtype=float)
        rgb[searched_mask] = (0.35 * rgb[searched_mask] + 0.65 * green).astype(np.uint8)
    return rgb


def export(bundle_dir: Path, out_dir: Path = WEB_DEMO_DIR) -> dict:
    from PIL import Image
    bundle_dir, out_dir = Path(bundle_dir), Path(out_dir)
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    info = json.loads((bundle_dir / "bundle.json").read_text()) if (bundle_dir / "bundle.json").exists() else {}

    prior, pmeta = read_table(bundle_dir / "prior_map.parquet")
    targets, tmeta = read_table(bundle_dir / "targets.parquet")
    cands, cmeta = read_table(bundle_dir / "candidates.parquet")
    spectra, smeta = read_table(bundle_dir / "spectra.parquet")
    comp, kmeta = read_table(bundle_dir / "completeness.parquet")
    nside = int(pmeta.get("nside", 32))

    frac_prior = float(pmeta.get("frac_excluded_prior", 0))
    frac_df_full = float(pmeta.get("frac_excluded_deepfield", 0))
    searched = targets[targets.status == "searched"]
    map_json = {
        "frac_excluded_prior": frac_prior,
        "frac_excluded_deepfield_potential": (1 - frac_prior) * frac_df_full,
        "n_patches_searched": int(len(searched)),
        "per_patch_share": frac_df_full / max(len(searched), 1),
        "bundle_kind": info.get("kind", "UNKNOWN"),
        "population_version": pmeta.get("population_version"),
        "epoch_mjd": pmeta.get("epoch_mjd"),
        "nside": nside, "source": pmeta.get("data_source"), "generated_at": pmeta.get("generated_at"),
        "cells": records(prior[prior.p_surviving > 0][["hpix", "ra_deg", "dec_deg", "p_surviving", "p_remaining", "searched"]]),
        "explanation": ("Prior exclusion comes from the ZTF, DES and Pan-STARRS flags in the Caltech reference population. "
                        "Deep Field exclusion counts reference planets that crossed a searched patch brighter than our measured "
                        "completeness limit, credited as the crowd verifies each patch's injected test cards."),
    }
    (out_dir / "map.json").write_text(json.dumps(map_json))
    Image.fromarray(render_equirect(prior, nside)).save(out_dir / "map_equirect.png")

    (out_dir / "targets.json").write_text(json.dumps({"targets": records(targets), "source": tmeta.get("data_source")}))
    (out_dir / "completeness.json").write_text(json.dumps({"rows": records(comp), "source": kmeta.get("data_source")}))
    (out_dir / "manifest.json").write_text(json.dumps(yaml.safe_load((REPO_ROOT / "manifest.yaml").read_text(encoding="utf-8"))))

    (out_dir / "spectra").mkdir(); (out_dir / "dossiers").mkdir(); (out_dir / "stamps").mkdir()
    cand_rows = []
    for c in records(cands.sort_values(["is_simulated", "snr_stack"], ascending=[False, False])):
        cid = c["candidate_id"]
        sd = bundle_dir / "stamps" / cid
        singles = sorted(p.name for p in sd.glob("single_*.png")) if sd.exists() else []
        if sd.exists():
            dst = out_dir / "stamps" / cid
            dst.mkdir()
            for p in sd.glob("*.png"):
                shutil.copy(p, dst / p.name)
            if (sd / "meta.json").exists():
                shutil.copy(sd / "meta.json", dst / "meta.json")
        c["stamps"] = {"singles": [f"stamps/{cid}/{s}" for s in singles], "stack": f"stamps/{cid}/stack.png",
                       "static": f"stamps/{cid}/static.png"}
        c["dossier_url"] = f"dossiers/{cid}.json"
        cand_rows.append(c)
        sp = spectra[spectra.candidate_id == cid].sort_values("wavelength_um")
        (out_dir / "spectra" / f"{cid}.json").write_text(json.dumps({"rows": records(sp), "source": smeta.get("data_source")}))
        dp = bundle_dir / "dossiers" / f"{cid}.json"
        if dp.exists():
            shutil.copy(dp, out_dir / "dossiers" / f"{cid}.json")
    (out_dir / "candidates.json").write_text(json.dumps({"candidates": cand_rows, "source": cmeta.get("data_source"),
                                                          "n_total": len(cand_rows)}))
    (out_dir / "bundle.json").write_text(json.dumps(info))
    return {"candidates": len(cand_rows), "cells": len(map_json["cells"]), "out": str(out_dir)}
