# Deep Field — MVP build plan

Written before code. Scope is the MVP in the brief; everything else in
docs/ARCHITECTURE.md is stretch. Facts below were checked against the real
services on 2026-11-13, not assumed.

## 0. What I verified first

| Thing | Result |
| --- | --- |
| Caltech reference population v3 (`data.caltech.edu/records/8fjad-x7y61`) | 100,000 rows, md5 `a38fa757…`. Columns: `index, mass, a, e, inc, varpi, Omega, M, ra, dec, R, rad, albedo, V, ZTF, DES, PS1`. Epoch JD 2458270.0, J2000 heliocentric osculating elements. ZTF/DES/PS1 columns are 1 if that survey would have detected it. |
| SPHEREx at IRSA | DR1 + QR3 are the searchable releases (QR2 is retired from search). SIA2 endpoint `https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_dr1&POS=circle ra dec r`. 271 DR1 exposures cover a 0.05° circle at (45°, −5°). |
| SPHEREx cutout service | `…/level2_<obsid>_spx_l2b-v27-….fits?center=ra,dec&size=deg`. One 0.25° cutout = 4.3 MB (3.9 MB of it is the EPSF table), ~12 s per fetch. |
| Cutout MEF layout | HDU1 `IMAGE` float32 MJy/sr, TAN-SIP WCS, 6.15″/px, `MJD-AVG`, `PSF_FWHM`≈7.5″, `CRPIX1A/2A` give the offset into the 2040² detector. HDU2 `FLAGS` int32 bitmask (TRANSIENT, OVERFLOW, NONFUNC, HOT, COLD, OUTLIER, SOURCE, STREAK, BLOOM, SNOWBALL, HALO, …). HDU3 `VARIANCE` MJy²/sr². HDU4 `ZODI`. HDU5 `EPSF` 441 rows of 33×33 (5× oversampled). HDU6 `WCS-WAVE` 9×9 lookup (wavelength, bandwidth µm) in raw detector coords. |
| SPHEREx time sampling at one point | Visits of ~7–12 days with ~50–140 exposures across the 6 detectors, then ~6 months to the next visit. |
| JPL Horizons | `COMMAND='-163182'` (SPHEREx) returns heliocentric ICRF vectors. |
| JPL SBIdent | Reachable (400 on a malformed probe; real query built in the wrapper). |
| Machine | RTX 2050 4 GB, CUDA driver 13.4, Python 3.11 via uv, Node 24, Docker 29. |
| 14-day rule | Cutoff for any pinned version: released on or before 2026-10-30. All pins in `pipeline/requirements.txt`, `apps/api/requirements.txt`, `apps/web/package.json` were chosen from PyPI/npm release dates on that basis. |

## 1. Things in the architecture I am changing or flagging

1. **healpy → astropy-healpix.** healpy ships no Windows wheels; astropy-healpix does, and gives the same ang2pix/pix2ang/nside maths. Same dependency in Docker so there is one code path.
2. **"102-band spectrum per candidate" is not available in one visit.** Each pixel sees one wavelength set by its position on the LVF. In one 12-day visit a sky point gets ~10–25 distinct bands, not 102. The UI will show "N of 102 bands measured" and never imply full coverage.
3. **Stack within one visit, not across the 6-month gap.** Parallax for a 500 AU object is ~7″/day near quadrature, so a 12-day visit gives ~84″ ≈ 14 px of motion: enough for shift-and-stack to discriminate distance, and small enough that the trajectory stays inside a 0.25° cutout. Cross-visit linking is stretch.
4. **WISE epochs are stretch.** Dropped from the MVP.
5. **Depth expectation is honest, not optimistic.** SPHEREx single exposures are shallow (6″ pixels, ~19 AB 5σ). Stacking ~40 frames gains ~2 mag. The Caltech population has V≈19–23; in the near-IR a cold methane giant is fainter still outside the 1–1.6 µm reflectance peak. The injection tests will show most reference-population planets are below our limit. That is the point of the Proof page.
6. **Dossier agent needs an API key.** No `ANTHROPIC_API_KEY` exists on this machine. The generator is written against the Anthropic SDK, and ships a deterministic offline "template reporter" that is labelled `generator: "offline-template"` in each JSON. Flagged in STATUS.md.
7. **Deploys need accounts.** No fly/vercel/supabase CLIs or credentials here. I ship `fly.toml`, `vercel.json`, Dockerfiles, the Supabase migration and a one-command deploy script; the actual deploy is a user action listed in STATUS.md.
8. **Exclusion counter is two numbers.** "Ruled out by ZTF+DES+PS1" comes straight from the CSV (fraction of rows with any of the three flags). "Ruled out by Deep Field" is the additional fraction of *surviving* planets that crossed a searched patch during the visit at a predicted SPHEREx brightness above our measured 50 % completeness. With 3 patches of 0.25° this is a small number and will be displayed as such.
9. **ONNX-in-browser is stretch.** The model is exported to ONNX and validated with onnxruntime in Python; `ml_score` in `candidates.parquet` is precomputed. Loading it in the browser is a later step.
10. **DEMO_MODE on the frontend means no API at all.** The web app reads `public/demo/*.json` and PNG stamps, and runs the same SWAP consensus maths in TypeScript with votes in localStorage. The API has its own `DEMO_MODE` that serves the frozen files and keeps votes in SQLite/memory.

## 2. Repo layout

```
deepfield/
  manifest.yaml                 dataset allowlist (domains, owners, licences, countries)
  docker-compose.yml            api + web
  .env.example
  docs/ ARCHITECTURE.md PLAN.md STATUS.md
  pipeline/
    requirements.txt
    deepfield/
      config.py                 paths, DEMO_MODE, patch count
      contracts.py              schemas (pyarrow) + sample writers for every file contract
      data/   manifest.py (allowlist guard on every HTTP call), cache.py,
              spherex.py (SIA2 + cutouts), horizons.py, sbident.py, refpop.py
      prior/  orbits.py (Kepler propagation), priormap.py, targets.py
      stack/  geometry.py (parallax offsets), reproject.py, shiftstack.py (torch), extract.py
      spectral/ wavelengths.py, templates.py, fit.py
      inject/ inject.py, completeness.py
      ml/     dataset.py, model.py, train.py, export.py, rules.py
      agents/ dossier.py (Claude or offline template)
      crowd/  consensus.py (SWAP)
      cli.py                    `python -m deepfield.cli <step>`
  apps/api/   FastAPI: main.py, routes (map, candidates, task, vote), store.py (sqlite|supabase), Dockerfile, fly.toml
  apps/web/   Next.js 16 app router: / (Hunt), /lab, /classify, /proof; lib/consensus.ts; public/demo/
  supabase/migrations/0001_init.sql
  scripts/check_manifest_domains.py   CI allowlist check
  tests/      test_geometry.py test_orbits.py test_stack.py test_consensus.py test_api.py test_manifest.py
  data/samples/   committed fake contracts (tiny)
  data/release/   frozen demo data produced by the pipeline (committed, small)
  data/cache/     gitignored FITS/parquet cache
```

## 3. File contracts

All parquet files carry `schema_version`, `generated_at`, `data_source` in file metadata. Row-level `source` columns name the dataset. Anything simulated carries `is_simulated = true`.

### prior_map.parquet (HEALPix nside=32, RING, 12288 rows)
| col | type | meaning |
| --- | --- | --- |
| hpix | int32 | RING index |
| ra_deg, dec_deg | float64 | cell centre |
| n_all | int32 | reference planets in cell at the map epoch |
| n_surviving | int32 | … not excluded by ZTF/DES/PS1 |
| n_remaining | int32 | … also not excluded by Deep Field searches |
| p_surviving | float64 | n_surviving / total surviving |
| p_remaining | float64 | n_remaining / total remaining |
| searched | bool | a Deep Field patch overlaps this cell |
Metadata: `epoch_mjd`, `population_version`, `frac_excluded_prior`, `frac_excluded_deepfield`.

### targets.parquet
`patch_id str, rank int32, ra_deg, dec_deg, radius_deg, hpix int32, p_surviving, n_exposures int32, mjd_start, mjd_end, visit_label str, status str (planned|fetched|searched), score float64, source str`.

### candidates.parquet
`candidate_id str, patch_id str, ra_deg, dec_deg, is_simulated bool, injection_id str|null, injected_mag float|null, injected_distance_au float|null, snr_stack, snr_single_max, best_distance_au, best_rate_ra_arcsec_day, best_rate_dec_arcsec_day, flux_mjysr, n_epochs int32, n_bands int32, methane_score, template_best str, ml_score, rule_score, crowd_p_real, n_votes int32, status str (simulated|candidate|artifact|known|expert), known_object str|null, stamp_dir str, dossier_path str, source str, created_mjd`.

### spectra.parquet (long)
`candidate_id, obs_id, detector int8, mjd, wavelength_um, bandwidth_um, flux_mjysr, flux_err_mjysr, model_planet, model_asteroid, model_star, source`.

### completeness.parquet
`patch_id str ("ALL" for pooled), axis str (mag|distance_au), bin_lo, bin_hi, n_injected int32, n_recovered int32, fraction, snr_threshold, source`.

### dossiers/<candidate_id>.json
```json
{"candidate_id":"…","generated_at":"…","generator":"claude-…|offline-template","is_simulated":true,
 "scout":{"summary":"…","facts":[…]},
 "skeptic":{"checks":[{"name":"known_object","result":"…"}],"verdict":"…"},
 "reporter":{"headline":"…","dossier_md":"…","mpc_report":null},
 "verdict":"simulated|candidate|artifact|known","confidence":0.0,"sources":[…]}
```

### model.onnx
Input `stamps` float32 [N,3,32,32] (ch0 stacked SNR stamp, ch1 static-sky stamp, ch2 best single epoch), output `prob` float32 [N,1]. `model.json` beside it: training set sizes, val AUC, git sha, `trained_from_scratch: true`.

### Stamps
`stamps/<candidate_id>/single_<k>.png`, `stack.png`, `static.png`, plus `stamps.npz` (float arrays used by ML and the Lab). Every PNG carries a `source` text chunk.

### Frontend demo bundle (`apps/web/public/demo/`)
`map.json` (counter + per-cell list), `map_equirect.png` (globe texture), `targets.json`, `candidates.json`, `spectra/<id>.json`, `completeness.json`, `dossiers/<id>.json`, `manifest.json`, `stamps/…`. Produced by `python -m deepfield.cli export-demo`.

## 4. API

| route | returns |
| --- | --- |
| GET /map | `{frac_excluded_prior, frac_excluded_deepfield, frac_excluded_total, n_patches_searched, cells:[{hpix,ra,dec,p_remaining,searched}], source}` |
| GET /candidates?patch=&include_simulated=true | ranked candidate rows + dossier/stamp URLs |
| GET /candidates/{id} | one candidate + spectrum |
| GET /task?user= | next card: `{task_id, candidate_id, is_test (never sent), stamps, prompt}` |
| POST /vote `{user_id, task_id, answer, click}` | `{correct (if test), points, consensus, user_reliability, map_delta}` |
| GET /completeness, GET /manifest, GET /health | |

Store: SQLite file by default, Supabase (PostgREST) when `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` are set. `DEMO_MODE=1` ⇒ frozen files, SQLite in temp.

## 5. Crowd maths (SWAP)
User has two skills `p_real = P(says real | real)`, `p_bogus = P(says bogus | bogus)` with Beta(2,1)-ish priors (start 0.6). Each test card updates the matching skill. A candidate's `p_real` starts at the ML/rule prior and is updated by Bayes with each weighted vote; `nothing` and `artifact` both count as "bogus". Points: +10 correct on test card, −2 wrong, +3 for agreeing with final consensus. Identical TypeScript port for DEMO_MODE, tested in both languages against the same fixtures.

## 6. Task order
1. Scaffold, manifest, allowlist guard + CI check, `.env.example`, pinned deps. ✔ once `pytest tests/test_manifest.py` passes.
2. `contracts.py` + `data/samples/*` fake files; demo export; frontend skeleton reading them. End-to-end on fake data.
3. API routes on the sample files + SQLite store + tests.
4. Reference population loader; Kepler propagation (test: reproduces the CSV's own ra/dec at epoch); prior map; target ranking against real SIA2 coverage.
5. SPHEREx wrapper (SIA2 + cutouts, cache); Horizons wrapper; geometry (parallax offsets, test against Horizons).
6. Reprojection + torch shift-and-stack; test recovers an injected source in synthetic frames; then run on real patches.
7. Injection tests on real frames → completeness; spectral extraction + template fit.
8. CNN on injection stamps → ONNX; rule score fallback.
9. Dossiers (offline template; Claude if key present).
10. Freeze demo bundle; docker compose; README; STATUS.

## 7. Risks I am watching
- Download volume: 40 exposures × 3 patches × 4.3 MB ≈ 0.5 GB, ~25 min. Capped by `PATCH_MAX_EXPOSURES`, cached, resumable.
- 4 GB GPU: trial grid chunked; CPU fallback tested.
- pandas 3 string dtype and copy-on-write: keep pyarrow-backed frames, avoid chained assignment.
- Next.js 16 / React 19 / Tailwind 4: use the `@tailwindcss/postcss` plugin, not the v3 config.
