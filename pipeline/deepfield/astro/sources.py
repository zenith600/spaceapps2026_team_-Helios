"""Point source or galaxy? Morphology from SPHEREx itself, identity from catalogues.

Evidence is combined, never inferred from absence:

- **Morphology** (SPHEREx): the ePSF ⊗ Gaussian(w) likelihood-ratio test (`psf.extendedness`)
  per exposure, combined across exposures with Fisher's method. "Resolved" needs a combined
  p < 1e-3 *and* a median best blur ≥ 0.5 px. At 6.15″ pixels most galaxies are unresolved, so
  "not resolved" is not "not a galaxy".
- **Catalogues** within a radius scaled to each catalogue's precision:
  NED (`prefphytype`, redshift), 2MASS XSC (an extended-source catalogue: membership means
  extended in 2MASS), AllWISE `ext_flg` > 0, Gaia DR3 (`classprob_dsc_combmod_galaxy`,
  `in_galaxy_candidates`; and a significant parallax or proper motion means "star").

A source never becomes a galaxy just because it lacks a Gaia match. Every association records
catalogue, release, identifier, coordinates, separation, method, confidence and retrieval time.
"""
from __future__ import annotations

import numpy as np
from scipy import stats as _st

from deepfield.astro.astrometry import angular_sep_arcsec

#: catalogue match radii (arcsec): roughly 1/3 of a SPHEREx pixel plus the catalogue's own precision
RADII = {"gaia": 2.0, "ned": 3.0, "twomass_xsc": 4.0, "allwise": 3.0}


def fisher_combine(pvals) -> float:
    p = np.clip(np.asarray([x for x in pvals if x is not None and np.isfinite(x)], float), 1e-300, 1.0)
    if len(p) == 0:
        return float("nan")
    return float(_st.chi2.sf(-2 * np.sum(np.log(p)), 2 * len(p)))


def morphology(ext_results: list[dict], min_blur_px: float = 0.5, p_threshold: float = 1e-3) -> dict:
    ok = [r for r in ext_results if r]
    if not ok:
        return {"resolved": None, "n": 0}
    p = fisher_combine([r["p_point"] for r in ok])
    w = float(np.median([r["best_blur_px"] for r in ok]))
    return {"n": len(ok), "p_point_combined": p, "median_blur_px": w, "min_blur_px": min_blur_px,
            "resolved": bool(p < p_threshold and w >= min_blur_px)}


def _nearest(df, ra, dec, radius, ra_col="ra", dec_col="dec"):
    if df is None or len(df) == 0:
        return []
    sep = angular_sep_arcsec(df[ra_col].to_numpy(float), df[dec_col].to_numpy(float), ra, dec)
    idx = np.nonzero(sep < radius)[0]
    return sorted(((float(sep[i]), i) for i in idx))


def associate(ra: float, dec: float, cats: dict, provs: dict) -> list[dict]:
    """All catalogue entries near (ra, dec), as provenance-rich association records."""
    out = []
    for name, df in cats.items():
        r = RADII.get(name, 3.0)
        prov = provs.get(name, {})
        for sep, i in _nearest(df, ra, dec, r):
            row = df.iloc[i]
            rec = {"catalog": name, "release": prov.get("release"), "retrieved_at": prov.get("retrieved_at"),
                   "separation_arcsec": round(sep, 3), "match_radius_arcsec": r, "method": "nearest within radius",
                   "ra": float(row["ra"]), "dec": float(row["dec"])}
            if name == "gaia":
                rec.update({"id": f"Gaia DR3 {row['source_id']}", "g_mag": float(row.get("phot_g_mean_mag", np.nan)),
                            "galaxy_prob": float(row.get("classprob_dsc_combmod_galaxy", np.nan)),
                            "parallax_over_error": float(row["parallax"] / row["parallax_error"]) if np.isfinite(row.get("parallax", np.nan)) and row.get("parallax_error", 0) > 0 else None,
                            "epoch": "J2016.0"})
            elif name == "ned":
                rec.update({"id": str(row["prefname"]), "type": str(row.get("prefphytype")), "z": None if not np.isfinite(row.get("z", np.nan)) else float(row["z"]),
                            "z_flag": str(row.get("zflag"))})
            elif name == "twomass_xsc":
                rec.update({"id": f"2MASX {row['designation']}", "type": "extended (2MASS XSC)",
                            "r_k20fe_arcsec": float(row.get("r_k20fe", np.nan)), "k_mag": float(row.get("k_m_k20fe", np.nan))})
            elif name == "allwise":
                rec.update({"id": f"AllWISE {row['designation']}", "ext_flg": int(row.get("ext_flg", 0) or 0),
                            "w1_mag": float(row.get("w1mpro", np.nan))})
            out.append(rec)
    return out


def classify(morph: dict, assoc: list[dict], gaia_pm_significant: bool | None = None) -> dict:
    """Combine morphology and catalogue evidence into a class, a confidence and the reasons."""
    gal_cat = [a for a in assoc if (a["catalog"] == "ned" and str(a.get("type", "")).upper().startswith(("G", "QSO", "Q")))
               or a["catalog"] == "twomass_xsc" or (a["catalog"] == "allwise" and a.get("ext_flg", 0) > 0)
               or (a["catalog"] == "gaia" and (a.get("galaxy_prob") or 0) > 0.5)]
    star_cat = [a for a in assoc if (a["catalog"] == "ned" and str(a.get("type", "")).startswith("*"))
                or (a["catalog"] == "gaia" and ((a.get("parallax_over_error") or 0) > 5 or gaia_pm_significant))]
    gaia = [a for a in assoc if a["catalog"] == "gaia"]
    resolved = morph.get("resolved")
    reasons = []
    if resolved:
        reasons.append(f"wider than the ePSF in SPHEREx (combined p = {morph['p_point_combined']:.1e}, blur ≈ {morph['median_blur_px']:.2f} px)")
    for a in gal_cat:
        reasons.append(f"{a['catalog']}: {a.get('type') or a.get('id')} at {a['separation_arcsec']}″")
    for a in star_cat:
        reasons.append(f"{a['catalog']}: stellar evidence ({a.get('id')}) at {a['separation_arcsec']}″")
    if gal_cat and star_cat:
        cls, conf = "ambiguous (catalogues disagree or a star and a galaxy are blended)", "low"
    elif gal_cat and resolved:
        cls, conf = "galaxy: catalogue match and resolved by SPHEREx", "high"
    elif gal_cat:
        cls, conf = "galaxy: catalogue match, unresolved at 6″", "medium"
    elif resolved:
        cls, conf = "extended source, not in the catalogues searched (candidate galaxy or blend)", "medium"
    elif star_cat:
        cls, conf = "star: catalogue astrometry shows parallax or proper motion", "high"
    elif gaia:
        cls, conf = "point source with a Gaia counterpart (most likely a star)", "medium"
    else:
        cls, conf = "unresolved source with no catalogue counterpart (unclassified)", "low"
    return {"class": cls, "confidence": conf, "reasons": reasons,
            "point_source_analysis_ok": not bool(resolved), "n_associations": len(assoc)}
