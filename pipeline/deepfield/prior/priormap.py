"""HEALPix prior map of surviving reference-population Planet Nines at a chosen epoch."""
from __future__ import annotations

import numpy as np
import pandas as pd
import astropy.units as u
from astropy_healpix import HEALPix

from deepfield.config import NSIDE
from deepfield.data.horizons import observer_positions
from deepfield.data.refpop import SOURCE as REFPOP_SOURCE, load_refpop
from deepfield.prior import orbits as O


def propagate_population(df: pd.DataFrame, mjd: float) -> pd.DataFrame:
    """Geocentric RA/Dec, distance and scaled V magnitude of every reference planet at MJD."""
    jd = mjd + 2400000.5
    helio = O.heliocentric_equatorial(df, jd)
    obs, obs_label = observer_positions(np.array([jd]), prefer_horizons=False)
    ra, dec, delta = O.observe(helio, obs[0])
    R_now = np.linalg.norm(helio, axis=1)
    # catalogue geometry at its epoch
    helio0 = O.heliocentric_equatorial(df, 2458270.0)
    obs0, _ = observer_positions(np.array([2458270.0]), prefer_horizons=False)
    _, _, delta0 = O.observe(helio0, obs0[0])
    R0 = np.linalg.norm(helio0, axis=1)
    V_now = O.apparent_vmag(df["V"].values, R0, delta0, R_now, delta)
    out = df[["index", "excluded_prior", "V", "R"]].copy()
    out["ra_now"], out["dec_now"], out["delta_now"], out["R_now"], out["V_now"] = ra, dec, delta, R_now, V_now
    return out


def build_prior_map(mjd: float, nside: int = NSIDE, excluded_deepfield: np.ndarray | None = None,
                    searched_hpix: set[int] | None = None) -> tuple[pd.DataFrame, dict]:
    """Return (prior_map DataFrame, metadata) following the prior_map contract."""
    pop = load_refpop()
    prop = propagate_population(pop, mjd)
    hp = HEALPix(nside=nside, order="ring")
    pix = hp.lonlat_to_healpix(prop["ra_now"].values * u.deg, prop["dec_now"].values * u.deg)
    surviving = ~prop["excluded_prior"].values
    excl_df = np.zeros(len(pop), dtype=bool) if excluded_deepfield is None else np.asarray(excluded_deepfield, bool)
    remaining = surviving & ~excl_df
    n_all = np.bincount(pix, minlength=hp.npix)
    n_surv = np.bincount(pix[surviving], minlength=hp.npix)
    n_rem = np.bincount(pix[remaining], minlength=hp.npix)
    lon, lat = hp.healpix_to_lonlat(np.arange(hp.npix))
    searched = np.zeros(hp.npix, dtype=bool)
    if searched_hpix:
        searched[list(searched_hpix)] = True
    df = pd.DataFrame({
        "hpix": np.arange(hp.npix, dtype=np.int32), "ra_deg": lon.to_value(u.deg), "dec_deg": lat.to_value(u.deg),
        "n_all": n_all.astype(np.int32), "n_surviving": n_surv.astype(np.int32), "n_remaining": n_rem.astype(np.int32),
        "p_surviving": n_surv / max(n_surv.sum(), 1), "p_remaining": n_rem / max(n_rem.sum(), 1), "searched": searched,
    })
    meta = {
        "nside": nside, "ordering": "ring", "epoch_mjd": mjd, "population_version": "v3 (ZTF+DES+PS1)",
        "n_population": int(len(pop)), "n_surviving": int(surviving.sum()), "n_remaining": int(remaining.sum()),
        "frac_excluded_prior": float(1 - surviving.sum() / len(pop)),
        "frac_excluded_deepfield": float(1 - remaining.sum() / max(surviving.sum(), 1)),
        "source": REFPOP_SOURCE,
    }
    return df, meta
