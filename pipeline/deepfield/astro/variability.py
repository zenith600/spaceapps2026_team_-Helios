"""Variability that cannot be confused with colour.

SPHEREx sees a different wavelength in almost every exposure, so "the flux changed between
exposures" is mostly the source's spectrum, not time. The test therefore compares two models
for one source's forced-photometry fluxes Fᵢ at wavelengths λᵢ and visits vᵢ:

    null:        Fᵢ = S(λᵢ)                    S = cubic polynomial in ln λ (smooth spectrum)
    alternative: Fᵢ = S(λᵢ) · g_{vᵢ}           one achromatic factor per visit, mean(g) = 1

i.e. F(λ, t) = S(λ) + V(λ, t) + ε with V restricted to per-visit scalings. Errors are
σᵢ² + (f_sys·Ŝᵢ)², f_sys an empirically calibrated floor for cross-detector calibration and
the crudeness of S. The likelihood-ratio Δχ² = χ²_null − χ²_alt ~ χ² with (n_visits − 1) dof
under the null.

Identifiability: if every visit samples a different wavelength range, a per-visit factor is
indistinguishable from spectral shape. The test is only run when at least three disjoint pairs
of measurements from different visits observe the same wavelength (|Δλ|/λ < 1/(2R), R = the
SPHEREx resolving power for that band); otherwise the result is **inconclusive**.

Primary statistic: the **matched-wavelength pair test** — χ² = Σ zₖ² over those pairs, with
zₖ = (F_a − F_b)/√(σ_a² + σ_b²) (floors included), χ² with (number of pairs) dof. It needs no
spectral model, so a steep but constant spectrum cannot masquerade as variability. The
likelihood-ratio test above is reported as secondary: in injection tests a cubic-in-ln λ
spectrum could not follow steep power laws (β = ±3) and the LRT flagged 100 % of those
constant sources as variable, which is why it is not the primary test.

Multiple testing: p-values from all sources tested in a field are converted to Benjamini–
Hochberg q-values; "candidate variable" means q < 0.05. That is a candidate, not a discovery.
"""
from __future__ import annotations

import numpy as np

from deepfield.astro import stats as S

#: SPHEREx resolving power by wavelength (bands 1–6, approximate band edges in µm).
R_BANDS = [(0.75, 1.11, 41.0), (1.11, 1.64, 41.0), (1.64, 2.42, 41.0), (2.42, 3.82, 35.0), (3.82, 4.42, 110.0), (4.42, 5.01, 130.0)]


def resolving_power(lam_um: float) -> float:
    for lo, hi, R in R_BANDS:
        if lo <= lam_um < hi:
            return R
    return 41.0


def forced_flux(image, variance, bad, x, y, model, box: int = 3) -> dict | None:
    """Linear least squares for flux and background with the PSF fixed at (x, y)."""
    ny, nx = image.shape
    xi, yi = int(round(x)), int(round(y))
    ys = slice(max(yi - box, 0), min(yi + box + 1, ny))
    xs = slice(max(xi - box, 0), min(xi + box + 1, nx))
    Y, X = np.mgrid[ys, xs]
    d, v, b = image[ys, xs], variance[ys, xs], bad[ys, xs]
    ok = ~b & np.isfinite(d) & np.isfinite(v) & (v > 0)
    if ok.sum() < 12:
        return None
    psf = model(X[ok].astype(float), Y[ok].astype(float), x, y)
    if psf.sum() < 0.3:                                   # most of the PSF is masked: no honest flux
        return None
    w = 1.0 / v[ok]
    A = np.stack([psf, np.ones_like(psf)], 1)
    F = A.T @ (A * w[:, None])
    try:
        cov = np.linalg.inv(F)
    except np.linalg.LinAlgError:
        return None
    beta = cov @ (A.T @ (w * d[ok]))
    r = d[ok] - A @ beta
    chi2 = float(np.sum(w * r * r))
    return {"flux": float(beta[0]), "flux_err": float(np.sqrt(cov[0, 0])), "background": float(beta[1]),
            "chi2_dof": chi2 / max(ok.sum() - 2, 1), "psf_frac_used": float(psf.sum())}


def _basis(lam):
    L = np.log(np.asarray(lam, float))
    L = L - L.mean()
    return np.stack([np.ones_like(L), L, L ** 2, L ** 3], 1)


def _wls(B, F, sig2):
    w = 1.0 / sig2
    M = B.T @ (B * w[:, None])
    c = np.linalg.solve(M + 1e-12 * np.trace(M) * np.eye(M.shape[0]), B.T @ (w * F))
    return c, float(np.sum(w * (F - B @ c) ** 2))


def overlap_pairs(lam, visit) -> list[tuple[int, int]]:
    """Disjoint pairs of measurements from different visits at matched wavelength."""
    lam, visit = np.asarray(lam, float), np.asarray(visit)
    used, pairs = set(), []
    cand = []
    for i in range(len(lam)):
        for j in range(i + 1, len(lam)):
            if visit[i] != visit[j]:
                tol = lam[i] / (2 * resolving_power(lam[i]))
                d = abs(lam[i] - lam[j])
                if d < tol:
                    cand.append((d, i, j))
    for _, i, j in sorted(cand):
        if i not in used and j not in used:
            pairs.append((i, j))
            used |= {i, j}
    return pairs


def variability_test(lam, flux, flux_err, visit, f_sys: float = 0.03, min_visits: int = 2) -> dict:
    lam, F, e, visit = map(np.asarray, (lam, flux, flux_err, visit))
    ok = np.isfinite(lam) & np.isfinite(F) & np.isfinite(e) & (e > 0)
    lam, F, e, visit = lam[ok], F[ok], e[ok], visit[ok]
    vis = np.unique(visit)
    counts = {int(v): int((visit == v).sum()) for v in vis}
    multi = [v for v in vis if counts[int(v)] >= 2]
    pairs = overlap_pairs(lam, visit)
    base = {"n": int(len(F)), "n_visits": int(len(vis)), "overlap_pairs": len(pairs)}
    if len(F) < 6 or len(multi) < min_visits or len(pairs) < 3:
        return {**base, "testable": False, "verdict": "inconclusive",
                "reason": "spectral and temporal sampling cannot be separated (too few visits observe the same wavelengths)"}
    B = _basis(lam)
    # null: smooth spectrum; errors include the floor relative to the model (two passes)
    sig2 = e ** 2 + (f_sys * np.abs(F)) ** 2
    for _ in range(2):
        c0, chi_null = _wls(B, F, sig2)
        sig2 = e ** 2 + (f_sys * np.abs(B @ c0)) ** 2
    # alternative: per-visit achromatic factor (alternating least squares)
    g = {v: 1.0 for v in vis}
    for _ in range(8):
        gv = np.array([g[v] for v in visit])
        c1, _ = _wls(B * gv[:, None], F, sig2)
        Sm = B @ c1
        w = 1.0 / sig2
        for v in vis:
            m = visit == v
            den = float(np.sum(w[m] * Sm[m] ** 2))
            g[v] = float(np.sum(w[m] * F[m] * Sm[m]) / den) if den > 0 else 1.0
        mean_g = np.mean(list(g.values()))
        g = {v: gg / mean_g for v, gg in g.items()}
    gv = np.array([g[v] for v in visit])
    c1, chi_alt = _wls(B * gv[:, None], F, sig2)
    dchi = max(chi_null - chi_alt, 0.0)
    dof = len(vis) - 1
    p_lrt = float(S.chi2_sf(dchi, dof))
    z = np.array([(F[i] - F[j]) / np.sqrt(sig2[i] + sig2[j]) for i, j in pairs])
    p_pairs = float(S.chi2_sf(float(np.sum(z ** 2)), len(z)))
    amp = float(np.max(list(g.values())) - np.min(list(g.values())))
    return {**base, "testable": True, "chi2_null": float(chi_null), "dof_null": int(len(F) - 4),
            "chi2_null_dof": float(chi_null / max(len(F) - 4, 1)), "delta_chi2": float(dchi), "dof_lrt": int(dof),
            "p_lrt": p_lrt, "p_pairs": p_pairs, "p_primary": p_pairs, "primary_test": "matched-wavelength pairs",
            "visit_factors": {int(k): float(v) for k, v in g.items()},
            "peak_to_peak": amp, "f_sys": f_sys}


def calibrate_floor(per_star: list[tuple], grid=np.round(np.arange(0.0, 0.205, 0.005), 3)) -> dict:
    """Smallest f_sys for which the median null χ²/dof over (presumed mostly constant) stars is ≤ 1."""
    per_star = [s for s in per_star if len(s[0]) >= 6]
    if len(per_star) < 10:
        return {"f_sys": None, "n_stars": len(per_star), "reason": "fewer than 10 stars with ≥ 6 measurements"}
    for f in grid:
        vals = []
        for lam, F, e, v in per_star:
            B = _basis(lam)
            sig2 = np.asarray(e) ** 2 + (f * np.abs(F)) ** 2
            for _ in range(2):
                c, chi = _wls(B, np.asarray(F, float), sig2)
                sig2 = np.asarray(e) ** 2 + (f * np.abs(B @ c)) ** 2
            vals.append(chi / max(len(F) - 4, 1))
        if np.median(vals) <= 1.0:
            return {"f_sys": float(f), "n_stars": len(per_star), "median_chi2_dof": float(np.median(vals))}
    return {"f_sys": float(grid[-1]), "n_stars": len(per_star), "median_chi2_dof": float(np.median(vals)),
            "note": "reached the top of the grid"}
