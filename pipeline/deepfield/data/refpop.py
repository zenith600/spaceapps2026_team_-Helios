"""Caltech Planet Nine reference population v3 (Brown 2023), CaltechDATA 10.22002/8fjad-x7y61.

Columns (verified against the file header on 2026-11-13):
  index, mass (M_earth), a (AU), e, inc (deg), varpi (longitude of perihelion, deg),
  Omega (longitude of ascending node, deg), M (mean anomaly at epoch, deg),
  ra, dec (deg, at epoch), R (heliocentric distance at epoch, AU), rad (R_earth),
  albedo, V (mag at epoch), ZTF, DES, PS1 (1 = that survey would have detected it).
Epoch JD 2458270.0 (2018-06-01). J2000 heliocentric osculating elements.
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd

from deepfield.config import CACHE_DIR
from deepfield.data.manifest import dataset, download

COLUMNS = ["index", "mass", "a", "e", "inc", "varpi", "Omega", "M", "ra", "dec", "R", "rad", "albedo", "V",
           "ZTF", "DES", "PS1"]
SOURCE = "Caltech Planet Nine reference population v3 (Brown 2023, doi:10.22002/8fjad-x7y61)"


def refpop_path() -> Path:
    return CACHE_DIR / "refpop" / "reference_population.csv"


def ensure_refpop() -> Path:
    p = refpop_path()
    if not p.exists():
        ds = dataset("p9_reference_population")
        download(ds["access"][0], p, params={"download": "1"}, expected_md5=ds.get("md5"))
    return p


def load_refpop() -> pd.DataFrame:
    p = ensure_refpop()
    df = pd.read_csv(p, comment="#", skipinitialspace=True)
    df.columns = [c.strip() for c in df.columns]
    missing = set(COLUMNS) - set(df.columns)
    if missing:
        raise RuntimeError(f"reference population columns changed; missing {missing}")
    df["excluded_prior"] = (df["ZTF"] == 1) | (df["DES"] == 1) | (df["PS1"] == 1)
    return df
