"""JPL Small-Body Identification API: known asteroids/comets in a field at a time."""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from deepfield.config import CACHE_DIR
from deepfield.data.manifest import fetch

SBIDENT_URL = "https://ssd-api.jpl.nasa.gov/sb_ident.api"
SOURCE = "NASA JPL Small-Body Identification API (ssd-api.jpl.nasa.gov)"


def _mjd_to_iso(mjd: float) -> str:
    from astropy.time import Time
    return Time(mjd, format="mjd").isot.replace("T", "_")[:19]


def known_bodies(ra_deg: float, dec_deg: float, half_width_deg: float, mjd: float, vmag_lim: float = 24.0,
                 timeout: float = 600.0) -> pd.DataFrame:
    """Known small bodies inside a box, as seen from the geocentre (MPC code 500).

    SPHEREx is in low-Earth orbit; the geocentre is within ~10" of its view of a main-belt asteroid,
    well inside our 6" pixels + matching radius. Columns: name, ra_deg, dec_deg, vmag.
    """
    cache = CACHE_DIR / "sbident" / f"{ra_deg:.3f}_{dec_deg:.3f}_{half_width_deg:.3f}_{mjd:.3f}.json"
    if cache.exists():
        d = json.loads(cache.read_text())
    else:
        params = {
            "sb-kind": "a", "mpc-code": "500", "obs-time": _mjd_to_iso(mjd),
            "fov-ra-center": _deg_to_sex(ra_deg, hours=True), "fov-dec-center": _deg_to_sex(dec_deg, hours=False),
            "fov-ra-hwidth": f"{half_width_deg * 60:.2f}", "fov-dec-hwidth": f"{half_width_deg * 60:.2f}",
            "two-pass": "true", "suppress-first-pass": "true", "mag-required": "true", "vmag-lim": f"{vmag_lim}",
        }
        r = fetch(SBIDENT_URL, params=params, timeout=timeout)
        d = r.json()
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(d))
    rows = []
    fields = d.get("fields_second") or d.get("fields_first") or []
    data = d.get("data_second_pass") or d.get("data_first_pass") or []
    fmap = {f.lower(): i for i, f in enumerate(fields)}

    def col(rec, *keys):
        for k in keys:
            for name, i in fmap.items():
                if name.startswith(k):
                    return rec[i]
        return None

    limit_arcsec = half_width_deg * 3600.0 * 1.5
    for rec in data:
        try:
            dist = float(str(col(rec, "dist. from center norm")).replace("E", "e"))
            if dist > limit_arcsec:
                continue
            ra = _sex_to_deg(col(rec, "astrometric ra"), hours=True)
            dec = _sex_to_deg(col(rec, "astrometric dec"), hours=False)
        except Exception:
            continue
        vm = col(rec, "visual magnitude")
        try:
            vmf = float(vm)
        except (TypeError, ValueError):
            vmf = float("nan")
        rows.append({"name": col(rec, "object name"), "ra_deg": ra, "dec_deg": dec, "vmag": vmf})
    return pd.DataFrame(rows, columns=["name", "ra_deg", "dec_deg", "vmag"])


def _deg_to_sex(deg: float, hours: bool) -> str:
    v = deg / 15.0 if hours else deg
    sign = "-" if v < 0 else ("" if hours else "+")
    v = abs(v)
    h = int(v); m = int((v - h) * 60); s = ((v - h) * 60 - m) * 60
    return f"{sign}{h:02d}-{m:02d}-{s:05.2f}"


def _sex_to_deg(s, hours: bool) -> float:
    if s is None:
        raise ValueError
    if isinstance(s, (int, float)):
        return float(s)
    parts = str(s).replace(":", " ").replace("'", " ").replace('"', " ").split()
    sign = -1 if parts[0].startswith("-") else 1
    a, b, c = (abs(float(parts[0])), float(parts[1]), float(parts[2])) if len(parts) >= 3 else (abs(float(parts[0])), 0.0, 0.0)
    v = a + b / 60 + c / 3600
    return sign * v * (15.0 if hours else 1.0)


def match_known(df: pd.DataFrame, ra: float, dec: float, radius_arcsec: float = 30.0) -> str | None:
    if df is None or len(df) == 0:
        return None
    import numpy as np
    dra = (df.ra_deg.values - ra) * np.cos(np.radians(dec)) * 3600
    ddec = (df.dec_deg.values - dec) * 3600
    sep = np.hypot(dra, ddec)
    k = int(np.argmin(sep))
    return str(df.name.values[k]) if sep[k] <= radius_arcsec else None
