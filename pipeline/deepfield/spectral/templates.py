"""Simple, clearly-labelled spectral templates for the three-way check (cold planet / asteroid / star).

All three are toy models:
  * Solar spectrum ~ 5772 K blackbody in F_nu, normalised at V (0.55 um).
  * Cold giant planet: reflected sunlight x geometric albedo with CH4 absorption bands
    (0.89, 1.15, 1.4, 1.7, 2.3, 3.3 um). Depths are illustrative, not a radiative-transfer model.
  * Asteroid: reflected sunlight x slightly red, featureless albedo.
  * Star: 4500 K blackbody (a typical faint field star in the near-IR).
"""
from __future__ import annotations

import numpy as np

H_PLANCK, C_LIGHT, K_B = 6.62607015e-34, 2.99792458e8, 1.380649e-23
V_UM = 0.55
F0_AB_JY = 3631.0


def planck_nu(wave_um: np.ndarray, T: float) -> np.ndarray:
    nu = C_LIGHT / (np.asarray(wave_um, float) * 1e-6)
    x = H_PLANCK * nu / (K_B * T)
    return nu ** 3 / np.expm1(x)


def solar_fnu_rel(wave_um) -> np.ndarray:
    """Solar F_nu relative to its value at V."""
    return planck_nu(wave_um, 5772.0) / planck_nu(np.array([V_UM]), 5772.0)[0]


def _dip(w, c, width, depth):
    return 1 - depth * np.exp(-0.5 * ((w - c) / width) ** 2)


def planet_albedo(wave_um) -> np.ndarray:
    w = np.asarray(wave_um, float)
    a = 0.6 * np.ones_like(w)
    for c, wd, d in ((0.89, 0.03, 0.5), (1.15, 0.04, 0.6), (1.4, 0.06, 0.8), (1.7, 0.07, 0.8), (2.3, 0.12, 0.9), (3.3, 0.25, 0.9)):
        a = a * _dip(w, c, wd, d)
    a = a * np.where(w > 2.6, np.exp(-(w - 2.6) / 1.5), 1.0)  # weak reflected light at long wavelengths
    return a


def asteroid_albedo(wave_um) -> np.ndarray:
    w = np.asarray(wave_um, float)
    return 0.6 * (1 + 0.15 * (w - V_UM))  # slightly red, featureless


def template_fnu(kind: str, wave_um) -> np.ndarray:
    """Relative F_nu of each template, normalised so that the planet/asteroid templates equal 1 at V."""
    w = np.asarray(wave_um, float)
    if kind == "planet":
        return solar_fnu_rel(w) * planet_albedo(w) / planet_albedo(np.array([V_UM]))[0]
    if kind == "asteroid":
        return solar_fnu_rel(w) * asteroid_albedo(w) / asteroid_albedo(np.array([V_UM]))[0]
    if kind == "star":
        return planck_nu(w, 4500.0) / planck_nu(np.array([V_UM]), 4500.0)[0]
    raise KeyError(kind)


def vmag_to_fnu_jy(vmag: float) -> float:
    """AB-ish zero point: 3631 Jy at m=0 (V Vega->AB offset ~0.02 mag, ignored)."""
    return F0_AB_JY * 10 ** (-0.4 * vmag)


def planet_flux_mjy(vmag: float, wave_um) -> np.ndarray:
    """Total flux (MJy) of a cold planet of catalogue V magnitude at the given wavelengths (planet template)."""
    return vmag_to_fnu_jy(vmag) * template_fnu("planet", wave_um) * 1e-6


def fit_templates(wave_um, flux, err) -> dict:
    """Weighted least-squares scale for each template; returns chi2, scales and a normalised 'methane score'."""
    w, f, e = np.asarray(wave_um, float), np.asarray(flux, float), np.asarray(err, float)
    ok = np.isfinite(f) & np.isfinite(e) & (e > 0)
    out = {"n": int(ok.sum())}
    if ok.sum() < 2:
        out.update({"chi2": {k: np.nan for k in ("planet", "asteroid", "star")}, "scale": {}, "methane_score": np.nan, "best": "none"})
        return out
    chi2, scale, models = {}, {}, {}
    for kind in ("planet", "asteroid", "star"):
        t = template_fnu(kind, w)
        wt = 1 / e[ok] ** 2
        s = max(float((wt * t[ok] * f[ok]).sum() / max((wt * t[ok] ** 2).sum(), 1e-30)), 0.0)
        scale[kind] = s
        models[kind] = s * t
        chi2[kind] = float((((f[ok] - s * t[ok]) / e[ok]) ** 2).sum())
    c = np.array([chi2["planet"], chi2["asteroid"], chi2["star"]])
    like = np.exp(-0.5 * (c - c.min()))
    p = like / like.sum()
    out.update({"chi2": chi2, "scale": scale, "models": models, "methane_score": float(p[0]),
                "best": ["planet", "asteroid", "star"][int(np.argmax(p))]})
    return out
