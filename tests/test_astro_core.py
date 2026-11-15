"""Numerical correctness of the validation pipeline's core maths.

Each test checks a number against an independent reference (Astropy, ERFA geometry, Monte
Carlo, a hand-worked example), not merely that a function runs.
"""
from __future__ import annotations

import math
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest

from deepfield.astro import astrometry as A
from deepfield.astro import stats as S
from deepfield.astro.psf import EPSFModel, extendedness, find_sources, fit_epsf, fit_gaussian


# ----------------------------------------------------------------------------- statistics
def test_bh_qvalues_match_a_hand_worked_example():
    p = np.array([0.005, 0.01, 0.03, 0.04, 0.5])
    # m=5: ranked p·m/i = .025 .025 .05 .05 .5 → monotone from the top → same here
    assert np.allclose(S.bh_qvalues(p), [0.025, 0.025, 0.05, 0.05, 0.5])
    q = S.bh_qvalues([0.04, np.nan, 0.01])
    assert np.isnan(q[1]) and np.allclose(q[[0, 2]], [0.04, 0.02])


def test_mahalanobis_and_coverage_on_gaussian_samples():
    rng = np.random.default_rng(0)
    C = np.array([[4.0, 1.5], [1.5, 1.0]])
    x = rng.multivariate_normal([0, 0], C, size=20000)
    d2 = S.mahalanobis2(x, np.broadcast_to(C, (len(x), 2, 2)))
    cov = S.coverage_2d(d2)
    assert np.allclose(cov["empirical"], S.NOMINAL, atol=0.01)
    z = rng.normal(size=20000)
    assert np.allclose(S.coverage_1d(z)["empirical"], S.NOMINAL, atol=0.01)
    assert abs(S.robust_sigma(z) - 1) < 0.03


def test_wilson_interval_brackets_the_proportion():
    lo, hi = S.wilson_interval(30, 100)
    assert lo < 0.30 < hi and hi - lo < 0.12


# ----------------------------------------------------------------------------- astrometry
def test_tangent_offsets_and_separation_match_astropy():
    from astropy.coordinates import SkyCoord
    import astropy.units as u
    ra0, dec0 = 269.45, 4.77
    ra, dec = 269.452, 4.7685
    xi, eta = A.tangent_offsets_arcsec(ra, dec, ra0, dec0)
    c0 = SkyCoord(ra0 * u.deg, dec0 * u.deg)
    dlon, dlat = c0.spherical_offsets_to(SkyCoord(ra * u.deg, dec * u.deg))
    assert abs(xi - dlon.to_value(u.arcsec)) < 1e-3 and abs(eta - dlat.to_value(u.arcsec)) < 1e-3
    assert abs(A.angular_sep_arcsec(ra, dec, ra0, dec0) - c0.separation(SkyCoord(ra * u.deg, dec * u.deg)).arcsec) < 1e-6
    r2, d2 = A.from_tangent_arcsec(xi, eta, ra0, dec0)
    assert abs(r2 - ra) < 1e-9 and abs(d2 - dec) < 1e-9


def test_proper_motion_propagation_matches_astropy_space_motion():
    from astropy.coordinates import SkyCoord, Distance
    from astropy.time import Time
    import astropy.units as u
    star = A.CatalogStar("barnard-like", 269.448503, 4.73942, A.GAIA_DR3_EPOCH_MJD, pmra=-801.55, pmdec=10362.39, parallax=0.0)
    mjd = 61000.0
    p = A.propagate(star, mjd, np.zeros(3))            # observer at the barycentre: pure space motion
    c = SkyCoord(star.ra * u.deg, star.dec * u.deg, pm_ra_cosdec=star.pmra * u.mas / u.yr, pm_dec=star.pmdec * u.mas / u.yr,
                 distance=Distance(parallax=1e-6 * u.mas, allow_negative=False), radial_velocity=0 * u.km / u.s,
                 obstime=Time(A.GAIA_DR3_EPOCH_MJD, format="mjd", scale="tcb"))
    c2 = c.apply_space_motion(new_obstime=Time(mjd, format="mjd", scale="tcb"))
    assert A.angular_sep_arcsec(p["ra"], p["dec"], c2.ra.deg, c2.dec.deg) < 0.002   # < 2 mas after 9.9 yr at 10.4"/yr


def test_parallax_matches_plain_geometry():
    # A star 1 pc away (ϖ = 1000 mas), observer displaced 1 au along +x: the apparent direction
    # is (r̂·d − o)/|…| with d = 206264.8 au.
    ra, dec = 30.0, 20.0
    star = A.CatalogStar("near", ra, dec, 60000.0, parallax=1000.0)
    obs = np.array([1.0, 0.0, 0.0])
    p = A.propagate(star, 60000.0, obs)
    d = 1 / math.radians(1 / 3600)                       # au per parsec
    rhat = np.array([math.cos(math.radians(dec)) * math.cos(math.radians(ra)),
                     math.cos(math.radians(dec)) * math.sin(math.radians(ra)), math.sin(math.radians(dec))])
    v = rhat * d - obs
    ra_g, dec_g = math.degrees(math.atan2(v[1], v[0])) % 360, math.degrees(math.asin(v[2] / np.linalg.norm(v)))
    assert A.angular_sep_arcsec(p["ra"], p["dec"], ra_g, dec_g) < 0.001
    shift = A.angular_sep_arcsec(p["ra"], p["dec"], ra, dec)
    assert 0.3 < shift <= 1.0                            # ≤ ϖ, as it must be


def test_covariance_propagation_matches_monte_carlo():
    rng = np.random.default_rng(1)
    s = np.array([0.2, 0.15, 0.25, 0.3, 0.2])             # mas, mas/yr
    corr = np.eye(5)
    corr[0, 3] = corr[3, 0] = 0.6
    corr[1, 4] = corr[4, 1] = -0.4
    cov5 = corr * np.outer(s, s)
    star = A.CatalogStar("mc", 120.0, -30.0, A.GAIA_DR3_EPOCH_MJD, pmra=50.0, pmdec=-80.0, parallax=20.0, cov5=cov5)
    mjd, pob = 61000.0, np.array([0.3, -0.9, -0.4])
    p = A.propagate(star, mjd, pob)
    draws = rng.multivariate_normal(np.zeros(5), cov5, size=4000)
    pts = []
    for dp in draws:
        s2 = A.CatalogStar("d", star.ra + dp[0] / 3.6e6 / math.cos(math.radians(star.dec)), star.dec + dp[1] / 3.6e6,
                           star.ref_epoch_mjd, pmra=star.pmra + dp[3], pmdec=star.pmdec + dp[4], parallax=star.parallax + dp[2])
        q = A.propagate(s2, mjd, pob)
        pts.append(A.tangent_offsets_arcsec(q["ra"], q["dec"], p["ra"], p["dec"]))
    emp = np.cov(np.array(pts).T)
    scale = np.sqrt(np.outer(np.diag(p["cov"]), np.diag(p["cov"])))
    assert np.all(np.abs(emp - p["cov"]) < 0.08 * scale)     # variances and correlation to within 8 %


def test_pixel_covariance_maps_through_a_known_cd_matrix():
    from astropy.wcs import WCS
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval, w.wcs.crpix = [10.0, -5.0], [50, 50]
    t = math.radians(30)
    s = 6.15 / 3600
    w.wcs.cd = np.array([[-s * math.cos(t), s * math.sin(t)], [s * math.sin(t), s * math.cos(t)]])
    J = A.pixel_jacobian_arcsec(w, 49, 49)
    assert np.allclose(J, w.wcs.cd * 3600 * np.array([[1, 1], [1, 1]]), atol=1e-4)
    geo = A.wcs_scale_rotation(w, 49, 49)
    assert abs(geo["scale"] - 6.15) < 1e-4
    cov = A.pixel_cov_to_sky(w, 49, 49, np.eye(2) * 0.01)
    assert np.allclose(cov, np.eye(2) * 0.01 * 6.15 ** 2, rtol=1e-4)


# ----------------------------------------------------------------------------- PSF fitting
def _gauss_epsf(fwhm_px=1.25, o=5, n=33):
    s = fwhm_px / 2.3548 * o
    y, x = np.mgrid[0:n, 0:n] - (n - 1) / 2
    e = np.exp(-(x ** 2 + y ** 2) / (2 * s * s))
    return e / e.sum()


def _star_image(model, xc, yc, flux, sky=1.0, sigma=0.05, n=31, rng=None):
    Y, X = np.mgrid[0:n, 0:n]
    img = flux * model(X, Y, xc, yc) + sky
    var = np.full_like(img, sigma ** 2)
    if rng is not None:
        img = img + rng.normal(0, sigma, img.shape)
    return img, var, np.zeros(img.shape, bool)


def test_epsf_fit_recovers_position_and_flux_with_honest_errors():
    rng = np.random.default_rng(7)
    m = EPSFModel(_gauss_epsf())
    zx, zf = [], []
    for _ in range(300):
        xc, yc = 15 + rng.uniform(-0.5, 0.5), 15 + rng.uniform(-0.5, 0.5)
        img, var, bad = _star_image(m, xc, yc, 20.0, rng=rng)
        f = fit_epsf(img, var, bad, round(xc), round(yc), m)
        zx.append((f["x"] - xc) / f["ex"])
        zf.append((f["flux"] - 20.0) / f["flux_err"])
    cov = S.coverage_1d(zx)["empirical"]
    assert abs(cov[0] - 0.683) < 0.07 and abs(cov[1] - 0.954) < 0.04
    assert abs(np.mean(zf)) < 0.25 and abs(S.coverage_1d(zf)["empirical"][0] - 0.683) < 0.07


def test_epsf_fit_is_unbiased_across_pixel_phase_on_an_undersampled_star():
    # FWHM = 1 px: strongly under-sampled. With the correct ePSF the fitted centre is unbiased at
    # every sub-pixel phase. (Whether the old Gaussian model is biased on *real* SPHEREx stars is
    # measured on real data in the PSF comparison experiment, not asserted here.)
    m = EPSFModel(_gauss_epsf(fwhm_px=1.0))
    errs = []
    for ph in np.linspace(-0.45, 0.45, 10):
        img, var, bad = _star_image(m, 15 + ph, 15.0, 50.0, sigma=0.01)
        errs.append(fit_epsf(img, var, bad, 15, 15, m)["x"] - (15 + ph))
        g = fit_gaussian(img, var, bad, 15, 15)
        assert g is not None and abs(g["flux"] - 50.0) / 50.0 < 0.2
    assert np.max(np.abs(errs)) < 0.01


def test_extendedness_separates_points_from_blurred_sources():
    rng = np.random.default_rng(3)
    e = _gauss_epsf()
    pt = EPSFModel(e)
    ext = EPSFModel(e, blur_px=1.5)
    p_point = [extendedness(*_star_image(pt, 15.2, 14.9, 40.0, rng=rng)[:3], 15, 15, e)["p_point"] for _ in range(20)]
    p_ext = [extendedness(*_star_image(ext, 15.2, 14.9, 40.0, rng=rng)[:3], 15, 15, e)["p_point"] for _ in range(20)]
    assert np.median(p_point) > 0.05
    assert np.max(p_ext) < 1e-3


def test_detection_finds_stars_and_not_noise():
    rng = np.random.default_rng(11)
    m = EPSFModel(_gauss_epsf())
    Y, X = np.mgrid[0:80, 0:80]
    img = 1.0 + rng.normal(0, 0.05, (80, 80))
    for (x, y) in [(20, 20), (50.3, 33.6), (61.7, 64.2)]:
        img += 3.0 * m(X, Y, x, y)
    det = find_sources(img, np.full_like(img, 0.0025), np.zeros(img.shape, bool), nsigma=5)
    assert len(det) == 3
    noise = find_sources(1.0 + rng.normal(0, 0.05, (80, 80)), np.full((80, 80), 0.0025), np.zeros((80, 80), bool), nsigma=5)
    assert len(noise) == 0


# ----------------------------------------------------------------------------- association + solve
def _synthetic_field(rot_deg=37.0, n_stars=40, seed=5):
    from astropy.wcs import WCS
    rng = np.random.default_rng(seed)
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval, w.wcs.crpix = [150.0, 2.0], [40.5, 40.5]
    t, s = math.radians(rot_deg), 6.15 / 3600
    w.wcs.cd = np.array([[-s * math.cos(t), s * math.sin(t)], [s * math.sin(t), s * math.cos(t)]])
    xy = rng.uniform(5, 75, size=(n_stars, 2))
    radec = w.all_pix2world(xy, 0)
    df = pd.DataFrame({"source_id": [str(i) for i in range(n_stars)], "ra": radec[:, 0], "dec": radec[:, 1],
                       "pmra": np.nan, "pmdec": np.nan, "parallax": np.nan, "phot_g_mean_mag": rng.uniform(12, 17, n_stars)})
    ex = SimpleNamespace(shape=(81, 81), wcs=w, mjd=A.GAIA_DR3_EPOCH_MJD, sc_geocentric_km=None)
    meas = [{"x": x + rng.normal(0, 0.05), "y": y + rng.normal(0, 0.05), "snr": 50.0, "saturated": False} for x, y in xy]
    return ex, meas, df, w


def test_seeded_solve_recovers_rotation_and_scale():
    from deepfield.astro.wcsval import solve_seeded
    ex, meas, df, w = _synthetic_field(rot_deg=37.0)
    # seed 1' off the true centre: the solver must find the translation itself
    seed_ra, seed_dec = A.from_tangent_arcsec(40.0, -35.0, 150.0, 2.0)
    r = solve_seeded(ex, meas, df, float(seed_ra), float(seed_dec))
    assert r["passed"], r
    assert abs(r["vs_official"]["rotation_diff_deg"]) < 0.05
    assert abs(r["vs_official"]["scale_ratio"] - 1) < 0.002
    assert r["vs_official"]["max_sep_arcsec"] < 0.5


def test_association_classes():
    from deepfield.astro.wcsval import classify_matches
    base = {"x": 10.0, "y": 10.0, "ra": 150.0, "dec": 2.0, "cov_sky": np.eye(2) * 0.04, "saturated": False}
    one = {"source_id": "a", "ra": 150.0, "dec": 2.0, "cov": np.zeros((2, 2)), "x": 10.0, "y": 10.0, "g": 14.0, "reference_quality": True}
    far = {**one, "source_id": "far", "x": 30.0, "y": 30.0, "ra": 150.02, "dec": 2.02}
    twin = {**one, "source_id": "b", "g": 14.5, "x": 10.05, "ra": 150.0 + 0.3 / 3600}
    faint = {**twin, "source_id": "c", "g": 20.0}
    blend = {**one, "source_id": "d", "g": 14.8, "x": 11.3, "ra": 150.0 + 8.0 / 3600}   # 8" away: not a counterpart, but a blend
    assert classify_matches([base], [one, far], 0.0)[0]["class"] == "confirmed"
    assert classify_matches([base], [one, twin], 0.0)[0]["class"] == "ambiguous"
    assert classify_matches([base], [one, faint], 0.0)[0]["class"] == "confirmed"  # 6 mag fainter: cannot be what was seen
    assert classify_matches([base], [one, blend], 0.0)[0]["class"] == "probable"   # comparable neighbour within 12": not isolated
    assert classify_matches([base], [far], 0.0)[0]["class"] == "none"
    low_q = {**one, "reference_quality": False}
    assert classify_matches([base], [low_q], 0.0)[0]["class"] == "probable"


def test_crop_preserves_the_sip_mapping():
    from astropy.io import fits
    from astropy.wcs import WCS
    from deepfield.astro.exposure import Exposure, crop
    h = fits.Header()
    h.update({"CTYPE1": "RA---TAN-SIP", "CTYPE2": "DEC--TAN-SIP", "CRPIX1": 860.5, "CRPIX2": 757.5,
              "CRVAL1": 327.84, "CRVAL2": -56.34, "CD1_1": -0.0015391, "CD1_2": -0.000732, "CD2_1": -0.0007304, "CD2_2": 0.0015424,
              "A_ORDER": 2, "A_2_0": 1e-6, "A_0_2": -2e-6, "B_ORDER": 2, "B_1_1": 3e-6})
    w = WCS(h)
    ex = Exposure("x", "o", "e", 2, "c", 60000.0, 0.0, np.zeros((100, 100)), np.ones((100, 100)), np.zeros((100, 100), int), w,
                  0.0, 0.0, np.zeros(1), np.zeros(1), np.zeros((1, 33, 33)), 5, {}, None, 7.5, {})
    ra, dec = w.all_pix2world([[60.0, 55.0]], 0)[0]
    c = crop(ex, ra, dec, half=20)
    for (x, y) in [(0, 0), (10.3, 31.7), (40, 40)]:
        a = c.wcs.all_pix2world([[x, y]], 0)[0]
        b = w.all_pix2world([[x + c.provenance["window"]["x0"], y + c.provenance["window"]["y0"]]], 0)[0]
        assert A.angular_sep_arcsec(a[0], a[1], b[0], b[1]) < 1e-6


@pytest.mark.parametrize("bad_input", [np.full((40, 40), np.nan), np.zeros((5, 5))])
def test_detection_on_unusable_input_returns_nothing(bad_input):
    assert find_sources(bad_input, np.ones_like(bad_input), np.zeros(bad_input.shape, bool)) == []
