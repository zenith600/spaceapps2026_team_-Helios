# Scientific audit (2026-11-15, before the validation upgrade)

What Deep Field actually does, traced claim by claim to code, before any change in this round.
"Real" means measured on NASA SPHEREx data; "simulated" means synthetic.

## Architecture

| Part | Where | Role |
| --- | --- | --- |
| Web | `apps/web` (Next.js 16) | Sky Viewer (Simple/Pro), `/proof`, Planet X pages |
| API | `apps/api/deepfield_api` (FastAPI) | builds views on demand, serves bundles, spectra, motion |
| Pipeline | `pipeline/deepfield` | search, cutouts, reprojection, analysis |
| Data | `data/cache/cutouts/<collection>/*.fits` (682 files), `data/sky/<slug>/` (views) | inputs and derived products |
| Deploy | Vercel front end → FastAPI on a VM → NASA IRSA | `apps/web/vercel.json` proxies `/api` |

## Input data (verified by opening the files)

Real SPHEREx DR1/QR3 **Level 2** cutouts from IRSA. Each multi-extension FITS file has:

- `IMAGE` (MJy/sr), `FLAGS` (named bit planes: TRANSIENT, OVERFLOW, NONFUNC, HOT, NONLINEAR,
  PERSIST, OUTLIER, CROSSTALK, SOURCE, GHOST, …), `VARIANCE`, `ZODI`.
- **An official WCS**: `RA---TAN-SIP`, 3rd-order SIP distortion, ICRS, with the pipeline's own
  astrometric QA: `ASTRONETSOLVED = True`, `FINAST = 0` ("good fine-astrometric solution"),
  `MATCH_NSTARS` (≈2,900 matched stars on the full detector), `QS_NMATCH_VAR`.
- **An instrument ePSF**: `EPSF` table, 21×21 detector zones, 33×33 samples, 5× oversampled,
  calibration file `epsf_<det>_20260507.fits`; median `PSF_FWHM` ≈ 7.5″ (≈1.2 px).
- Per-pixel wavelength (`WCS-WAVE`, calibration `spectral_wcs_<det>_v2.2.fits`).
- Provenance: `OBSID`, `EXPIDN`, `DETECTOR`, `MJD-AVG`, exposure time, pipeline `VERSION`,
  calibration-file UUIDs in `HISTORY`, L1/L2 DQA outcome, and the **spacecraft geocentric
  position** (`X_SC`, `Y_SC`, `Z_SC`, km).

Five independent fields are cached (Barnard's Star, ε Indi B, WISE 0855, RW Aurigae,
R Draconis; older overlapping views of two of them also exist). The only **simulated** data
in the project is the Planet X SAMPLE bundle.

## How views are made

Each cutout is bilinearly reprojected onto a common 59×59 TAN grid (6.15″/px) by
`stack/reproject.py`, through the official WCS including SIP. Consequences:

- Variance is interpolated linearly (Σwσ² rather than Σw²σ²): **overestimated** per pixel,
  and the **pixel-to-pixel correlation** the resampling creates is ignored.
- Every downstream measurement (motion, spectra, change detection) uses the resampled cube,
  not the original exposures.

## Claims on the old `/proof`, traced

| Claim | Implementation | Status |
| --- | --- | --- |
| Motion: per-visit Gaussian fit, line fit, Gaia comparison | `sky/motion.py` on the **resampled** cube; Gaussian, not the ePSF | implemented; Gaussian is an approximation |
| Errors "scaled up by √(χ²/dof)", 0.05 px floor | as described; the floor is **assumed**, never measured | approximate |
| "agrees ⇔ n_σ < 3" with n_σ = hypot(Δ/σ)/√2 | `attach_reference` | **heuristic**: not a χ² statistic; ignores Gaia covariance and parallax |
| Epoch propagation J2016 → 2025 | `resolver.Astrometry.at`: linear, **no parallax** | approximate (parallax 0.55″ for Barnard's Star) |
| Gaia markers move with proper motion | `catalogs.py`, pm only, no quality filter | approximate |
| Spectra "on the fly" | 3×3 box mean of **resampled** pixels | not PSF photometry |
| Classifier, "relative weights" | χ² of 3 shapes + 10% floor; `methane_score` = normalised exp(−Δχ²/2) | **relative weight, not a posterior** |
| Change detection, flag z > 5 | per-pixel χ² of a quadratic-in-λ model, robust z vs field MAD | z > 5 is **not** a 5σ detection; pixels are **correlated**; **no multiple-testing correction** |
| WCS correct | never checked against a catalogue | **unvalidated** |
| Uncertainties | from fit covariance | **never empirically calibrated** |
| Injection tests | Planet X only, on the **simulated** SAMPLE bundle | none for the Sky Viewer |
| Holdout | none | **missing** |

## Services available on 2026-11-15

| Service | Status |
| --- | --- |
| ESA Gaia archive TAP | **unreachable** (TCP connect fails, from both the dev PC and the VM) |
| IRSA TAP (sync and async) | **502 Proxy Error** on every try |
| IRSA Gator (`nph-query`) | **works**, including `gaia_dr3_source` (IRSA's Gaia DR3 mirror) |
| NED TAP | **works** |
| Astrometry.net | no local install or index files; nova.astrometry.net needs an account |
| `photutils`, `sep`, `astroquery` | not installed, and the venv has no pip |

## What this round changes (summary; details in `docs/VALIDATION.md`)

Measurements move onto the **original exposures and the official WCS**, the official WCS is
**validated against Gaia DR3** and checked against an **independent seeded plate solution**,
the **instrument ePSF** is used and compared with the Gaussian, epoch propagation includes
**parallax from the spacecraft's own position** (ERFA), comparisons use **covariance-aware
D²**, variability and anomalies get **likelihood-ratio p-values with Benjamini–Hochberg FDR**,
and everything is tested by **injection into real backgrounds** with a **frozen-config holdout**.
