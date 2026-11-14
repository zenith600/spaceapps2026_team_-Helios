"""Inject reference-population Planet Nines into real SPHEREx cutouts along their true apparent tracks."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from deepfield.data.spherex import Cutout
from deepfield.prior import orbits as O
from deepfield.spectral.templates import planet_flux_mjy
from deepfield.stack.geometry import heliocentric_from_apparent, xyz_to_radec_deg


@dataclass
class Injection:
    injection_id: str
    pop_index: int
    vmag: float
    distance_au: float
    ra_ref: float
    dec_ref: float
    mjd_ref: float
    track_ra: np.ndarray
    track_dec: np.ndarray
    flux_mjy: np.ndarray
    x_ref: float = np.nan
    y_ref: float = np.nan
    extra: dict = field(default_factory=dict)


def pick_planets(pop: pd.DataFrame, prop: pd.DataFrame, n: int, rng: np.random.Generator,
                 vmag_range: tuple[float, float] = (17.5, 23.0), surviving_only: bool = True) -> pd.DataFrame:
    """Sample reference planets (surviving ones by default) spread uniformly in current V magnitude."""
    sel = prop[~prop.excluded_prior] if surviving_only else prop
    sel = sel[(sel.V_now >= vmag_range[0]) & (sel.V_now <= vmag_range[1])]
    # stratify in magnitude so faint and bright planets are both represented
    bins = np.linspace(vmag_range[0], vmag_range[1], n + 1)
    picks = []
    for lo, hi in zip(bins[:-1], bins[1:]):
        cand = sel[(sel.V_now >= lo) & (sel.V_now < hi)]
        pool = cand if len(cand) else sel
        picks.append(pool.sample(1, random_state=int(rng.integers(1 << 31))))
    return pd.concat(picks)


def planet_track(pop_row: pd.Series, ra_ref: float, dec_ref: float, mjds: np.ndarray, observer_xyz: np.ndarray,
                 mjd_ref: float) -> tuple[np.ndarray, np.ndarray, float]:
    """Apparent (ra, dec) of a reference planet transplanted so that it sits at (ra_ref, dec_ref) at mjd_ref.

    Uses the planet's true heliocentric distance and velocity from its Keplerian orbit, so the injected track
    carries the real parallax + orbital motion for that object.
    """
    df1 = pd.DataFrame([{k: float(pop_row[k]) for k in ("a", "e", "inc", "varpi", "Omega", "M")}])
    jd_ref = mjd_ref + 2400000.5
    p0 = O.heliocentric_equatorial(df1, jd_ref)[0]
    p1 = O.heliocentric_equatorial(df1, jd_ref + 1.0)[0]
    vel = p1 - p0  # AU/day
    R = float(np.linalg.norm(p0))
    obs_ref = np.stack([np.interp(mjd_ref, mjds, observer_xyz[:, k]) for k in range(3)])
    P_ref = heliocentric_from_apparent(ra_ref, dec_ref, obs_ref, R)
    P = P_ref[None, :] + vel[None, :] * (mjds - mjd_ref)[:, None]
    rel = P - observer_xyz
    ra, dec = xyz_to_radec_deg(rel)
    return ra, dec, R


def make_injections(pop: pd.DataFrame, prop: pd.DataFrame, n: int, rng: np.random.Generator, wcs_out, npix: int,
                    mjds: np.ndarray, observer_xyz: np.ndarray, mjd_ref: float, waves_um: np.ndarray,
                    margin_px: int = 18, min_sep_px: float = 22.0, tag: str = "") -> list[Injection]:
    chosen = pick_planets(pop, prop, n, rng)
    out: list[Injection] = []
    placed: list[tuple[float, float]] = []
    for _, prow in chosen.iterrows():
        full = pop.loc[pop["index"] == int(prow["index"])].iloc[0]
        in_field = False
        x = y = np.nan
        tra = tdec = None
        R = float("nan")
        # The 6-month parallax track must stay inside the cutout; sample positions until it does.
        for _attempt in range(60):
            x = rng.uniform(margin_px, npix - margin_px)
            y = rng.uniform(margin_px, npix - margin_px)
            if not all(np.hypot(x - px, y - py) >= min_sep_px for px, py in placed):
                continue
            ra_ref, dec_ref = wcs_out.all_pix2world([x], [y], 0)
            ra_ref, dec_ref = float(ra_ref[0]), float(dec_ref[0])
            tra, tdec, R = planet_track(full, ra_ref, dec_ref, mjds, observer_xyz, mjd_ref)
            px_, py_ = wcs_out.all_world2pix(tra, tdec, 0)
            if np.all((px_ > 6) & (px_ < npix - 7) & (py_ > 6) & (py_ < npix - 7)):
                in_field = True
                break
        placed.append((x, y))
        ra_ref, dec_ref = wcs_out.all_pix2world([x], [y], 0)
        ra_ref, dec_ref = float(ra_ref[0]), float(dec_ref[0])
        if tra is None:
            tra, tdec, R = planet_track(full, ra_ref, dec_ref, mjds, observer_xyz, mjd_ref)
        vm = float(prow["V_now"])
        out.append(Injection(
            injection_id=f"INJ{tag}{int(prow['index']):06d}", pop_index=int(prow["index"]), vmag=vm, distance_au=R,
            ra_ref=ra_ref, dec_ref=dec_ref, mjd_ref=mjd_ref, track_ra=tra, track_dec=tdec,
            flux_mjy=planet_flux_mjy(vm, waves_um), x_ref=x, y_ref=y,
            extra={"mass_earth": float(full["mass"]), "a_au": float(full["a"]), "e": float(full["e"]),
                   "inc_deg": float(full["inc"]), "albedo": float(full["albedo"]), "radius_earth": float(full["rad"]),
                   "track_in_field": bool(in_field)},
        ))
    return out


def apply_injections(cutouts: list[Cutout], injections: list[Injection]) -> list[Cutout]:
    """Return copies of the cutouts with every injection added (raw frames, own WCS, own ePSF)."""
    import copy
    from deepfield.stack.reproject import inject_point_source
    out = []
    for k, c in enumerate(cutouts):
        c2 = copy.copy(c)
        c2.image = c.image.copy()
        for inj in injections:
            inject_point_source(c2, float(inj.track_ra[k]), float(inj.track_dec[k]), float(inj.flux_mjy[k]))
        out.append(c2)
    return out
