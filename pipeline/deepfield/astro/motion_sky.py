"""Proper motion measured in sky coordinates on the original exposures, graded against Gaia.

Per exposure: the target is ePSF-fitted on the original pixels, mapped to the sky through the
official WCS, and corrected by that exposure's own astrometric zero point (the weighted mean
offset of its confirmed, isolated Gaia field stars, excluding the target). The corrected
positions (ξᵢ, ηᵢ), each with a full 2×2 covariance Cᵢ = C_fit + C_zp, are fitted by
generalised least squares with

    [ξ, η](t) = p₀ + μ·t + ϖ·P(t)

where P(t) are ERFA parallax factors for SPHEREx's own position at each exposure. The parallax
term is fitted only when the epochs constrain it (enough spread in P); otherwise it is fixed
(to Gaia's value when comparing with Gaia, or to 0) and that choice is reported.

Comparison with Gaia: Δμ = μ_DF − μ_Gaia, D² = Δμᵀ (C_DF + C_Gaia)⁻¹ Δμ, p = P(χ²₂ ≥ D²).
Consistent when p ≥ 0.0027 (the 2-D equivalent of 3σ). The same test on every confirmed field
star checks the registration: if field stars do not reproduce their own Gaia motions, any
target result is flagged as possibly a registration/calibration artefact.
"""
from __future__ import annotations

import numpy as np

from deepfield.astro import astrometry as A
from deepfield.astro import stats as S

P_CONSISTENT = 0.0027


# ----------------------------------------------------------------------------- zero points
def exposure_zero_point(matches: list[dict], exclude_ids=(), min_stars: int = 5) -> dict | None:
    """Weighted mean (ξ, η) offset of confirmed field stars, with outlier rejection (D² < 9.21, p=0.01)."""
    rows = [m for m in matches if m["class"] == "confirmed" and m.get("match") not in set(exclude_ids)]
    if len(rows) < min_stars:
        return None
    d = np.array([[m["dxi"], m["deta"]] for m in rows])
    C = np.array([np.asarray(m["cov_total"]) for m in rows])
    # start from the median (an outlier cannot drag it), then iterate weighted mean ↔ rejection
    mean = np.median(d, axis=0)
    keep = S.mahalanobis2(d - mean, C) < 9.21
    if keep.sum() < min_stars:
        keep = np.ones(len(rows), bool)
    for _ in range(5):
        W = np.linalg.inv(C[keep])
        cov = np.linalg.inv(W.sum(0))
        mean = cov @ np.einsum("nij,nj->i", W, d[keep])
        new = S.mahalanobis2(d - mean, C) < 9.21
        if new.sum() < min_stars or (new == keep).all():
            break
        keep = new
    resid = d[keep] - mean
    chi2 = float(np.einsum("ni,nij,nj->", resid, np.linalg.inv(C[keep]), resid))
    dof = max(2 * int(keep.sum()) - 2, 1)
    cov_scaled = cov * max(1.0, chi2 / dof)                       # do not trust the formal error below the scatter
    return {"mean": mean.tolist(), "cov": cov_scaled.tolist(), "n": int(keep.sum()), "chi2_dof": chi2 / dof}


# ----------------------------------------------------------------------------- fitting
def fit_motion(t_years, xi, eta, covs, pfac=None, parallax_mode: str = "auto", parallax_fixed_arcsec: float = 0.0,
               scale_by_chi2: bool = True) -> dict:
    """GLS fit of p₀ + μt (+ ϖP). Inputs in arcsec / years. Returns μ (arcsec/yr) and its covariance."""
    t = np.asarray(t_years, float)
    y = np.stack([xi, eta], 1).astype(float)
    C = np.asarray(covs, float)
    n = len(t)
    P = np.zeros((n, 2)) if pfac is None else np.asarray(pfac, float)
    fit_px = parallax_mode == "free" or (parallax_mode == "auto" and n >= 6 and pfac is not None
                                         and np.std(P[:, 0]) > 0.3 and np.std(P[:, 1]) > 0.15)
    if not fit_px:
        y = y - P * parallax_fixed_arcsec
    k = 5 if fit_px else 4
    rows, Wb = [], []
    for i in range(n):
        Xi = np.zeros((2, k))
        Xi[0, 0] = Xi[1, 1] = 1.0
        Xi[0, 2] = Xi[1, 3] = t[i]
        if fit_px:
            Xi[:, 4] = P[i]
        rows.append(Xi)
        Wb.append(np.linalg.inv(C[i]))
    F = sum(X.T @ W @ X for X, W in zip(rows, Wb))
    b = sum(X.T @ W @ yi for X, W, yi in zip(rows, Wb, y))
    cov = np.linalg.inv(F)
    beta = cov @ b
    resid = [yi - X @ beta for X, yi in zip(rows, y)]
    chi2 = float(sum(r @ W @ r for r, W in zip(resid, Wb)))
    dof = max(2 * n - k, 1)
    red = chi2 / dof
    cov_used = cov * max(1.0, red) if scale_by_chi2 else cov
    mu = beta[2:4]
    Cmu = cov_used[2:4, 2:4]
    out = {"pm_arcsec_yr": mu.tolist(), "cov_pm": Cmu.tolist(), "pm_total": float(np.hypot(*mu)),
           "pa_deg": float((np.degrees(np.arctan2(mu[0], mu[1])) + 360) % 360),
           "chi2": chi2, "dof": dof, "chi2_dof": red, "errors_scaled": bool(scale_by_chi2 and red > 1),
           "parallax_fitted": bool(fit_px), "n_epochs": n,
           "parallax_arcsec": float(beta[4]) if fit_px else float(parallax_fixed_arcsec),
           "parallax_err": float(np.sqrt(cov_used[4, 4])) if fit_px else None}
    J = np.array([mu[0], mu[1]]) / max(out["pm_total"], 1e-12)
    out["pm_total_err"] = float(np.sqrt(max(J @ Cmu @ J, 0)))
    # significance of any motion at all
    out["motion_d2"] = float(S.mahalanobis2(mu, Cmu))
    out["motion_p"] = float(S.chi2_sf(out["motion_d2"], 2))
    return out


def compare_pm(fit: dict, gaia_pm_mas, gaia_cov_mas) -> dict:
    """Covariance-aware comparison of a fitted proper motion with Gaia's: D² and its χ²₂ p-value."""
    g = np.asarray(gaia_pm_mas, float) / 1000.0
    Cg = np.asarray(gaia_cov_mas, float) / 1e6
    d = np.asarray(fit["pm_arcsec_yr"]) - g
    d2 = float(S.mahalanobis2(d, np.asarray(fit["cov_pm"]) + Cg))
    p = float(S.chi2_sf(d2, 2))
    return {"gaia_pm_arcsec_yr": g.tolist(), "gaia_total": float(np.hypot(*g)), "delta": d.tolist(), "d2": d2, "p": p,
            "consistent": bool(p >= P_CONSISTENT)}


# ----------------------------------------------------------------------------- epochs → fit
def epochs_to_fit(epochs: list[dict], ref_ra: float, ref_dec: float, t0_mjd: float, *,
                  parallax_mode="auto", parallax_fixed_arcsec=0.0, scale_by_chi2=True) -> dict | None:
    """`epochs`: [{"mjd", "ra", "dec", "cov" (2×2 arcsec²), "pob"}] → motion fit in the tangent plane at (ref_ra, ref_dec)."""
    if len(epochs) < 3:
        return None
    t = np.array([(e["mjd"] - t0_mjd) / A.DAYS_PER_JULIAN_YEAR for e in epochs])
    if np.ptp(t) < 60 / 365.25:
        return None
    xi, eta = A.tangent_offsets_arcsec(np.array([e["ra"] for e in epochs]), np.array([e["dec"] for e in epochs]), ref_ra, ref_dec)
    P = np.array([A.parallax_factors(ref_ra, ref_dec, e["mjd"], e["pob"]) for e in epochs])
    covs = [e["cov"] for e in epochs]
    return fit_motion(t, xi, eta, covs, P, parallax_mode, parallax_fixed_arcsec, scale_by_chi2)


def gaia_pm_cov_mas(row) -> np.ndarray:
    c5 = A.gaia_cov5(row)
    return c5[3:5, 3:5]


def label(target_fit: dict | None, gaia_cmp: dict | None, registration_ok: bool | None, has_gaia: bool) -> str:
    if target_fit is None:
        return "not measurable (too few usable epochs)"
    if registration_ok is False:
        return "unreliable: field stars do not reproduce their Gaia motions (registration/calibration problem)"
    if has_gaia and gaia_cmp is not None:
        return ("known stellar proper motion: consistent with Gaia DR3" if gaia_cmp["consistent"]
                else "inconsistent with Gaia DR3: check blending, saturation or registration")
    if target_fit["motion_p"] < P_CONSISTENT:
        return "candidate moving source (no Gaia counterpart; NOT validated)"
    return "no significant motion"
