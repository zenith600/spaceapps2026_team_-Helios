"""Epoch-aware astrometry: where a catalogued star is at the moment of an exposure, and how sure.

Positions are propagated with ERFA's `pmpx` (the IAU SOFA routine for proper motion and
parallax): catalogue position at its reference epoch + proper motion × Δt + parallax as seen
from the actual observer. The observer is SPHEREx itself: Earth's barycentric position (ERFA
`epv00`) plus the spacecraft's geocentric position from the FITS header (`X_SC`, `Y_SC`,
`Z_SC`, km). Radial velocity is used when Gaia has one (it adds perspective acceleration,
negligible here but free to include).

Covariance: the Gaia 5-parameter covariance (α*, δ, ϖ, μα*, μδ) is built from the published
errors and correlation coefficients and propagated with a numerical Jacobian of the same
`pmpx` model, so the predicted position carries a 2×2 covariance in the tangent plane.

Conventions (explicit, because they are easy to get wrong):
- α* means Δα·cos δ. Gaia `ra_error` and `pmra` are already in α* units.
- ERFA `pmpx` wants dα/dt (NOT α*), so μα*/cos δ is passed.
- Offsets are gnomonic (tangent-plane) coordinates (ξ, η) in arcsec: ξ east, η north.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import erfa
import numpy as np

MAS = math.pi / 180 / 3600 / 1000          # radians per milliarcsecond
AU_KM = 149_597_870.7
GAIA_DR3_EPOCH_MJD = 57388.5               # J2016.0 (TCB; the ≤1 min TT/TCB offset is irrelevant here)
DAYS_PER_JULIAN_YEAR = 365.25
MJD_TO_JD = 2400000.5


# ----------------------------------------------------------------------------- observer
def observer_bcrs_au(mjd_utc: float, sc_geocentric_km=None) -> np.ndarray:
    """Barycentric position (au, BCRS axes) of the observer at an MJD.

    Earth from ERFA `epv00` (TDB; UTC→TDB is ~69 s, < 1e-4 au of Earth motion, negligible
    for parallax), plus the spacecraft's geocentric offset when given.
    """
    pvh, pvb = erfa.epv00(MJD_TO_JD, mjd_utc + 69.184 / 86400.0)
    pos = np.array(pvb[0], float) if np.ndim(pvb) else np.array(pvb["p"], float)
    if sc_geocentric_km is not None:
        pos = pos + np.asarray(sc_geocentric_km, float) / AU_KM
    return pos


# ----------------------------------------------------------------------------- tangent plane
def tangent_offsets_arcsec(ra_deg, dec_deg, ra0_deg, dec0_deg):
    """Gnomonic (ξ, η) of (ra, dec) about (ra0, dec0), in arcsec. Exact, vectorised."""
    ra, dec = np.radians(ra_deg), np.radians(dec_deg)
    ra0, dec0 = np.radians(ra0_deg), np.radians(dec0_deg)
    cosc = np.sin(dec0) * np.sin(dec) + np.cos(dec0) * np.cos(dec) * np.cos(ra - ra0)
    xi = np.cos(dec) * np.sin(ra - ra0) / cosc
    eta = (np.cos(dec0) * np.sin(dec) - np.sin(dec0) * np.cos(dec) * np.cos(ra - ra0)) / cosc
    k = 180 / math.pi * 3600
    return xi * k, eta * k


def from_tangent_arcsec(xi, eta, ra0_deg, dec0_deg):
    """Inverse gnomonic projection: (ξ, η) arcsec about (ra0, dec0) → (ra, dec) degrees."""
    k = math.pi / 180 / 3600
    x, y = np.asarray(xi, float) * k, np.asarray(eta, float) * k
    ra0, dec0 = math.radians(ra0_deg), math.radians(dec0_deg)
    rho = np.hypot(x, y)
    c = np.arctan(rho)
    with np.errstate(invalid="ignore", divide="ignore"):
        dec = np.arcsin(np.cos(c) * math.sin(dec0) + np.where(rho > 0, y * np.sin(c) * math.cos(dec0) / rho, 0.0))
        ra = ra0 + np.arctan2(x * np.sin(c), rho * math.cos(dec0) * np.cos(c) - y * math.sin(dec0) * np.sin(c))
    return np.degrees(ra) % 360.0, np.degrees(dec)


def angular_sep_arcsec(ra1, dec1, ra2, dec2):
    """Great-circle separation (Vincenty formula, stable at all separations), arcsec."""
    ra1, dec1, ra2, dec2 = map(np.radians, (ra1, dec1, ra2, dec2))
    dra = ra2 - ra1
    num = np.hypot(np.cos(dec2) * np.sin(dra),
                   np.cos(dec1) * np.sin(dec2) - np.sin(dec1) * np.cos(dec2) * np.cos(dra))
    den = np.sin(dec1) * np.sin(dec2) + np.cos(dec1) * np.cos(dec2) * np.cos(dra)
    return np.degrees(np.arctan2(num, den)) * 3600.0


# ----------------------------------------------------------------------------- catalogue star
@dataclass
class CatalogStar:
    """One astrometric catalogue entry (Gaia DR3 conventions and units)."""
    source_id: str
    ra: float                  # deg, at ref_epoch
    dec: float
    ref_epoch_mjd: float
    pmra: float = 0.0          # mas/yr, α*
    pmdec: float = 0.0
    parallax: float = 0.0      # mas
    rv: float = 0.0            # km/s (0 if unknown)
    cov5: np.ndarray | None = None   # 5×5 in (mas, mas, mas, mas/yr, mas/yr) for (α*, δ, ϖ, μα*, μδ)

    @staticmethod
    def from_gaia_row(r) -> "CatalogStar":
        g = lambda k, d=0.0: (float(r[k]) if k in r and r[k] is not None and np.isfinite(float(r[k])) else d)  # noqa: E731
        return CatalogStar(source_id=str(r["source_id"]), ra=float(r["ra"]), dec=float(r["dec"]),
                           ref_epoch_mjd=GAIA_DR3_EPOCH_MJD, pmra=g("pmra"), pmdec=g("pmdec"),
                           parallax=g("parallax"), rv=g("radial_velocity"), cov5=gaia_cov5(r))


_GAIA_PARAMS = ("ra", "dec", "parallax", "pmra", "pmdec")


def gaia_cov5(r) -> np.ndarray:
    """5×5 covariance from Gaia `*_error` and `*_corr` columns. Missing → 0 (2-parameter solutions
    get zero pm/parallax variance only if those values are themselves absent, which callers filter)."""
    def val(k):
        try:
            v = float(r[k])
            return v if np.isfinite(v) else 0.0
        except (KeyError, TypeError, ValueError):
            return 0.0
    s = np.array([val(f"{p}_error") for p in _GAIA_PARAMS])
    c = np.eye(5)
    for i in range(5):
        for j in range(i + 1, 5):
            rho = val(f"{_GAIA_PARAMS[i]}_{_GAIA_PARAMS[j]}_corr")
            c[i, j] = c[j, i] = rho
    return c * np.outer(s, s)


def _pmpx_radec(star: CatalogStar, params: np.ndarray, years: float, pob: np.ndarray) -> tuple[float, float]:
    """(ra, dec) in radians at `years` after the reference epoch, for perturbed parameters
    params = (dα* mas, dδ mas, ϖ mas, μα* mas/yr, μδ mas/yr)."""
    dec0 = math.radians(star.dec) + params[1] * MAS
    ra0 = math.radians(star.ra) + params[0] * MAS / math.cos(math.radians(star.dec))
    pr = params[3] * MAS / math.cos(dec0)       # ERFA wants dα/dt, not α*
    pd = params[4] * MAS
    px = params[2] / 1000.0                       # arcsec
    pco = erfa.pmpx(ra0, dec0, pr, pd, px, star.rv, years, pob)
    ra, dec = erfa.c2s(pco)
    return float(ra) % (2 * math.pi), float(dec)


def propagate(star: CatalogStar, mjd: float, pob_au: np.ndarray) -> dict:
    """Position of `star` at `mjd` seen from `pob_au`, with its 2×2 tangent-plane covariance.

    Returns {"ra", "dec" (deg), "cov" (2×2, arcsec², ξ/η), "years"}.
    """
    years = (mjd - star.ref_epoch_mjd) / DAYS_PER_JULIAN_YEAR
    p0 = np.array([0.0, 0.0, star.parallax, star.pmra, star.pmdec])
    ra, dec = _pmpx_radec(star, p0, years, pob_au)
    ra_deg, dec_deg = math.degrees(ra), math.degrees(dec)
    cov = np.zeros((2, 2))
    if star.cov5 is not None and np.any(star.cov5):
        J = np.zeros((2, 5))
        steps = np.array([0.1, 0.1, 0.1, 0.1, 0.1])          # mas, mas/yr: linear regime
        for k in range(5):
            dp = np.zeros(5)
            dp[k] = steps[k]
            r1, d1 = _pmpx_radec(star, p0 + dp, years, pob_au)
            r2, d2 = _pmpx_radec(star, p0 - dp, years, pob_au)
            x1, y1 = tangent_offsets_arcsec(math.degrees(r1), math.degrees(d1), ra_deg, dec_deg)
            x2, y2 = tangent_offsets_arcsec(math.degrees(r2), math.degrees(d2), ra_deg, dec_deg)
            J[0, k] = (x1 - x2) / (2 * steps[k])           # arcsec per mas
            J[1, k] = (y1 - y2) / (2 * steps[k])
        cov = J @ star.cov5 @ J.T
    return {"ra": ra_deg % 360.0, "dec": dec_deg, "cov": cov, "years": years}


def parallax_factors(ra_deg: float, dec_deg: float, mjd: float, pob_au: np.ndarray) -> tuple[float, float]:
    """(Pα*, Pδ): tangent-plane shift in arcsec per arcsec of parallax at this epoch/observer."""
    s = CatalogStar("pf", ra_deg, dec_deg, mjd, parallax=1000.0)   # 1 arcsec, zero pm, at its own epoch
    with_px = propagate(s, mjd, pob_au)
    return tangent_offsets_arcsec(with_px["ra"], with_px["dec"], ra_deg, dec_deg)


# ----------------------------------------------------------------------------- WCS helpers
def pixel_jacobian_arcsec(wcs, x: float, y: float, h: float = 0.5) -> np.ndarray:
    """2×2 Jacobian d(ξ, η)/d(x, y) in arcsec/pixel at a pixel, through the full WCS (incl. SIP)."""
    ra0, dec0 = wcs.all_pix2world([[x, y]], 0)[0]
    pts = wcs.all_pix2world([[x + h, y], [x - h, y], [x, y + h], [x, y - h]], 0)
    xi, eta = tangent_offsets_arcsec(pts[:, 0], pts[:, 1], ra0, dec0)
    return np.array([[(xi[0] - xi[1]) / (2 * h), (xi[2] - xi[3]) / (2 * h)],
                     [(eta[0] - eta[1]) / (2 * h), (eta[2] - eta[3]) / (2 * h)]])


def pixel_cov_to_sky(wcs, x: float, y: float, cov_px: np.ndarray) -> np.ndarray:
    J = pixel_jacobian_arcsec(wcs, x, y)
    return J @ np.asarray(cov_px, float) @ J.T


def wcs_scale_rotation(wcs, x: float, y: float) -> dict:
    """Local pixel scale (arcsec/px), rotation (deg, east of north of +y), parity and skew."""
    J = pixel_jacobian_arcsec(wcs, x, y)
    sx = float(np.hypot(J[0, 0], J[1, 0]))
    sy = float(np.hypot(J[0, 1], J[1, 1]))
    det = float(np.linalg.det(J))
    rot = math.degrees(math.atan2(J[0, 1], J[1, 1]))            # direction of +y on the sky (east of north)
    return {"scale_x": sx, "scale_y": sy, "scale": math.sqrt(abs(det)), "rotation_deg": rot,
            "parity": 1 if det < 0 else -1, "jacobian": J.tolist()}
