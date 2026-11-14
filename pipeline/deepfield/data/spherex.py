"""SPHEREx DR1/QR3 access: IVOA SIA2 search at IRSA and the IRSA cutout service, with a disk cache.

Verified 2026-11-13:
  SIA2:    https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_dr1&POS=circle ra dec r&RESPONSEFORMAT=votable
  cutout:  <access_url>?center=ra,dec&size=deg  -> MEF with IMAGE, FLAGS, VARIANCE, ZODI, EPSF, WCS-WAVE
"""
from __future__ import annotations

import hashlib
import io
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from deepfield.config import CACHE_DIR
from deepfield.data.manifest import download, fetch

SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
COLLECTIONS = ("spherex_dr1", "spherex_qr3")
SOURCE = "NASA SPHEREx DR1 Level 2 spectral images via IRSA (irsa.ipac.caltech.edu)"

# FLAGS bit planes (from the FITS header MSKN/MSKM keywords of a real cutout)
FLAG_BITS = {
    "TRANSIENT": 1 << 0, "OVERFLOW": 1 << 1, "SUR_ERROR": 1 << 2, "NONFUNC": 1 << 6, "DICHROIC": 1 << 7,
    "MISSING_DATA": 1 << 9, "HOT": 1 << 10, "COLD": 1 << 11, "FULLSAMPLE": 1 << 12, "PHANMISS": 1 << 14,
    "NONLINEAR": 1 << 15, "PERSIST": 1 << 17, "OUTLIER": 1 << 19, "CROSSTALK": 1 << 20, "SOURCE": 1 << 21,
    "GHOST": 1 << 22, "GHOST_FPA": 1 << 23, "GHOST_EXT": 1 << 24, "STREAK": 1 << 25, "BLOOM": 1 << 26,
    "SNOWBALL": 1 << 27, "HALO": 1 << 28,
}
BAD_MASK = sum(FLAG_BITS[k] for k in ("TRANSIENT", "OVERFLOW", "SUR_ERROR", "NONFUNC", "MISSING_DATA", "HOT", "COLD",
                                      "NONLINEAR", "PERSIST", "OUTLIER", "GHOST", "GHOST_FPA", "GHOST_EXT", "STREAK",
                                      "BLOOM", "SNOWBALL", "HALO"))


def _key(*parts) -> str:
    return hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:16]


def sia_search(ra: float, dec: float, radius_deg: float, collection: str = "spherex_dr1") -> pd.DataFrame:
    """List SPHEREx exposures covering a circle. Cached as parquet."""
    from astropy.io.votable import parse_single_table
    cache = CACHE_DIR / "sia" / f"{collection}_{_key(round(ra, 4), round(dec, 4), round(radius_deg, 4))}.parquet"
    if cache.exists():
        return pd.read_parquet(cache)
    r = fetch(SIA_URL, params={"COLLECTION": collection, "POS": f"circle {ra} {dec} {radius_deg}",
                               "RESPONSEFORMAT": "votable"}, timeout=180)
    table = parse_single_table(io.BytesIO(r.content)).to_table(use_names_over_ids=True)
    df = table.to_pandas()
    for c in df.columns:
        if df[c].dtype == object:
            df[c] = df[c].apply(lambda v: v.decode() if isinstance(v, bytes) else v)
    if len(df) == 0:
        df = pd.DataFrame(columns=["obs_id", "access_url", "t_min", "t_max", "s_ra", "s_dec", "em_min", "em_max",
                                   "energy_bandpassname", "cloud_access"])
    df["detector"] = df["energy_bandpassname"].str.extract(r"D(\d)").astype(float).fillna(0).astype(int)
    df["collection"] = collection
    cache.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(cache)
    return df


def group_visits(df: pd.DataFrame, gap_days: float = 2.0) -> pd.DataFrame:
    """Add a `visit` integer column: exposures separated by < gap_days belong to one visit."""
    df = df.sort_values("t_min").reset_index(drop=True)
    t = df["t_min"].values.astype(float)
    visit = np.zeros(len(df), dtype=int)
    for i in range(1, len(df)):
        visit[i] = visit[i - 1] + (1 if t[i] - t[i - 1] > gap_days else 0)
    df["visit"] = visit
    return df


def best_visits(df: pd.DataFrame, n_visits: int = 2, per_visit: int = 30, min_span_days: float = 3.0,
                min_gap_days: float = 60.0) -> pd.DataFrame:
    """Pick up to n_visits well-populated visits separated by >= min_gap_days (parallax baseline), cap each.

    The first pick is the most populated visit with span >= min_span_days; later picks must be far from earlier ones
    so the stack spans a real parallax baseline (SPHEREx revisits a field every ~6 months).
    """
    df = group_visits(df)
    g = df.groupby("visit").agg(n=("obs_id", "size"), t0=("t_min", "min"), t1=("t_max", "max"))
    g["span"] = g.t1 - g.t0
    g["mid"] = 0.5 * (g.t0 + g.t1)
    order = g[g.span >= min_span_days].sort_values("n", ascending=False)
    if len(order) == 0:
        order = g.sort_values("n", ascending=False)
    chosen: list[int] = []
    for v in order.index:
        if all(abs(g.loc[v, "mid"] - g.loc[c, "mid"]) >= min_gap_days for c in chosen):
            chosen.append(int(v))
        if len(chosen) >= n_visits:
            break
    parts = []
    for v in chosen:
        sel = df[df.visit == v].sort_values("t_min")
        if len(sel) > per_visit:
            idx = np.linspace(0, len(sel) - 1, per_visit).round().astype(int)
            sel = sel.iloc[np.unique(idx)]
        parts.append(sel)
    return pd.concat(parts).sort_values("t_min").reset_index(drop=True)


def best_visit(df: pd.DataFrame, max_exposures: int, min_span_days: float = 3.0) -> pd.DataFrame:
    """Pick the visit with the most exposures (prefer spans >= min_span_days), cap to max_exposures spread in time."""
    df = group_visits(df)
    g = df.groupby("visit").agg(n=("obs_id", "size"), t0=("t_min", "min"), t1=("t_max", "max"))
    g["span"] = g.t1 - g.t0
    ok = g[g.span >= min_span_days]
    chosen = (ok if len(ok) else g).sort_values("n", ascending=False).index[0]
    sel = df[df.visit == chosen].sort_values("t_min")
    if len(sel) > max_exposures:
        idx = np.linspace(0, len(sel) - 1, max_exposures).round().astype(int)
        sel = sel.iloc[np.unique(idx)]
    return sel.reset_index(drop=True)


def cutout_path(obs_id: str, detector: int, ra: float, dec: float, size_deg: float, collection: str) -> Path:
    return CACHE_DIR / "cutouts" / collection / f"{obs_id}_D{detector}_{_key(round(ra, 4), round(dec, 4), size_deg)}.fits"


def fetch_cutout(row: pd.Series, ra: float, dec: float, size_deg: float) -> Path:
    p = cutout_path(row["obs_id"], int(row["detector"]), ra, dec, size_deg, row.get("collection", "spherex_dr1"))
    if not p.exists():
        download(row["access_url"], p, params={"center": f"{ra},{dec}", "size": f"{size_deg}"}, timeout=300)
    return p


@dataclass
class Cutout:
    obs_id: str
    detector: int
    mjd: float
    image: np.ndarray      # MJy/sr
    flags: np.ndarray      # int32 bitmask
    variance: np.ndarray   # (MJy/sr)^2
    zodi: np.ndarray
    wcs: object            # astropy WCS (TAN-SIP)
    psf_fwhm_arcsec: float
    wave_um: float         # approx wavelength at cutout centre
    bandwidth_um: float
    epsf: np.ndarray | None  # 33x33, 5x oversampled, nearest bin to cutout centre
    path: str

    @property
    def good(self) -> np.ndarray:
        return (self.flags & BAD_MASK) == 0

    @property
    def mask_source(self) -> np.ndarray:
        return (self.flags & FLAG_BITS["SOURCE"]) != 0


def load_cutout(path: Path) -> Cutout:
    from astropy.io import fits
    from astropy.wcs import WCS
    with fits.open(path) as h:
        img = h["IMAGE"]
        hd = img.header
        wcs = WCS(hd)
        ny, nx = img.data.shape
        # offset of the cutout inside the full 2040x2040 detector (0-based active pixel coords)
        x0, y0 = -float(hd.get("CRPIX1A", 0)) + 1, -float(hd.get("CRPIX2A", 0)) + 1
        cx, cy = x0 + nx / 2, y0 + ny / 2
        wave, bw = _wavelength_at(h["WCS-WAVE"].data, cx, cy)
        epsf = _nearest_epsf(h["EPSF"].data, cx, cy) if "EPSF" in h else None
        return Cutout(
            obs_id=str(hd.get("OBSID", path.stem)), detector=int(hd.get("DETECTOR", 0)),
            mjd=float(hd.get("MJD-AVG", hd.get("MJD-OBS"))),
            image=np.array(img.data, dtype=np.float32), flags=np.array(h["FLAGS"].data, dtype=np.int32),
            variance=np.array(h["VARIANCE"].data, dtype=np.float32),
            zodi=np.array(h["ZODI"].data, dtype=np.float32) if "ZODI" in h else np.zeros_like(img.data, dtype=np.float32),
            wcs=wcs, psf_fwhm_arcsec=float(hd.get("PSF_FWHM", 7.5)), wave_um=wave, bandwidth_um=bw, epsf=epsf,
            path=str(path),
        )


def _wavelength_at(wavetab, x: float, y: float) -> tuple[float, float]:
    """Bilinear lookup of (wavelength, bandwidth) from the WCS-WAVE 9x9 control grid at raw detector (x, y)."""
    X = np.asarray(wavetab["X"][0], float)
    Y = np.asarray(wavetab["Y"][0], float)
    V = np.asarray(wavetab["VALUES"][0], float)  # shape (9, 9, 2) -> [iy, ix, (wave, bw)]
    ix = np.clip(np.searchsorted(X, x) - 1, 0, len(X) - 2)
    iy = np.clip(np.searchsorted(Y, y) - 1, 0, len(Y) - 2)
    fx = np.clip((x - X[ix]) / max(X[ix + 1] - X[ix], 1e-9), 0, 1)
    fy = np.clip((y - Y[iy]) / max(Y[iy + 1] - Y[iy], 1e-9), 0, 1)
    v = (V[iy, ix] * (1 - fx) * (1 - fy) + V[iy, ix + 1] * fx * (1 - fy)
         + V[iy + 1, ix] * (1 - fx) * fy + V[iy + 1, ix + 1] * fx * fy)
    return float(v[0]), float(v[1])


def _nearest_epsf(tab, x: float, y: float) -> np.ndarray | None:
    try:
        d = (np.asarray(tab["XCENTER"], float) - x) ** 2 + (np.asarray(tab["YCENTER"], float) - y) ** 2
        k = int(np.argmin(d))
        e = np.asarray(tab["EPSF"][k], float)
        return e / max(e.sum(), 1e-12)
    except Exception:
        return None


def epsf_to_pixel_kernel(epsf: np.ndarray | None, oversample: int = 5, fwhm_px: float = 1.22) -> np.ndarray:
    """Down-sample a 5x oversampled ePSF to native pixels; fall back to a Gaussian of the header FWHM."""
    if epsf is not None and epsf.shape[0] % oversample == 3:  # 33 = 6*5+3 -> centre aligned
        n = epsf.shape[0]
        pad = (oversample - n % oversample) % oversample
        e = np.pad(epsf, ((0, pad), (0, pad)))
        m = e.shape[0] // oversample
        k = e.reshape(m, oversample, m, oversample).sum(axis=(1, 3))
        k = k[:7, :7] if m >= 7 else k
        return k / k.sum()
    s = fwhm_px / 2.3548
    y, x = np.mgrid[-3:4, -3:4]
    k = np.exp(-(x ** 2 + y ** 2) / (2 * s ** 2))
    return k / k.sum()


def summarise_cutout_set(cuts: list[Cutout]) -> dict:
    return {"n": len(cuts), "mjd_min": min(c.mjd for c in cuts), "mjd_max": max(c.mjd for c in cuts),
            "detectors": sorted({c.detector for c in cuts}), "n_bands": len({round(c.wave_um, 2) for c in cuts}),
            "source": SOURCE}


def save_json(obj, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=1, default=str))
