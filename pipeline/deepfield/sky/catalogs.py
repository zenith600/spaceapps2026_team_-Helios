"""Known-source overlays: Gaia, AllWISE and 2MASS positions for a Sky Viewer field.

The brief suggests overlaying other missions, and the reason is practical rather than
decorative: without it, a user watching a dot in the time-lapse has no way to tell a
catalogued star from something nobody has listed. With it, the unlabelled dots are the
interesting ones.

Each catalogue is a TAP cone search, cached to disk. Everything degrades: a service that
is slow or down removes its layer and leaves the rest of the viewer working.
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import time
from dataclasses import dataclass

import pandas as pd

from deepfield.config import CACHE_DIR

log = logging.getLogger("deepfield.sky.catalogs")

IRSA_TAP = "https://irsa.ipac.caltech.edu/TAP/sync"
GAIA_TAP = "https://gea.esac.esa.int/tap-server/tap/sync"

CACHE_HOURS = 24 * 30          # catalogues of static sources do not change hour to hour


@dataclass(frozen=True)
class Catalog:
    id: str
    name: str
    owner: str
    colour: str                 # marker colour in the UI
    note: str


CATALOGS: tuple[Catalog, ...] = (
    Catalog("gaia", "Gaia DR3", "ESA", "#60a5fa",
            "Precise positions and motions for about two billion stars, measured in visible light."),
    Catalog("allwise", "AllWISE", "NASA/IPAC", "#f472b6",
            "Infrared sources from NASA's WISE survey — the closest match to what SPHEREx sees."),
    Catalog("twomass", "2MASS", "NASA/NSF", "#22c55e",
            "The classic near-infrared sky survey, good for bright stars."),
)
BY_ID = {c.id: c for c in CATALOGS}


def _cache(name: str, ra: float, dec: float, radius: float):
    key = hashlib.sha1(f"{name}|{ra:.5f}|{dec:.5f}|{radius:.5f}".encode()).hexdigest()[:16]
    return CACHE_DIR / "catalogs" / f"{name}_{key}.parquet"


def _tap_csv(url: str, query: str, timeout: float) -> pd.DataFrame:
    from deepfield.data.manifest import fetch
    r = fetch(url, params={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query},
              timeout=timeout, retries=1)
    return pd.read_csv(io.StringIO(r.text))


def _query(cat_id: str, ra: float, dec: float, radius_deg: float, limit: int, timeout: float) -> pd.DataFrame:
    """One cone search. Column names differ per archive, so each is normalised here."""
    if cat_id == "gaia":
        q = (f"SELECT TOP {limit} ra, dec, phot_g_mean_mag AS mag, pmra, pmdec, parallax "
             f"FROM gaiadr3.gaia_source "
             f"WHERE 1=CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {radius_deg})) "
             f"ORDER BY phot_g_mean_mag")
        df = _tap_csv(GAIA_TAP, q, timeout)
        df["band"] = "G"
    elif cat_id == "allwise":
        q = (f"SELECT TOP {limit} ra, dec, w1mpro AS mag, w2mpro, w3mpro "
             f"FROM allwise_p3as_psd "
             f"WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {radius_deg}))=1 "
             f"ORDER BY w1mpro")
        df = _tap_csv(IRSA_TAP, q, timeout)
        df["band"] = "W1"
    elif cat_id == "twomass":
        q = (f"SELECT TOP {limit} ra, dec, j_m AS mag, h_m, k_m "
             f"FROM fp_psc "
             f"WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {radius_deg}))=1 "
             f"ORDER BY j_m")
        df = _tap_csv(IRSA_TAP, q, timeout)
        df["band"] = "J"
    else:
        raise KeyError(cat_id)
    return df


def cone_search(cat_id: str, ra: float, dec: float, radius_deg: float, *, limit: int = 300,
                timeout: float = 90.0, max_age_hours: float = CACHE_HOURS) -> pd.DataFrame:
    """Cached cone search. Returns an empty frame on any failure rather than raising."""
    path = _cache(cat_id, ra, dec, radius_deg)
    if path.exists() and (time.time() - path.stat().st_mtime) < max_age_hours * 3600:
        try:
            return pd.read_parquet(path)
        except Exception:
            pass
    try:
        df = _query(cat_id, ra, dec, radius_deg, limit, timeout)
    except Exception as exc:
        log.warning("%s cone search failed at %.4f %.4f: %s: %s", cat_id, ra, dec,
                    type(exc).__name__, str(exc)[:160])
        return pd.DataFrame(columns=["ra", "dec", "mag", "band"])
    df = df.rename(columns=str.lower)
    for c in ("ra", "dec", "mag"):
        if c not in df.columns:
            df[c] = float("nan")
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        df.to_parquet(path)
    except Exception:
        pass
    return df


def overlay_for_bundle(meta: dict, cat_ids=None, *, limit: int = 300) -> dict:
    """Catalogue markers in *pixel* coordinates of this bundle's grid, ready to draw."""
    import numpy as np
    from astropy.wcs import WCS

    w = WCS(naxis=2)
    w.wcs.ctype = meta["wcs"]["ctype"]
    w.wcs.crval = meta["wcs"]["crval"]
    w.wcs.crpix = meta["wcs"]["crpix"]
    w.wcs.cdelt = meta["wcs"]["cdelt"]
    npix = int(meta["npix"])
    radius = float(meta["fov_deg"]) * 0.75      # a little beyond the frame, for edge sources

    from deepfield.sky.resolver import GAIA_DR3_EPOCH_MJD

    mid = 0.5 * (float(meta["coverage"]["mjd_min"]) + float(meta["coverage"]["mjd_max"]))
    layers = []
    for cid in (cat_ids or [c.id for c in CATALOGS]):
        cat = BY_ID.get(cid)
        if cat is None:
            continue
        df = cone_search(cid, float(meta["ra_deg"]), float(meta["dec_deg"]), radius, limit=limit)
        ra = df["ra"].to_numpy(float) if len(df) else np.array([])
        dec = df["dec"].to_numpy(float) if len(df) else np.array([])
        # Gaia carries its own proper motions: each source is placed where it is during this
        # survey and given a velocity in pixels/yr, so the viewer can move it frame by frame.
        # Without this a fast mover's ring sits where it was in 2016 -- 15 px away for
        # Barnard's Star. The other catalogues have no usable motions and stay at their epoch.
        has_pm = cid == "gaia" and len(df) and {"pmra", "pmdec"} <= set(df.columns)
        vx = vy = None
        if has_pm:
            pmra = np.nan_to_num(df["pmra"].to_numpy(float))
            pmdec = np.nan_to_num(df["pmdec"].to_numpy(float))
            cosd = np.cos(np.radians(dec))

            def at(mjd):
                dt = (mjd - GAIA_DR3_EPOCH_MJD) / 365.25
                return ra + pmra * dt / 3.6e6 / cosd, dec + pmdec * dt / 3.6e6

            x, y = w.all_world2pix(*at(mid), 0)
            x1, y1 = w.all_world2pix(*at(mid + 365.25), 0)
            vx, vy = x1 - x, y1 - y
        elif len(df):
            x, y = w.all_world2pix(ra, dec, 0)
        else:
            x = y = np.array([])
        sources = []
        for k, (xi, yi, mag) in enumerate(zip(x, y, df["mag"].to_numpy(float) if len(df) else [])):
            if not (np.isfinite(xi) and np.isfinite(yi)):
                continue
            if -2 <= xi <= npix + 1 and -2 <= yi <= npix + 1:
                s = {"x": round(float(xi), 2), "y": round(float(yi), 2),
                     "mag": None if not np.isfinite(mag) else round(float(mag), 2)}
                if has_pm and (abs(vx[k]) > 1e-4 or abs(vy[k]) > 1e-4):
                    s["vx"], s["vy"] = round(float(vx[k]), 4), round(float(vy[k]), 4)
                sources.append(s)
        layer = {"id": cat.id, "name": cat.name, "owner": cat.owner, "colour": cat.colour,
                 "note": cat.note, "n": len(sources), "sources": sources,
                 "band": str(df["band"].iloc[0]) if len(df) and "band" in df else None,
                 "epoch_mjd": mid if has_pm else CATALOG_EPOCH_MJD.get(cid),
                 "moves": bool(has_pm)}
        layers.append(layer)
    return {"layers": layers, "radius_deg": radius,
            "note": ("Catalogued sources from other missions, placed on this image's own grid. Gaia "
                     "markers follow Gaia's own proper motions to each frame's date; AllWISE (2010) and "
                     "2MASS (1997-2001) markers stay where those surveys saw them. A dot with no marker "
                     "is not in these catalogues — too faint for them, or it has moved since.")}


#: Mean observing epoch of catalogues that have no usable proper motions.
CATALOG_EPOCH_MJD = {"allwise": 55400.0, "twomass": 51300.0}


def write_overlay(meta: dict, path, cat_ids=None) -> dict:
    out = overlay_for_bundle(meta, cat_ids)
    from pathlib import Path
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(out))
    return out
