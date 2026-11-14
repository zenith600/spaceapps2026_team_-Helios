"""Coordinate / time handling: Kepler propagation reproduces the Caltech CSV; MJD/JD conversions; HEALPix binning."""
import numpy as np
import pandas as pd
import pytest

from deepfield.prior import orbits as O


def test_kepler_solver_matches_definition():
    rng = np.random.default_rng(0)
    M = rng.uniform(0, 2 * np.pi, 1000)
    e = rng.uniform(0, 0.95, 1000)
    E = O.solve_kepler(M, e)
    assert np.allclose(E - e * np.sin(E), M, atol=1e-10)


def test_circular_orbit_period():
    # a = 1 AU: one full revolution in 365.25 days (to the precision of the Gaussian constant)
    df = pd.DataFrame({"a": [1.0], "e": [0.0], "inc": [0.0], "varpi": [0.0], "Omega": [0.0], "M": [0.0]})
    p0 = O.heliocentric_equatorial(df, 2458270.0)
    p1 = O.heliocentric_equatorial(df, 2458270.0 + 365.25636)
    assert np.allclose(p0, p1, atol=2e-4)


def test_ecliptic_to_equatorial_pole():
    z = O.ecliptic_to_equatorial(np.array([[0.0, 0.0, 1.0]]))[0]
    dec = np.degrees(np.arcsin(z[2]))
    assert dec == pytest.approx(90 - 23.4393, abs=1e-3)


@pytest.mark.skipif(not (__import__("deepfield.config", fromlist=["CACHE_DIR"]).CACHE_DIR / "refpop" / "reference_population.csv").exists(),
                    reason="reference population not downloaded")
def test_propagation_reproduces_catalogue_positions():
    """At the catalogue epoch our geocentric RA/Dec must match the CSV to within its rounding (~0.01 deg elements)."""
    from deepfield.data.refpop import load_refpop
    from deepfield.data.horizons import earth_heliocentric_icrs
    df = load_refpop().sample(5000, random_state=1)
    helio = O.heliocentric_equatorial(df, 2458270.0)
    _, _, R = O.xyz_to_radec(helio)
    assert np.median(np.abs(R - df["R"].values)) < 0.1  # AU; CSV a/e are rounded
    earth = earth_heliocentric_icrs(2458270.0)[0]
    ra, dec, _ = O.observe(helio, earth)
    dra = ((ra - df["ra"].values + 180) % 360 - 180) * np.cos(np.radians(df["dec"].values))
    ddec = dec - df["dec"].values
    sep_arcsec = np.hypot(dra, ddec) * 3600
    assert np.median(sep_arcsec) < 90      # element rounding at 0.01 deg ~ 36" per angle
    assert np.percentile(sep_arcsec, 99) < 600


def test_mjd_jd_convention():
    # SPHEREx headers carry MJD-AVG; the reference population uses JD. 2458270.0 JD = 58269.5 MJD.
    assert 2458270.0 - 2400000.5 == 58269.5


def test_healpix_binning_roundtrip():
    import astropy.units as u
    from astropy_healpix import HEALPix
    hp = HEALPix(nside=32, order="ring")
    lon, lat = hp.healpix_to_lonlat(np.arange(hp.npix))
    pix = hp.lonlat_to_healpix(lon, lat)
    assert np.array_equal(pix, np.arange(hp.npix))
    assert hp.npix == 12288
    assert hp.pixel_resolution.to_value(u.deg) == pytest.approx(1.83, abs=0.02)
