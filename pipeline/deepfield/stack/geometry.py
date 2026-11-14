"""Trial-motion geometry for distant objects.

A trial is (distance_au, rate_ra, rate_dec): the object sits at observer-centric
(ra0, dec0) at the reference time, at heliocentric distance d, and drifts by a
small extra linear rate (arcsec/day) in the tangent plane to absorb its own orbital
motion. For a given observer track (heliocentric xyz per epoch, from Horizons or
astropy) the apparent offset at each epoch is almost entirely parallax.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

ARCSEC_PER_RAD = 206264.80624709636


def unit_vector(ra_deg: float, dec_deg: float) -> np.ndarray:
    a, d = np.radians(ra_deg), np.radians(dec_deg)
    return np.array([np.cos(d) * np.cos(a), np.cos(d) * np.sin(a), np.sin(d)])


def tangent_basis(ra_deg: float, dec_deg: float) -> tuple[np.ndarray, np.ndarray]:
    """East and north unit vectors at (ra, dec)."""
    a, d = np.radians(ra_deg), np.radians(dec_deg)
    east = np.array([-np.sin(a), np.cos(a), 0.0])
    north = np.array([-np.sin(d) * np.cos(a), -np.sin(d) * np.sin(a), np.cos(d)])
    return east, north


def heliocentric_from_apparent(ra_deg: float, dec_deg: float, observer_xyz: np.ndarray, distance_au: float) -> np.ndarray:
    """Heliocentric position of an object seen at (ra, dec) from `observer_xyz`, at heliocentric distance d."""
    n = unit_vector(ra_deg, dec_deg)
    b = n @ observer_xyz
    c = observer_xyz @ observer_xyz - distance_au ** 2
    delta = -b + np.sqrt(max(b * b - c, 0.0))
    return observer_xyz + delta * n


def to_tangent_arcsec(xyz_rel: np.ndarray, ra0: float, dec0: float) -> tuple[np.ndarray, np.ndarray]:
    """Project observer-centric vectors onto the tangent plane at (ra0, dec0). Returns (xi, eta) in arcsec."""
    n = unit_vector(ra0, dec0)
    east, north = tangent_basis(ra0, dec0)
    r = xyz_rel / np.linalg.norm(xyz_rel, axis=-1, keepdims=True)
    denom = r @ n
    xi = (r @ east) / denom * ARCSEC_PER_RAD
    eta = (r @ north) / denom * ARCSEC_PER_RAD
    return xi, eta


@dataclass(frozen=True)
class Trial:
    distance_au: float          # np.inf = no parallax (stationary / very distant)
    rate_ra_arcsec_day: float = 0.0
    rate_dec_arcsec_day: float = 0.0


def trial_offsets(trial: Trial, ra0: float, dec0: float, mjds: np.ndarray, observer_xyz: np.ndarray,
                  mjd_ref: float | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Apparent offsets (xi, eta) in arcsec of the trial object at each epoch, relative to (ra0, dec0) at mjd_ref."""
    mjds = np.asarray(mjds, float)
    if mjd_ref is None:
        mjd_ref = float(mjds.mean())
    dt = mjds - mjd_ref
    if np.isfinite(trial.distance_au):
        obs_ref = np.stack([np.interp(mjd_ref, mjds, observer_xyz[:, k]) for k in range(3)]) if len(mjds) > 1 else observer_xyz[0]
        P = heliocentric_from_apparent(ra0, dec0, obs_ref, trial.distance_au)
        rel = P[None, :] - observer_xyz
        xi, eta = to_tangent_arcsec(rel, ra0, dec0)
    else:
        xi, eta = np.zeros_like(dt), np.zeros_like(dt)
    xi = xi + trial.rate_ra_arcsec_day * dt
    eta = eta + trial.rate_dec_arcsec_day * dt
    return xi, eta


def default_trial_grid(distances=(250, 300, 350, 400, 500, 600, 800, 1000, np.inf),
                       rates=(-1.0, -0.5, 0.0, 0.5, 1.0)) -> list[Trial]:
    grid = []
    for d in distances:
        for rr in rates:
            for rd in rates:
                if not np.isfinite(d) and (rr != 0 or rd != 0):
                    continue  # the stationary trial has no rates
                grid.append(Trial(float(d), float(rr), float(rd)))
    return grid


def radec_offset(ra0: float, dec0: float, xi_arcsec: float, eta_arcsec: float) -> tuple[float, float]:
    """Inverse of the small-angle tangent projection: (xi, eta) -> (ra, dec) in degrees."""
    dec = dec0 + eta_arcsec / 3600.0
    ra = ra0 + xi_arcsec / 3600.0 / np.cos(np.radians(dec0))
    return float(ra % 360.0), float(dec)


def xyz_to_radec_deg(xyz: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    x, y, z = xyz[..., 0], xyz[..., 1], xyz[..., 2]
    ra = np.degrees(np.arctan2(y, x)) % 360.0
    dec = np.degrees(np.arctan2(z, np.hypot(x, y)))
    return ra, dec
