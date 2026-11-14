"""Observer (Earth / SPHEREx) heliocentric positions.

Primary: JPL Horizons vectors for SPHEREx (-163182), cached on disk.
Fallback: astropy's built-in Earth ephemeris (no network). The difference
(< 10^4 km) is far below our parallax sensitivity at hundreds of AU.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import numpy as np

from deepfield.config import CACHE_DIR, SPHEREX_HORIZONS_ID
from deepfield.data.manifest import fetch

HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"


def earth_heliocentric_icrs(jd: np.ndarray | float) -> np.ndarray:
    """Earth heliocentric ICRS xyz (AU) from astropy's built-in ephemeris. Shape (T,3)."""
    from astropy.coordinates import get_body_barycentric
    from astropy.time import Time
    t = Time(np.atleast_1d(np.asarray(jd, float)), format="jd", scale="tdb")
    e = get_body_barycentric("earth", t)
    s = get_body_barycentric("sun", t)
    rel = (e.xyz - s.xyz).to_value("AU").T
    return rel


def _cache_path(target: str, jd0: float, jd1: float, step: str) -> Path:
    return CACHE_DIR / "horizons" / f"{target.strip('-')}_{jd0:.3f}_{jd1:.3f}_{step}.json"


def horizons_vectors(jd_start: float, jd_stop: float, step: str = "1d", target: str = SPHEREX_HORIZONS_ID) -> dict:
    """Heliocentric ICRF state vectors from Horizons; returns {'jd': [...], 'xyz': [[x,y,z],...]} in AU."""
    p = _cache_path(target, jd_start, jd_stop, step)
    if p.exists():
        return json.loads(p.read_text())
    params = {
        "format": "json", "COMMAND": f"'{target}'", "OBJ_DATA": "'NO'", "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'VECTORS'", "CENTER": "'500@10'", "START_TIME": f"'JD{jd_start:.6f}'",
        "STOP_TIME": f"'JD{jd_stop:.6f}'", "STEP_SIZE": f"'{step}'", "OUT_UNITS": "'AU-D'",
        "REF_PLANE": "'FRAME'", "VEC_TABLE": "'1'", "CSV_FORMAT": "'YES'",
    }
    r = fetch(HORIZONS_URL, params=params, timeout=120)
    text = r.json().get("result", "")
    m = re.search(r"\$\$SOE(.*?)\$\$EOE", text, re.S)
    if not m:
        raise RuntimeError("Horizons returned no ephemeris: " + text[:400])
    jds, xyz = [], []
    for line in m.group(1).strip().splitlines():
        parts = [s.strip() for s in line.split(",")]
        if len(parts) < 5:
            continue
        jds.append(float(parts[0]))
        xyz.append([float(parts[2]), float(parts[3]), float(parts[4])])
    out = {"jd": jds, "xyz": xyz, "target": target, "source": "JPL Horizons (ssd.jpl.nasa.gov), heliocentric ICRF"}
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(out))
    return out


def observer_positions(jd: np.ndarray, prefer_horizons: bool = True) -> tuple[np.ndarray, str]:
    """Observer heliocentric ICRS xyz (AU) at each JD. Returns (T,3) and a source label."""
    jd = np.atleast_1d(np.asarray(jd, float))
    if prefer_horizons:
        try:
            jd0, jd1 = float(np.floor(jd.min())) - 1, float(np.ceil(jd.max())) + 1
            step = "1h" if (jd1 - jd0) < 60 else "6h"
            h = horizons_vectors(jd0, jd1, step)
            hj, hx = np.asarray(h["jd"]), np.asarray(h["xyz"])
            out = np.stack([np.interp(jd, hj, hx[:, k]) for k in range(3)], axis=1)
            return out, "JPL Horizons SPHEREx (-163182) heliocentric ICRF"
        except Exception as exc:  # network down, DEMO_MODE, etc.
            label = f"astropy built-in Earth ephemeris (Horizons unavailable: {type(exc).__name__})"
            return earth_heliocentric_icrs(jd), label
    return earth_heliocentric_icrs(jd), "astropy built-in Earth ephemeris"
