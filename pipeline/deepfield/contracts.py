"""File contracts for Deep Field.

Every file the web app or API reads is defined here: its pyarrow schema, how to
write it with provenance metadata, and `write_sample_bundle()` which produces a
small, clearly-fake bundle so the frontend/API can be built before real data.
"""
from __future__ import annotations

import json
import datetime as dt
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

SCHEMA_VERSION = "1"

PRIOR_MAP = pa.schema([
    ("hpix", pa.int32()), ("ra_deg", pa.float64()), ("dec_deg", pa.float64()),
    ("n_all", pa.int32()), ("n_surviving", pa.int32()), ("n_remaining", pa.int32()),
    ("p_surviving", pa.float64()), ("p_remaining", pa.float64()), ("searched", pa.bool_()),
])

TARGETS = pa.schema([
    ("patch_id", pa.string()), ("rank", pa.int32()), ("ra_deg", pa.float64()), ("dec_deg", pa.float64()),
    ("radius_deg", pa.float64()), ("hpix", pa.int32()), ("p_surviving", pa.float64()),
    ("n_exposures", pa.int32()), ("mjd_start", pa.float64()), ("mjd_end", pa.float64()),
    ("visit_label", pa.string()), ("status", pa.string()), ("score", pa.float64()), ("source", pa.string()),
])

CANDIDATES = pa.schema([
    ("candidate_id", pa.string()), ("patch_id", pa.string()), ("ra_deg", pa.float64()), ("dec_deg", pa.float64()),
    ("is_simulated", pa.bool_()), ("injection_id", pa.string()), ("injected_mag", pa.float64()),
    ("injected_distance_au", pa.float64()),
    ("snr_stack", pa.float64()), ("snr_single_max", pa.float64()), ("best_distance_au", pa.float64()),
    ("best_rate_ra_arcsec_day", pa.float64()), ("best_rate_dec_arcsec_day", pa.float64()),
    ("flux_mjysr", pa.float64()), ("n_epochs", pa.int32()), ("n_bands", pa.int32()),
    ("methane_score", pa.float64()), ("template_best", pa.string()),
    ("ml_score", pa.float64()), ("rule_score", pa.float64()),
    ("crowd_p_real", pa.float64()), ("n_votes", pa.int32()),
    ("status", pa.string()), ("known_object", pa.string()),
    ("stamp_dir", pa.string()), ("dossier_path", pa.string()), ("source", pa.string()), ("created_mjd", pa.float64()),
])

SPECTRA = pa.schema([
    ("candidate_id", pa.string()), ("obs_id", pa.string()), ("detector", pa.int8()), ("mjd", pa.float64()),
    ("wavelength_um", pa.float64()), ("bandwidth_um", pa.float64()),
    ("flux_mjysr", pa.float64()), ("flux_err_mjysr", pa.float64()),
    ("model_planet", pa.float64()), ("model_asteroid", pa.float64()), ("model_star", pa.float64()),
    ("source", pa.string()),
])

COMPLETENESS = pa.schema([
    ("patch_id", pa.string()), ("axis", pa.string()), ("bin_lo", pa.float64()), ("bin_hi", pa.float64()),
    ("n_injected", pa.int32()), ("n_recovered", pa.int32()), ("fraction", pa.float64()),
    ("snr_threshold", pa.float64()), ("source", pa.string()),
])

SCHEMAS = {
    "prior_map": PRIOR_MAP, "targets": TARGETS, "candidates": CANDIDATES,
    "spectra": SPECTRA, "completeness": COMPLETENESS,
}

STAMP_SIZE = 32
MODEL_INPUT_CHANNELS = 3  # stack SNR, static sky, best single epoch


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def write_table(df: pd.DataFrame, name: str, path: Path, *, source: str, extra_meta: dict | None = None) -> Path:
    """Write a DataFrame to parquet with the contract schema + provenance metadata."""
    schema = SCHEMAS[name]
    df = df.copy()
    for field in schema:
        if field.name not in df.columns:
            df[field.name] = None
    df = df[[f.name for f in schema]]
    table = pa.Table.from_pandas(df, schema=schema, preserve_index=False)
    meta = {
        "schema_version": SCHEMA_VERSION, "generated_at": now_iso(), "data_source": source,
        **{k: json.dumps(v) if not isinstance(v, str) else v for k, v in (extra_meta or {}).items()},
    }
    table = table.replace_schema_metadata({k: str(v) for k, v in meta.items()})
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, path)
    return path


def read_table(path: Path) -> tuple[pd.DataFrame, dict]:
    t = pq.read_table(path)
    meta = {k.decode(): v.decode() for k, v in (t.schema.metadata or {}).items()}
    return t.to_pandas(), meta


# ---------------------------------------------------------------------------
# Sample (fake) bundle
# ---------------------------------------------------------------------------

def _gaussian_stamp(rng: np.random.Generator, size: int, amp: float, sigma: float = 1.3,
                    noise: float = 1.0, offset: tuple[float, float] = (0.0, 0.0)) -> np.ndarray:
    y, x = np.mgrid[0:size, 0:size]
    cx, cy = size / 2 - 0.5 + offset[0], size / 2 - 0.5 + offset[1]
    img = amp * np.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma ** 2))
    return img + rng.normal(0, noise, (size, size))


def _write_png(arr: np.ndarray, path: Path, *, source: str, vmin: float | None = None, vmax: float | None = None) -> None:
    from PIL import Image, PngImagePlugin
    lo = np.percentile(arr, 1) if vmin is None else vmin
    hi = np.percentile(arr, 99.7) if vmax is None else vmax
    img8 = np.clip((arr - lo) / max(hi - lo, 1e-9), 0, 1)
    img8 = (255 * img8).astype(np.uint8)
    im = Image.fromarray(img8[::-1], mode="L").resize((arr.shape[1] * 6, arr.shape[0] * 6), Image.Resampling.NEAREST)
    info = PngImagePlugin.PngInfo()
    info.add_text("source", source)
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, pnginfo=info)


def write_stamps(stamp_dir: Path, singles: np.ndarray, stack: np.ndarray, static: np.ndarray, *,
                 source: str, is_simulated: bool, meta: dict | None = None) -> None:
    """Write the stamp set for one candidate: PNGs for the UI, npz for ML."""
    stamp_dir = Path(stamp_dir)
    stamp_dir.mkdir(parents=True, exist_ok=True)
    label = ("SIMULATED | " if is_simulated else "") + source
    vmin, vmax = np.percentile(singles, 1), np.percentile(singles, 99.7)
    for k in range(singles.shape[0]):
        _write_png(singles[k], stamp_dir / f"single_{k:02d}.png", source=label, vmin=vmin, vmax=vmax)
    _write_png(stack, stamp_dir / "stack.png", source=label)
    _write_png(static, stamp_dir / "static.png", source=label)
    np.savez_compressed(stamp_dir / "stamps.npz", singles=singles.astype(np.float32),
                        stack=stack.astype(np.float32), static=static.astype(np.float32))
    (stamp_dir / "meta.json").write_text(json.dumps({
        "n_singles": int(singles.shape[0]), "size": int(stack.shape[0]), "source": source,
        "is_simulated": bool(is_simulated), **(meta or {})}, indent=1))


def write_sample_bundle(out_dir: Path, seed: int = 42, nside: int = 32) -> dict:
    """Produce a complete fake bundle: every contract file with plausible numbers.

    Everything here is labelled SAMPLE / simulated. It exists so the API and web
    app can be developed and tested without the pipeline.
    """
    from astropy_healpix import HEALPix
    import astropy.units as u

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed)
    src = "SAMPLE (synthetic placeholder; not NASA data)"

    # --- prior map: a soft blob around the Planet Nine region (RA ~ 40, Dec ~ -10)
    hp = HEALPix(nside=nside, order="ring")
    npix = hp.npix
    lon, lat = hp.healpix_to_lonlat(np.arange(npix))
    ra, dec = lon.to_value(u.deg), lat.to_value(u.deg)
    d = np.hypot((ra - 40 + 180) % 360 - 180, dec + 10)
    n_all = rng.poisson(8000 * np.exp(-(d / 40) ** 2) / 100 + 0.05)
    n_surv = (n_all * rng.uniform(0.1, 0.4, npix)).astype(int)
    n_rem = n_surv.copy()
    searched = np.zeros(npix, dtype=bool)
    top = np.argsort(-n_surv)[:3]
    searched[top] = True
    n_rem[top] = (n_rem[top] * 0.97).astype(int)
    prior = pd.DataFrame({
        "hpix": np.arange(npix, dtype=np.int32), "ra_deg": ra, "dec_deg": dec,
        "n_all": n_all.astype(np.int32), "n_surviving": n_surv.astype(np.int32), "n_remaining": n_rem.astype(np.int32),
        "p_surviving": n_surv / max(n_surv.sum(), 1), "p_remaining": n_rem / max(n_rem.sum(), 1), "searched": searched,
    })
    frac_prior = 1 - n_surv.sum() / max(n_all.sum(), 1)
    frac_df = 1 - n_rem.sum() / max(n_surv.sum(), 1)
    write_table(prior, "prior_map", out_dir / "prior_map.parquet", source=src, extra_meta={
        "nside": nside, "ordering": "ring", "epoch_mjd": 60885.0, "population_version": "SAMPLE",
        "frac_excluded_prior": frac_prior, "frac_excluded_deepfield": frac_df,
    })

    # --- targets
    targets = pd.DataFrame([{
        "patch_id": f"P{k+1:03d}", "rank": k + 1, "ra_deg": float(ra[i]), "dec_deg": float(dec[i]),
        "radius_deg": 0.125, "hpix": int(i), "p_surviving": float(n_surv[i] / n_surv.sum()),
        "n_exposures": int(rng.integers(30, 60)), "mjd_start": 60880.2, "mjd_end": 60892.2,
        "visit_label": "2025W30-W32", "status": "searched", "score": float(n_surv[i]), "source": src,
    } for k, i in enumerate(top)])
    write_table(targets, "targets", out_dir / "targets.parquet", source=src)

    # --- candidates + stamps + spectra + dossiers
    cands, spec_rows = [], []
    stamps_root = out_dir / "stamps"
    dossier_root = out_dir / "dossiers"
    dossier_root.mkdir(parents=True, exist_ok=True)
    cid_n = 0
    for _, t in targets.iterrows():
        for j in range(4):
            cid_n += 1
            cid = f"C{cid_n:04d}"
            is_sim = j < 2
            n_ep = int(rng.integers(20, 40))
            inj_mag = float(rng.uniform(19.5, 22.5)) if is_sim else None
            amp_single = 10 ** (-(inj_mag - 19.0) / 2.5) * 1.5 if is_sim else rng.uniform(0.1, 0.6)
            singles = np.stack([_gaussian_stamp(rng, STAMP_SIZE, amp_single, offset=(0.3 * k - 3, 0.1 * k)) for k in range(min(n_ep, 12))])
            static = np.median(singles, axis=0) + _gaussian_stamp(rng, STAMP_SIZE, 6.0, offset=(9, -7), noise=0.0)
            stack = _gaussian_stamp(rng, STAMP_SIZE, amp_single * np.sqrt(n_ep), noise=1.0)
            snr_stack = float(amp_single * np.sqrt(n_ep) * 2.2)
            snr_single = float(amp_single * 2.2)
            sd = stamps_root / cid
            write_stamps(sd, singles, stack, static, source=src, is_simulated=is_sim,
                         meta={"candidate_id": cid, "injected_mag": inj_mag})
            methane = float(np.clip(rng.normal(0.75 if is_sim else 0.3, 0.1), 0, 1))
            status = "simulated" if is_sim else ("artifact" if j == 3 else "candidate")
            cands.append({
                "candidate_id": cid, "patch_id": t.patch_id,
                "ra_deg": float(t.ra_deg + rng.uniform(-0.1, 0.1)), "dec_deg": float(t.dec_deg + rng.uniform(-0.1, 0.1)),
                "is_simulated": is_sim, "injection_id": f"INJ{cid_n:04d}" if is_sim else None,
                "injected_mag": inj_mag, "injected_distance_au": float(rng.uniform(300, 800)) if is_sim else None,
                "snr_stack": snr_stack, "snr_single_max": snr_single,
                "best_distance_au": float(rng.uniform(300, 800)),
                "best_rate_ra_arcsec_day": float(rng.normal(0, 0.5)), "best_rate_dec_arcsec_day": float(rng.normal(0, 0.3)),
                "flux_mjysr": float(amp_single * 0.01), "n_epochs": n_ep, "n_bands": int(rng.integers(8, 20)),
                "methane_score": methane, "template_best": "planet" if methane > 0.5 else "asteroid",
                "ml_score": float(np.clip(rng.normal(0.8 if is_sim else 0.4, 0.15), 0, 1)),
                "rule_score": float(np.clip(snr_stack / 10, 0, 1)),
                "crowd_p_real": 0.5, "n_votes": 0, "status": status, "known_object": None,
                "stamp_dir": f"stamps/{cid}", "dossier_path": f"dossiers/{cid}.json",
                "source": src, "created_mjd": 61000.0,
            })
            wl = np.sort(rng.uniform(0.75, 5.0, int(cands[-1]["n_bands"])))
            planet = 1.0 * np.exp(-((wl - 1.2) / 0.6) ** 2) * (1 - 0.7 * np.exp(-((wl - 3.3) / 0.25) ** 2))
            ast = 1.0 * np.exp(-((wl - 1.4) / 1.5) ** 2)
            star = 1.0 * (wl / 1.0) ** -1.5
            for w, p_, a_, s_ in zip(wl, planet, ast, star):
                f = (p_ if is_sim else a_) * amp_single * 0.01
                spec_rows.append({
                    "candidate_id": cid, "obs_id": f"SAMPLE_{int(w*1000)}", "detector": int(1 + (w - 0.75) / 4.3 * 6),
                    "mjd": 60885.0 + rng.uniform(0, 12), "wavelength_um": float(w), "bandwidth_um": float(w / 40),
                    "flux_mjysr": float(f + rng.normal(0, 0.002)), "flux_err_mjysr": 0.002,
                    "model_planet": float(p_ * amp_single * 0.01), "model_asteroid": float(a_ * amp_single * 0.01),
                    "model_star": float(s_ * amp_single * 0.01), "source": src,
                })
            (dossier_root / f"{cid}.json").write_text(json.dumps(sample_dossier(cands[-1]), indent=1))
    write_table(pd.DataFrame(cands), "candidates", out_dir / "candidates.parquet", source=src)
    write_table(pd.DataFrame(spec_rows), "spectra", out_dir / "spectra.parquet", source=src)

    # --- completeness
    comp = []
    for lo in np.arange(18.0, 23.0, 0.5):
        n = 40
        frac = 1 / (1 + np.exp((lo + 0.25 - 21.0) / 0.4))
        rec = int(round(n * frac))
        comp.append({"patch_id": "ALL", "axis": "mag", "bin_lo": lo, "bin_hi": lo + 0.5, "n_injected": n,
                     "n_recovered": rec, "fraction": rec / n, "snr_threshold": 5.0, "source": src})
    for lo in np.arange(200, 1000, 100):
        n = 25
        frac = 1 / (1 + np.exp((lo + 50 - 550) / 120))
        rec = int(round(n * frac))
        comp.append({"patch_id": "ALL", "axis": "distance_au", "bin_lo": float(lo), "bin_hi": float(lo + 100),
                     "n_injected": n, "n_recovered": rec, "fraction": rec / n, "snr_threshold": 5.0, "source": src})
    write_table(pd.DataFrame(comp), "completeness", out_dir / "completeness.parquet", source=src)

    (out_dir / "bundle.json").write_text(json.dumps({
        "kind": "SAMPLE", "generated_at": now_iso(), "note": "Synthetic placeholder bundle. Not NASA data.",
        "frac_excluded_prior": frac_prior, "frac_excluded_deepfield": frac_df,
    }, indent=1))
    # The globe texture belongs in the bundle, not only in the web folder: the API serves
    # /files from here, and a missing texture 404s the home page's globe.
    from deepfield.export_demo import MAP_TEXTURE, write_map_texture
    write_map_texture(prior, nside, out_dir / MAP_TEXTURE)
    return {"candidates": len(cands), "spectra": len(spec_rows), "patches": len(targets)}


def sample_dossier(c: dict) -> dict:
    sim = bool(c["is_simulated"])
    return {
        "candidate_id": c["candidate_id"], "generated_at": now_iso(), "generator": "sample-template",
        "is_simulated": sim,
        "scout": {"summary": f"{'SIMULATED injection. ' if sim else ''}Stacked SNR {c['snr_stack']:.1f} over {c['n_epochs']} epochs; "
                             f"best single-frame SNR {c['snr_single_max']:.1f}.",
                  "facts": [f"patch {c['patch_id']}", f"{c['n_bands']} SPHEREx bands measured"]},
        "skeptic": {"checks": [
            {"name": "known_object", "result": "no JPL SBIdent match (sample)"},
            {"name": "single_frame_visible", "result": "no" if c["snr_single_max"] < 3 else "yes"},
            {"name": "artifact_flags", "result": "none in aperture (sample)"},
        ], "verdict": "sample"},
        "reporter": {"headline": "Sample dossier", "dossier_md": "This is placeholder text from the SAMPLE bundle.", "mpc_report": None},
        "verdict": "simulated" if sim else c["status"], "confidence": 0.5,
        "sources": [c["source"]],
    }
