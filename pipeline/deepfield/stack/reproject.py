"""Reproject SPHEREx cutouts onto a common tangent-plane grid, and inject synthetic sources into raw frames."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.ndimage import map_coordinates

from deepfield.config import SPHEREX_PIXEL_ARCSEC
from deepfield.data.spherex import Cutout, epsf_to_pixel_kernel

OMEGA_PIX_SR = 37.87 * (np.pi / 180 / 3600) ** 2  # median solid angle per SPHEREx pixel (arcsec^2 -> sr)


def target_wcs(ra0: float, dec0: float, npix: int, pixel_arcsec: float = SPHEREX_PIXEL_ARCSEC):
    from astropy.wcs import WCS
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra0, dec0]
    w.wcs.crpix = [npix / 2 + 0.5, npix / 2 + 0.5]
    w.wcs.cdelt = [-pixel_arcsec / 3600.0, pixel_arcsec / 3600.0]
    w.array_shape = (npix, npix)
    return w


@dataclass
class Frame:
    obs_id: str
    detector: int
    mjd: float
    image: np.ndarray      # reprojected, MJy/sr; NaN where no data
    variance: np.ndarray
    good: np.ndarray       # bool
    source: np.ndarray     # bool, SOURCE-flagged (known static source)
    psf: np.ndarray        # native-pixel kernel, sum 1
    wave_um: float
    bandwidth_um: float


def reproject_cutout(c: Cutout, wcs_out, npix: int) -> Frame:
    yy, xx = np.mgrid[0:npix, 0:npix]
    ra, dec = wcs_out.all_pix2world(xx.ravel(), yy.ravel(), 0)
    sx, sy = c.wcs.all_world2pix(ra, dec, 0)
    coords = np.stack([sy.reshape(npix, npix), sx.reshape(npix, npix)])
    img = map_coordinates(np.nan_to_num(c.image, nan=0.0), coords, order=1, mode="constant", cval=np.nan)
    var = map_coordinates(np.nan_to_num(c.variance, nan=1e6), coords, order=1, mode="constant", cval=np.nan)
    good = map_coordinates(c.good.astype(np.float32), coords, order=0, mode="constant", cval=0.0) > 0.5
    src = map_coordinates(c.mask_source.astype(np.float32), coords, order=0, mode="constant", cval=0.0) > 0.5
    inside = np.isfinite(img) & np.isfinite(var)
    good &= inside
    return Frame(c.obs_id, c.detector, c.mjd, img.astype(np.float32), var.astype(np.float32), good, src,
                 epsf_to_pixel_kernel(c.epsf, fwhm_px=c.psf_fwhm_arcsec / SPHEREX_PIXEL_ARCSEC),
                 c.wave_um, c.bandwidth_um)


def inject_point_source(c: Cutout, ra: float, dec: float, flux_mjy: float) -> None:
    """Add a point source of total flux `flux_mjy` (MJy) at (ra, dec) into the raw cutout image, in place.

    Surface brightness per pixel = flux * psf / Omega_pix. Sub-pixel position handled by bilinear splitting.
    """
    x, y = c.wcs.all_world2pix([ra], [dec], 0)
    x, y = float(x[0]), float(y[0])
    k = epsf_to_pixel_kernel(c.epsf, fwhm_px=c.psf_fwhm_arcsec / SPHEREX_PIXEL_ARCSEC)
    h = k.shape[0] // 2
    ix, iy = int(np.floor(x)), int(np.floor(y))
    fx, fy = x - ix, y - iy
    amp = flux_mjy / OMEGA_PIX_SR
    for dx, wx in ((0, 1 - fx), (1, fx)):
        for dy, wy in ((0, 1 - fy), (1, fy)):
            cx, cy = ix + dx, iy + dy
            y0, y1 = cy - h, cy + h + 1
            x0, x1 = cx - h, cx + h + 1
            ky0, ky1 = max(0, -y0), k.shape[0] - max(0, y1 - c.image.shape[0])
            kx0, kx1 = max(0, -x0), k.shape[1] - max(0, x1 - c.image.shape[1])
            if ky1 <= ky0 or kx1 <= kx0:
                continue
            c.image[max(y0, 0):min(y1, c.image.shape[0]), max(x0, 0):min(x1, c.image.shape[1])] += (
                amp * wx * wy * k[ky0:ky1, kx0:kx1]).astype(np.float32)
