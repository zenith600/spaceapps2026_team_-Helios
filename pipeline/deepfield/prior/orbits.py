"""Two-body Keplerian propagation of the reference population (vectorised NumPy).

Elements are J2000 heliocentric ecliptic osculating elements (Caltech convention:
inc, varpi = longitude of perihelion, Omega = longitude of ascending node, M at epoch).
Output positions are ICRS equatorial, heliocentric, in AU. `observe()` converts to
topocentric/observer-centric RA, Dec and distance given an observer position.
"""
from __future__ import annotations

import numpy as np

GM_SUN_AU3_D2 = 2.9591220828559115e-4  # k^2, AU^3/day^2
OBLIQUITY_J2000_DEG = 23.439291111


def solve_kepler(M: np.ndarray, e: np.ndarray, tol: float = 1e-12, iters: int = 60) -> np.ndarray:
    """Eccentric anomaly from mean anomaly (radians), Newton iteration, vectorised."""
    M = np.mod(M, 2 * np.pi)
    E = np.where(e < 0.8, M, np.pi).astype(float)
    for _ in range(iters):
        f = E - e * np.sin(E) - M
        fp = 1 - e * np.cos(E)
        dE = -f / fp
        E = E + dE
        if np.all(np.abs(dE) < tol):
            break
    return E


def mean_motion(a_au: np.ndarray) -> np.ndarray:
    return np.sqrt(GM_SUN_AU3_D2 / a_au ** 3)  # rad/day


def heliocentric_ecliptic(a, e, inc_deg, varpi_deg, Omega_deg, M0_deg, epoch_jd: float, t_jd: float | np.ndarray):
    """Heliocentric ecliptic J2000 position (AU) at time t for each orbit. Returns (N, 3) or (T, N, 3)."""
    a, e = np.asarray(a, float), np.asarray(e, float)
    inc, Om = np.radians(inc_deg), np.radians(Omega_deg)
    om = np.radians(np.asarray(varpi_deg, float) - np.asarray(Omega_deg, float))  # argument of perihelion
    M0 = np.radians(M0_deg)
    t = np.atleast_1d(np.asarray(t_jd, float))
    n = mean_motion(a)
    out = np.empty((t.size, a.size, 3))
    cO, sO, ci, si = np.cos(Om), np.sin(Om), np.cos(inc), np.sin(inc)
    co, so = np.cos(om), np.sin(om)
    # rotation matrix from perifocal to ecliptic
    r11 = cO * co - sO * so * ci; r12 = -cO * so - sO * co * ci
    r21 = sO * co + cO * so * ci; r22 = -sO * so + cO * co * ci
    r31 = so * si;                r32 = co * si
    for k, tk in enumerate(t):
        M = M0 + n * (tk - epoch_jd)
        E = solve_kepler(M, e)
        xp = a * (np.cos(E) - e)
        yp = a * np.sqrt(1 - e ** 2) * np.sin(E)
        out[k, :, 0] = r11 * xp + r12 * yp
        out[k, :, 1] = r21 * xp + r22 * yp
        out[k, :, 2] = r31 * xp + r32 * yp
    return out if np.ndim(t_jd) else out[0]


def ecliptic_to_equatorial(xyz: np.ndarray) -> np.ndarray:
    eps = np.radians(OBLIQUITY_J2000_DEG)
    x, y, z = xyz[..., 0], xyz[..., 1], xyz[..., 2]
    return np.stack([x, y * np.cos(eps) - z * np.sin(eps), y * np.sin(eps) + z * np.cos(eps)], axis=-1)


def heliocentric_equatorial(df, t_jd):
    """ICRS heliocentric xyz (AU) for a reference-population DataFrame at JD t (scalar or array)."""
    xyz_ecl = heliocentric_ecliptic(df["a"].values, df["e"].values, df["inc"].values, df["varpi"].values,
                                    df["Omega"].values, df["M"].values, 2458270.0, t_jd)
    return ecliptic_to_equatorial(xyz_ecl)


def xyz_to_radec(xyz: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    x, y, z = xyz[..., 0], xyz[..., 1], xyz[..., 2]
    r = np.sqrt(x * x + y * y + z * z)
    ra = np.degrees(np.arctan2(y, x)) % 360.0
    dec = np.degrees(np.arcsin(z / r))
    return ra, dec, r


def observe(helio_xyz: np.ndarray, observer_xyz: np.ndarray):
    """Observer-centric RA/Dec/distance from heliocentric object and observer positions (ICRS, AU)."""
    rel = helio_xyz - observer_xyz
    return xyz_to_radec(rel)


def apparent_vmag(V_epoch: np.ndarray, R_epoch: np.ndarray, delta_epoch: np.ndarray,
                  R_now: np.ndarray, delta_now: np.ndarray) -> np.ndarray:
    """Scale the catalogue V magnitude to a new geometry (reflected light ~ 1/(R^2 Delta^2); phase ignored)."""
    return V_epoch + 5 * np.log10((R_now * delta_now) / (R_epoch * delta_epoch))
