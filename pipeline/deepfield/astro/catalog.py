"""Reference catalogues for validation and source identification, with provenance.

Sources (all open; NASA archives first, per manifest.yaml):

- **Gaia DR3** (`gaia_dr3_source`) via IRSA's Gator service (NASA/IPAC mirror of the ESA
  catalogue). IRSA's TAP proxy and ESA's archive were both failing on 2026-11-15; Gator on the
  same allowlisted IRSA host works. ESA TAP is kept as a fallback.
- **2MASS Extended Source Catalog** (`fp_xsc`) and **AllWISE** (`allwise_p3as_psd`, for its
  `ext_flg` extended-source flag) via Gator.
- **NED** (NASA/IPAC Extragalactic Database) object directory via NED TAP, for object types
  (`prefphytype`) and redshifts.

Every call has a timeout, retries with backoff (in `deepfield.data.manifest.fetch`, which also
enforces the domain allowlist on every redirect hop), and an on-disk cache. Each result carries
a provenance record (service, table, query, retrieval time, row count, sha256 of the raw
response). Nothing here claims completeness: Gaia misses most galaxies and very red objects,
2MASS XSC reaches K≈13.5, NED's coverage is heterogeneous.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from deepfield.config import CACHE_DIR
from deepfield.data.manifest import fetch

GATOR_URL = "https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query"
NED_TAP = "https://ned.ipac.caltech.edu/tap/sync"
ESA_GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"
CAT_DIR = CACHE_DIR / "catalogs" / "v2"

GAIA_COLS = [
    "source_id", "ra", "dec", "ra_error", "dec_error", "parallax", "parallax_error",
    "pmra", "pmra_error", "pmdec", "pmdec_error",
    "ra_dec_corr", "ra_parallax_corr", "ra_pmra_corr", "ra_pmdec_corr", "dec_parallax_corr",
    "dec_pmra_corr", "dec_pmdec_corr", "parallax_pmra_corr", "parallax_pmdec_corr", "pmra_pmdec_corr",
    "ruwe", "astrometric_params_solved", "astrometric_excess_noise", "duplicated_source",
    "phot_g_mean_mag", "phot_bp_mean_mag", "phot_rp_mean_mag", "radial_velocity",
    "classprob_dsc_combmod_galaxy", "classprob_dsc_combmod_star", "in_qso_candidates", "in_galaxy_candidates",
]
XSC_COLS = ["designation", "ra", "dec", "r_k20fe", "k_m_k20fe", "j_m_k20fe", "sup_ba", "sup_phi", "e_score", "g_score"]
ALLWISE_COLS = ["designation", "ra", "dec", "sigra", "sigdec", "w1mpro", "w1sigmpro", "w2mpro", "ext_flg", "nb", "cc_flags"]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _cache_paths(kind: str, key: str) -> tuple[Path, Path]:
    h = hashlib.sha1(key.encode()).hexdigest()[:16]
    CAT_DIR.mkdir(parents=True, exist_ok=True)
    return CAT_DIR / f"{kind}_{h}.csv", CAT_DIR / f"{kind}_{h}.json"


def _cached(kind: str, key: str, getter) -> tuple[pd.DataFrame, dict]:
    csv, meta = _cache_paths(kind, key)
    if csv.exists() and meta.exists():
        prov = json.loads(meta.read_text())
        prov["from_cache"] = True
        return pd.read_csv(csv, dtype={"source_id": str, "designation": str}), prov
    df, prov = getter()
    df.to_csv(csv, index=False)
    prov["from_cache"] = False
    meta.write_text(json.dumps(prov, indent=1))
    return df, prov


def gator_cone(catalog: str, ra: float, dec: float, radius_arcsec: float, cols: list[str],
               *, timeout: float = 120.0, retries: int = 3) -> tuple[pd.DataFrame, dict]:
    """IRSA Gator cone search → (DataFrame, provenance). Cached."""
    from astropy.io import ascii as aio
    params = {"catalog": catalog, "spatial": "cone", "objstr": f"{ra:.7f} {dec:+.7f}",
              "radius": f"{radius_arcsec:.2f}", "radunits": "arcsec", "outfmt": "1", "selcols": ",".join(cols)}
    key = json.dumps(params, sort_keys=True)

    def get():
        t0 = time.time()
        r = fetch(GATOR_URL, params=params, timeout=timeout, retries=retries)
        text = r.text
        if "[struct stat=" in text and "ERROR" in text:
            raise RuntimeError(f"Gator error for {catalog}: {text[:300]}")
        if text.strip().startswith("<") or "\\fixlen" not in text and "|" not in text[:2000]:
            raise RuntimeError(f"unexpected Gator response for {catalog}: {text[:200]!r}")
        t = aio.read(text, format="ipac", guess=False)
        df = t.to_pandas() if len(t) else pd.DataFrame(columns=cols)
        for c in df.columns:
            if df[c].dtype == object:
                df[c] = df[c].astype(str)
        prov = {"service": "IRSA Gator", "url": GATOR_URL, "catalog": catalog, "params": params,
                "retrieved_at": _now(), "n_rows": int(len(df)), "seconds": round(time.time() - t0, 2),
                "sha256": hashlib.sha256(text.encode()).hexdigest()}
        return df, prov
    return _cached(f"gator_{catalog}", key, get)


def gaia_dr3(ra: float, dec: float, radius_arcsec: float) -> tuple[pd.DataFrame, dict]:
    """Gaia DR3 sources with full 5-parameter astrometry and correlations, plus galaxy/QSO flags."""
    df, prov = gator_cone("gaia_dr3_source", ra, dec, radius_arcsec, GAIA_COLS)
    if len(df):
        df["source_id"] = df["source_id"].astype(str)
        for c in GAIA_COLS[1:]:
            if c in df and c not in ("duplicated_source", "in_qso_candidates", "in_galaxy_candidates"):
                df[c] = pd.to_numeric(df[c], errors="coerce")
    prov["release"] = "Gaia DR3 (reference epoch J2016.0)"
    return df, prov


#: Quality filter for using a Gaia source as an astrometric reference. Documented on /proof.
GAIA_REF_FILTER = {
    "ruwe_max": 1.4,                    # well-behaved single-star solution (Lindegren et al. 2021)
    "params_solved": (31, 95),          # 5- or 6-parameter solutions only (has pm and parallax)
    "g_min": 8.0, "g_max": 19.5,        # avoid Gaia-bright saturation issues and the faint end
    "no_duplicated_source": True,
}


def gaia_reference_mask(df: pd.DataFrame, f: dict = GAIA_REF_FILTER) -> np.ndarray:
    ok = np.ones(len(df), bool)
    ok &= pd.to_numeric(df.get("ruwe"), errors="coerce").fillna(99).to_numpy() < f["ruwe_max"]
    ok &= pd.to_numeric(df.get("astrometric_params_solved"), errors="coerce").fillna(3).isin(f["params_solved"]).to_numpy()
    g = pd.to_numeric(df.get("phot_g_mean_mag"), errors="coerce").to_numpy()
    ok &= (g >= f["g_min"]) & (g <= f["g_max"])
    if f.get("no_duplicated_source") and "duplicated_source" in df:
        ok &= ~df["duplicated_source"].astype(str).str.lower().isin(["true", "t", "1"]).to_numpy()
    return ok


def twomass_xsc(ra: float, dec: float, radius_arcsec: float):
    df, prov = gator_cone("fp_xsc", ra, dec, radius_arcsec, XSC_COLS)
    prov["release"] = "2MASS Extended Source Catalog (All-Sky Release)"
    return df, prov


def allwise(ra: float, dec: float, radius_arcsec: float):
    df, prov = gator_cone("allwise_p3as_psd", ra, dec, radius_arcsec, ALLWISE_COLS)
    prov["release"] = "AllWISE Source Catalog"
    return df, prov


def ned_cone(ra: float, dec: float, radius_arcsec: float, *, timeout: float = 90.0) -> tuple[pd.DataFrame, dict]:
    """NED object directory cone: names, positions, physical type and redshift."""
    q = ("SELECT prefname, ra, dec, prefphytype, z, zunc, zflag, uncmaja, uncmina, n_crosref "
         f"FROM objdir WHERE CONTAINS(POINT('J2000',ra,dec),CIRCLE('J2000',{ra:.7f},{dec:+.7f},{radius_arcsec / 3600:.6f}))=1")

    def get():
        t0 = time.time()
        r = fetch(NED_TAP, params={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": q},
                  timeout=timeout, retries=3)
        text = r.text
        if not text.lstrip().lower().startswith("prefname"):
            raise RuntimeError(f"unexpected NED response: {text[:200]!r}")
        df = pd.read_csv(io.StringIO(text))
        prov = {"service": "NED TAP", "url": NED_TAP, "query": q, "retrieved_at": _now(),
                "n_rows": int(len(df)), "seconds": round(time.time() - t0, 2),
                "sha256": hashlib.sha256(text.encode()).hexdigest(), "release": "NED (live database)"}
        return df, prov
    return _cached("ned_objdir", q, get)


def safe(call, *args, **kw) -> tuple[pd.DataFrame | None, dict]:
    """Run a catalogue call; on failure return (None, {"error": ...}) so processing never breaks."""
    try:
        return call(*args, **kw)
    except Exception as exc:  # noqa: BLE001 - recorded, not swallowed silently
        return None, {"error": f"{type(exc).__name__}: {exc}"[:400], "retrieved_at": _now()}


def cone_radius_for_wcs(wcs, shape) -> tuple[float, float, float]:
    """(ra, dec, radius_arcsec) covering a cutout, from its own WCS, with a 10 % margin."""
    ny, nx = shape
    cx, cy = (nx - 1) / 2, (ny - 1) / 2
    ra0, dec0 = wcs.all_pix2world([[cx, cy]], 0)[0]
    corners = wcs.all_pix2world([[0, 0], [nx - 1, 0], [0, ny - 1], [nx - 1, ny - 1]], 0)
    from deepfield.astro.astrometry import angular_sep_arcsec
    r = float(np.max(angular_sep_arcsec(corners[:, 0], corners[:, 1], ra0, dec0)))
    return float(ra0), float(dec0), r * 1.1 + 30.0
