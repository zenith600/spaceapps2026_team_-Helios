"""One original SPHEREx Level 2 exposure (a cutout file), with everything needed to measure it.

Unlike the Sky Viewer's views, nothing here is resampled: the image, variance and flags are
the pipeline's own pixels, and the official TAN-SIP WCS is used as published. The ePSF table
(21×21 detector zones, 5× oversampled) and the per-pixel wavelength table are kept so each
star gets the PSF and wavelength at its own detector position.

Provenance read from the file (never invented): OBSID, EXPIDN, DETECTOR, MJD-AVG, exposure
time, pipeline VERSION, calibration-file UUIDs from HISTORY, ePSF and spectral-WCS calibration
file names, the pipeline's astrometric QA (ASTRONETSOLVED, FINAST, MATCH_NSTARS,
QS_NMATCH_VAR), DQA outcomes, the spacecraft's geocentric position, and a SHA-256 of the file.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from deepfield.data.spherex import BAD_MASK, FLAG_BITS

#: Saturation / non-linearity: a star whose core has these bits is unsuitable for PSF fitting.
SATURATION_MASK = FLAG_BITS["OVERFLOW"] | FLAG_BITS["NONLINEAR"]


@dataclass
class Exposure:
    path: str
    obs_id: str
    expid: str
    detector: int
    collection: str
    mjd: float
    exptime_s: float
    image: np.ndarray
    variance: np.ndarray
    flags: np.ndarray
    wcs: object
    det_x0: float                 # detector x of cutout pixel 0 (0-based active pixels)
    det_y0: float
    epsf_xc: np.ndarray           # (n_zones,) detector x of zone centres
    epsf_yc: np.ndarray
    epsf: np.ndarray              # (n_zones, 33, 33), sum 1 each, 5× oversampled
    oversample: int
    wave_table: dict
    sc_geocentric_km: np.ndarray | None
    psf_fwhm_arcsec: float
    provenance: dict = field(default_factory=dict)

    @property
    def shape(self):
        return self.image.shape

    @property
    def bad(self) -> np.ndarray:
        return ((self.flags & BAD_MASK) != 0) | ~np.isfinite(self.image) | ~np.isfinite(self.variance) | (self.variance <= 0)

    @property
    def saturated(self) -> np.ndarray:
        return (self.flags & SATURATION_MASK) != 0

    def wavelength_at(self, x: float, y: float) -> tuple[float, float]:
        """(central wavelength, bandwidth) in µm at cutout pixel (x, y), bilinear in the official table."""
        X, Y, V = self.wave_table["X"], self.wave_table["Y"], self.wave_table["V"]
        dx, dy = x + self.det_x0, y + self.det_y0
        ix = int(np.clip(np.searchsorted(X, dx) - 1, 0, len(X) - 2))
        iy = int(np.clip(np.searchsorted(Y, dy) - 1, 0, len(Y) - 2))
        fx = float(np.clip((dx - X[ix]) / max(X[ix + 1] - X[ix], 1e-9), 0, 1))
        fy = float(np.clip((dy - Y[iy]) / max(Y[iy + 1] - Y[iy], 1e-9), 0, 1))
        v = (V[iy, ix] * (1 - fx) * (1 - fy) + V[iy, ix + 1] * fx * (1 - fy)
             + V[iy + 1, ix] * (1 - fx) * fy + V[iy + 1, ix + 1] * fx * fy)
        return float(v[0]), float(v[1])

    def epsf_at(self, x: float, y: float) -> np.ndarray:
        """ePSF at cutout pixel (x, y): inverse-distance blend of the 4 nearest detector zones."""
        dx, dy = x + self.det_x0, y + self.det_y0
        d = np.hypot(self.epsf_xc - dx, self.epsf_yc - dy)
        k = np.argsort(d)[:4]
        w = 1.0 / np.maximum(d[k], 1.0)
        e = np.tensordot(w / w.sum(), self.epsf[k], axes=1)
        return e / e.sum()


def crop(ex: Exposure, ra: float, dec: float, half: int = 45) -> Exposure | None:
    """A (2·half+1)² window of the exposure centred on (ra, dec), with a correctly sliced WCS.

    Keeps every exposure of a field comparable (cutouts were requested at different sizes)
    and bounds the catalogue query. The original file is untouched; the window's detector
    offset is updated so ePSF zones and wavelengths stay right.
    """
    import copy
    x, y = ex.wcs.all_world2pix([[ra, dec]], 0)[0]
    ny, nx = ex.shape
    xi, yi = int(round(x)), int(round(y))
    x0, x1 = max(xi - half, 0), min(xi + half + 1, nx)
    y0, y1 = max(yi - half, 0), min(yi + half + 1, ny)
    if x1 - x0 < 30 or y1 - y0 < 30:
        return None
    if x0 == 0 and y0 == 0 and x1 == nx and y1 == ny:
        return ex
    c = copy.copy(ex)
    c.image, c.variance, c.flags = ex.image[y0:y1, x0:x1], ex.variance[y0:y1, x0:x1], ex.flags[y0:y1, x0:x1]
    c.wcs = ex.wcs[y0:y1, x0:x1]
    c.det_x0, c.det_y0 = ex.det_x0 + x0, ex.det_y0 + y0
    c.provenance = {**ex.provenance, "window": {"x0": x0, "y0": y0, "x1": x1, "y1": y1, "of": [ny, nx]}}
    return c


def sha256_file(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_exposure(path: str | Path, *, checksum: bool = True) -> Exposure:
    from astropy.io import fits
    from astropy.wcs import WCS
    p = Path(path)
    with fits.open(p) as h:
        img = h["IMAGE"]
        hd = img.header
        wcs = WCS(hd, relax=True)
        ny, nx = img.data.shape
        det_x0, det_y0 = -float(hd.get("CRPIX1A", 0)) + 1, -float(hd.get("CRPIX2A", 0)) + 1
        et = h["EPSF"]
        ed = et.data
        epsf = np.asarray(ed["EPSF"], float).reshape(len(ed), 33, 33)
        wt = h["WCS-WAVE"].data
        wave_table = {"X": np.asarray(wt["X"][0], float), "Y": np.asarray(wt["Y"][0], float),
                      "V": np.asarray(wt["VALUES"][0], float)}
        sc = None
        if all(k in hd for k in ("X_SC", "Y_SC", "Z_SC")) and str(hd.get("XYZ_SC_SYSTEM", "")).upper().startswith("GEO"):
            sc = np.array([hd["X_SC"], hd["Y_SC"], hd["Z_SC"]], float)
        history = [str(x) for x in hd.get("HISTORY", [])]
        calib = sorted({m.group(0) for line in history for m in [re.match(r"\[CALIB\]\s+\S+\s+\S+", line)] if m})
        epsf_cal = next((re.sub(r".*file:\s*", "", str(x)) for x in et.header.get("HISTORY", []) if "Calibration source file" in str(x)), None)
        wave_cal = next((re.sub(r".*file:\s*", "", str(x)) for x in h["WCS-WAVE"].header.get("HISTORY", []) if "Calibration source file" in str(x)), None)
        prov = {
            "file": p.name, "collection": p.parent.name,
            "sha256": sha256_file(p) if checksum else None, "bytes": p.stat().st_size,
            "cached_at": datetime.fromtimestamp(p.stat().st_mtime, timezone.utc).isoformat(timespec="seconds"),
            "obs_id": str(hd.get("OBSID")), "expid": str(hd.get("EXPIDN")), "detector": int(hd.get("DETECTOR", 0)),
            "mjd_avg": float(hd.get("MJD-AVG", hd.get("MJD-OBS"))), "date_avg": str(hd.get("DATE-AVG")),
            "exptime_s": float(hd.get("XPOSURE", np.nan)), "pipeline_version": str(h[0].header.get("VERSION")),
            "processed": str(hd.get("DATE")), "calibration_files": calib,
            "epsf_calibration": epsf_cal, "spectral_wcs_calibration": wave_cal,
            "epsf_oversample": int(et.header.get("OVSMPX", 5)),
            "wcs_ctype": [hd.get("CTYPE1"), hd.get("CTYPE2")], "sip_order": int(hd.get("A_ORDER", 0)),
            "official_astrometry_qa": {k: (hd.get(k).item() if hasattr(hd.get(k), "item") else hd.get(k)) for k in
                                       ("ASTRONETSOLVED", "FINAST", "MATCH_NSTARS", "QS_NMATCH_VAR")},
            "dqa": {"L1": hd.get("L1DQAFLG"), "L2": hd.get("L2DQAFLG")},
            "psf_fwhm_arcsec": float(hd.get("PSF_FWHM", np.nan)),
            "units": str(hd.get("BUNIT")),
        }
        return Exposure(
            path=str(p), obs_id=prov["obs_id"], expid=prov["expid"], detector=prov["detector"], collection=p.parent.name,
            mjd=prov["mjd_avg"], exptime_s=prov["exptime_s"],
            image=np.array(img.data, np.float64), variance=np.array(h["VARIANCE"].data, np.float64),
            flags=np.array(h["FLAGS"].data, np.int64), wcs=wcs, det_x0=det_x0, det_y0=det_y0,
            epsf_xc=np.asarray(ed["XCENTER"], float), epsf_yc=np.asarray(ed["YCENTER"], float), epsf=epsf,
            oversample=prov["epsf_oversample"], wave_table=wave_table, sc_geocentric_km=sc,
            psf_fwhm_arcsec=prov["psf_fwhm_arcsec"], provenance=prov,
        )


def find_cutout_files(obs_id: str, detector: int, root: Path) -> list[Path]:
    """Cached cutout files for one exposure (several may exist, cut at different sizes)."""
    out = []
    for coll in ("spherex_dr1", "spherex_qr3"):
        out += sorted((root / coll).glob(f"{obs_id}_D{detector}_*.fits"))
    return out


def best_cutout_for(ra: float, dec: float, obs_id: str, detector: int, root: Path) -> Path | None:
    """The cached cutout of this exposure that contains (ra, dec) farthest from its edge."""
    from astropy.io import fits
    from astropy.wcs import WCS
    best, best_margin = None, -1.0
    for f in find_cutout_files(obs_id, detector, root):
        try:
            with fits.open(f) as h:
                w = WCS(h["IMAGE"].header, relax=True)
                ny, nx = h["IMAGE"].data.shape
            x, y = w.all_world2pix([[ra, dec]], 0)[0]
            margin = min(x, y, nx - 1 - x, ny - 1 - y)
            if margin > best_margin:
                best, best_margin = f, margin
        except Exception:  # noqa: BLE001 - a corrupt cache file is simply skipped
            continue
    return best if best_margin > 5 else None
