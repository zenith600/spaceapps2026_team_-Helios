# Deep Field — scientific validation

This document describes the validation pipeline (`pipeline/deepfield/astro`, `pipeline/deepfield/validation`),
how to reproduce it, and what it measured. The audit that motivated it is in [SCIENCE_AUDIT.md](SCIENCE_AUDIT.md).
The same results are rendered, from the machine-readable report, on the web app's `/proof` page.

## Reproduce

```bash
# Python 3.12; pip install -r pipeline/requirements.txt (numpy, scipy, astropy, pyerfa, pandas, pyyaml)
PYTHONPATH=pipeline:apps/api python -m deepfield.validation \
    --config pipeline/deepfield/validation/configs/v1.yaml        # full run (≈ 1 h on a laptop)
PYTHONPATH=pipeline:apps/api python -m deepfield.validation \
    --config pipeline/deepfield/validation/configs/v1.yaml --only rw_aur   # one field
PYTHONPATH=pipeline:apps/api python -m pytest -q -m "not network" tests  # unit tests
```

On Windows use `;` instead of `:` in `PYTHONPATH`.

Inputs: SPHEREx Level 2 cutouts already cached under `data/cache/cutouts` for the fields' views in `data/sky/<slug>`
(build a view with the app or `python -m deepfield.sky` to fetch them). Catalogue queries (IRSA Gator for Gaia DR3,
2MASS XSC and AllWISE; NED TAP) are cached under `data/cache/catalogs/v2/` with their query, retrieval time and SHA-256.

Each run writes `data/validation/<run_id>/`:

| file | contents |
|---|---|
| `config.yaml` | the exact config used (its hash is part of the run id) |
| `environment.json` | Python, NumPy, SciPy, Astropy, PyERFA versions; git commit and dirty flag |
| `inputs.json` | per exposure: file SHA-256, OBSID, detector, MJD, pipeline version, calibration-file UUIDs, ePSF and spectral-WCS calibration files, official astrometry QA; per catalogue query: service, parameters, time, row count, checksum |
| `frozen_params.json` | parameters fixed after development + calibration, with hash and timestamp, written before any holdout field is opened |
| `report.json` | every metric |
| `log.txt` | per-exposure log |

A compact copy of the report is written to `apps/web/public/validation/report.json` for the `/proof` page.

## Protocol

| split | fields | used for |
|---|---|---|
| development | RW Aurigae, Barnard's Star | choosing the covariance policy (raw vs χ²-inflated) and the extendedness blur threshold, from injections |
| calibration | Epsilon Indi B | astrometric systematic floor σ_sys and photometric floor f_sys, from real stars |
| holdout | R Draconis, WISE 0855−0714, Teegarden's Star, a high-latitude field (RA 210.25, Dec −5.5) | evaluated once with frozen parameters |

Fixed before running (in the config): seed 20261115, window 91×91 px, pass criteria, injection populations,
the χ² thresholds. No threshold was changed after holdout results were seen.

## Methods (summary)

* **Exposures.** Original L2 cutouts, never resampled. IMAGE, VARIANCE, FLAGS; NASA's ePSF (21×21 zones, 5× oversampled)
  evaluated at each source's zone; per-pixel wavelength from the WCS-WAVE table; spacecraft position from the header.
* **WCS.** Official TAN-SIP solution (pipeline Astrometry.net solve). Independently: seeded solve (rotation/parity/translation
  vote + `fit_wcs_from_points`, 5-fold out-of-sample residuals). Pass: ≥ 6 matches, vote ratio ≥ 2, OOS RMS ≤ 0.35 px, scale ±2 %.
* **Gaia DR3.** Reference filter RUWE < 1.4, 5/6-parameter, 8 ≤ G ≤ 19.5, not duplicated. ERFA `pmpx` propagation from J2016.0
  to each exposure's MJD-AVG as seen from SPHEREx (ERFA `epv00` + spacecraft geocentric vector); 5×5 covariance propagated by
  numerical Jacobian. Matching by D² = Δᵀ(C_DF + C_G + σ_sys² I)⁻¹Δ < 11.83 (χ²₂, p = 0.0027);
  confirmed / probable / ambiguous / no match as defined in `astro/wcsval.py`.
* **Catalogues.** 2MASS XSC, AllWISE (`ext_flg`), NED (type, redshift), Gaia galaxy probability; associations keep catalogue,
  ID, separation, radius used, and query provenance. A missing Gaia match is never evidence of a galaxy.
* **PSF.** ePSF fit (flux, x, y, background) by `scipy.optimize.least_squares` in a 7×7 box with flagged pixels masked;
  covariance (JᵀJ)⁻¹, optionally × max(1, χ²/dof). Gaussian (previous model) fitted to the same pixels for comparison.
  Extendedness: LRT of ePSF ⊗ Gaussian(w) vs ePSF, boundary-corrected p, Fisher-combined across exposures.
* **Motion.** Per-exposure zero point from confirmed field stars; GLS fit of p₀ + μt (+ ϖP); comparison with Gaia by
  D² = Δμᵀ(C_DF + C_G)⁻¹Δμ. Registration check on every field star with ≥ 5 % inconsistent → target result unreliable.
  Saturated targets use wing fits only if wing fits of saturated field stars pass coverage on the same field.
* **Variability.** Primary: matched-wavelength pairs (|Δλ|/λ < 1/(2R)) across visits, ≥ 3 pairs or "inconclusive".
  Secondary: LRT of S(λ) (cubic in ln λ) vs S(λ)·a_visit. Benjamini–Hochberg q-values across sources.
* **Injection.** Sources drawn with the exposure's ePSF into real exposures, photon noise from the empirical
  variance-vs-signal slope; static, moving, variable, steep-spectrum, extended, blended pairs; fixed seed.
* **Coverage.** Fraction of normalised errors inside the 68.27 / 95.45 / 99.73 % regions (1-D: |z|; 2-D: χ²₂ quantiles),
  with Wilson intervals on completeness.

## Results

Run `20261115T101859Z-7368806b` · config hash `7368806b74d7bee9` · seed 20261115 · commit `9faa28b` (clean) ·
frozen parameters `6f172bb01f91ad46` (σ_sys = 0.000″, covariance policy "inflated", f_sys = 0.07, extendedness blur ≥ 0.5 px) ·
17 min on a laptop. Full numbers: `apps/web/public/validation/report.json` and `/proof`.

"Real" = measured on real SPHEREx exposures against Gaia DR3. "Synthetic" = sources injected into real exposures.

### Decisions made before the holdout

| decision | evidence | outcome |
|---|---|---|
| position covariance policy | development injections, distance from nominal 68/95 % coverage: raw 0.65, inflated 0.15 | **inflated** (× max(1, χ²/dof)) |
| extendedness threshold | development scan 0.5–1.0 px: false-extended 8.6 % → 5.7 %, recall 91 % → 62 % | **no threshold met the ≤ 5 % target**; pre-set default 0.5 px kept (8.6 % on development) |
| astrometric floor σ_sys | Epsilon Indi B real stars (n = 1346) | 0.000″ (formal errors already cover) |
| photometric floor f_sys | 46 Epsilon Indi B stars, median null χ²/dof → 0.98 | 0.07 |

### Holdout results (frozen parameters, evaluated once)

| field | official WCS vs Gaia, median / RMS (n) [real] | pre-set WCS criteria | seeded solves passed [real] | 50 % completeness [synthetic] | registration: field stars inconsistent [real] | target |
|---|---|---|---|---|---|---|
| R Draconis | 0.644″ / 1.744″ (1574) | **failed**: min stars/exposure (2 < 5); median > 0.6″ | 27 / 85 | SNR 10–20 | 0 / 41 | not measurable (saturated in 85/85) |
| WISE 0855−0714 | 0.365″ / 0.791″ (1378) | **failed**: min stars/exposure (4 < 5) | 21 / 40 | SNR 5–7 | 1 / 56 | none designated |
| Teegarden's Star | 0.340″ / 1.024″ (367) | **failed**: min stars/exposure (4 < 5) | 25 / 39 | SNR 5–7 | 0 / 15 | not measurable (3/39 unsaturated) |
| High-latitude field | 0.368″ / 1.013″ (701) | **failed**: min stars/exposure (0 < 5) | 25 / 45 | SNR 5–7 | 0 / 27 | none designated |

Independent seeded solve, holdout: **98 / 209** exposures pass; failures are mostly the vote-ratio ("unambiguous") check in sparse
windows. Where it passes, it agrees with the official WCS to 0.13–0.36″ at the window centre and ≤ 1.1″ (median) at the corners, scale 1.000 ± 0.002,
rotation ≤ 0.03° (median).

R Draconis (G = 6.4) shows a ≥ 3σ position-dependent residual (ξ vs y: 0.54 ± 0.13″ per 100 px) and 33 of 40 classified sources labelled
"extended, not in catalogues" — consistent with the saturated star's halo; there is no bright-star mask yet.

### By category

| quantity | result | dataset |
|---|---|---|
| ePSF vs Gaussian (4939 star-exposures) | ePSF lower χ² in 80 %, closer to Gaia in 66 %; median offset 0.269″ vs 0.367″; Gaussian flux 8 % low; ePSF χ²/dof still 13–96 at SNR > 100 | real |
| Proper motion, Epsilon Indi B (calibration field, 40 epochs) | 4.627 ± 0.048″/yr vs Gaia 4.684″/yr, D² = 1.51, p = 0.47 (consistent). Free parallax 319 ± 22 mas vs Gaia 271 mas (2.2σ). Gaia RUWE 4.3 | real |
| Barnard, Teegarden, RW Aur, R Dra | not measurable under the strict protocol (saturated); wing fits failed coverage in every field | real |
| Field-star proper motions vs Gaia | 0–1.8 % inconsistent at p < 0.0027 in every field | real |
| Moving injections detected (p < 0.0027) | 77–100 %; static wrongly "moving" 0–9.1 % (expected 0.27 %) | synthetic |
| Variability, primary test | static false positives 0–15 % (holdout 0–14 %, target 5 %); steep constant spectra 0–17 % (model-fit LRT: 18–100 %); detection 0–25 % at 10 %, 33–80 % at 20 %, 38–100 % at 50 % amplitude | synthetic |
| Real variability candidates (BH q < 0.05) | 12 across 7 fields, concentrated where the static false-positive rate is high; **not** confirmed variables | real |
| Extended sources | recall 83–100 %; points called extended 0–13 % | synthetic |
| Blends | pairs < 1.8 px apart are almost never resolved | synthetic |

### Uncertainty coverage (fraction inside nominal 68.3 / 95.4 / 99.7 %)

| quantity | range across fields | verdict |
|---|---|---|
| injected positions (inflated) | 72–87 / 86–95 / 91–97 % | near nominal at 68–95 %, heavy tails |
| injected positions (raw fit errors) | 32–62 / 55–88 / 68–94 % | too small — why "inflated" was chosen |
| injected fluxes | 38–62 / 63–90 / 78–97 % | **too small** |
| injected proper motions | 60–70 / 82–89 / 85–95 % | OK at 68 %, low in tails |
| real WCS residuals vs Gaia | dev 94–95 / 99 / 100 %; holdout 63–72 / 87–92 / 100 % | over-cover in development, slightly under at 95 % in holdout |
| real field-star pm vs Gaia | 60–92 / 95–100 / 98–100 % | roughly calibrated |

### What this does and does not show

* Implemented and unit-tested (27 tests in `tests/test_astro_core.py` and `tests/test_astro_measure.py`, within 225 passing Python tests): everything above.
* Empirically validated on real data: official-WCS accuracy where ≥ 5 stars are present; ePSF superiority; epoch-aware Gaia
  propagation (via field-star proper motions); one faint target's proper motion (calibration field).
* Partly validated, with failures: seeded solve, extendedness, variability false-positive control, uncertainty tails.
* Not shown: any holdout measurement of a named target's motion; performance on saturated stars; galaxy identification on a
  galaxy-rich field; independent verification by anyone else.
