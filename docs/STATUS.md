# Status — what works, what is faked, what is blocked

Last updated 2026-11-14, on `feat/workstation-motion`: motion measurement, epoch-corrected
targets, Simple/Pro interfaces, and the Planet X screens moved behind an experimental label.

This page exists so nobody has to guess. If something below is marked **real**, it was
run against the live service and the numbers quoted are from that run.

## The challenge objective

> Create a public-facing web tool to display images of the sky from the SPHEREx mission,
> making it easy for anyone to quickly see how they change over time. Users will enter
> the coordinates of a patch of sky… Your tool will display a series of images of that
> patch like a little video.

| Requirement | State |
| --- | --- |
| Enter RA/Dec | **Real.** `/sky` (also the site's front door) takes decimal degrees, sexagesimal in four spellings, or a name. |
| Series of images as a video | **Real.** Blink player: play/pause, 0.8–10 fps, scrub, step, loop, keyboard. |
| Test on Barnard's Star | **Real.** 40 frames, 17 visits, 403-day baseline, 36/102 bands. Motion measured: **10.39 ± 0.54″/yr** (Gaia DR3: 10.39). |
| Test on Epsilon Indi B | **Real.** 51 frames, 19 visits, 526-day baseline, 43/102 bands. Motion of Ba measured: **4.49 ± 0.30″/yr** (Gaia DR3: 4.68). |
| Test on WISE 0855 | **Real view, no motion measurement.** 44 frames, 11 visits, 374-day baseline, 41/102 bands. See §WISE 0855. |
| Test on RW Aurigae | **Real.** 42 frames, 7 visits, 380-day baseline, 42/102 bands. Motion 0.45 ± 0.31″/yr — consistent with zero, as it should be (Gaia: 0.03). |
| Test on R Draconis | **Real.** 93 frames, 31 visits, 426-day baseline, 82/102 bands. Its core saturates, so no visit gives a usable position and the motion panel says so; the spectrum panel explains the same limit. |

### Optional considerations from the brief

| Suggestion | State |
| --- | --- |
| Easy to update with new data releases | **Real.** Collections are discovered from IRSA ObsTAP, not hardcoded; a background refresher reports new exposures and new releases; a weekly workflow re-bakes the demo. See §Live refresh. |
| Creative use of the 102 bands | **Real.** Per-detector coadds, per-visit coadds, per-exposure wavelengths, honest "N of 102" everywhere, and false-colour composites mapping the bands to RGB (longest red, shortest blue). |
| Spectra on the fly | **Real.** Click a pixel; the spectrum is assembled at click time from the per-exposure cube, in the browser on a static deployment or in the API otherwise. A pixel with no usable data explains why (saturation, flags) and offers a jump to the nearest usable pixel. The shape is fitted against three physical models plus a blackbody colour temperature. |
| Add/subtract images from different times | **Real.** Stack-all and static-sky overlays, difference-from-first-visit frames, and an arbitrary visit-A-minus-visit-B comparison made on demand from calibrated flux. |
| Let users choose the field of view | **Real.** 0.02°–0.5°, in the URL, labelled in plain words. |
| Overlay other telescopes (Gaia, WISE) | **Real.** Gaia DR3 (ESA TAP), AllWISE and 2MASS (IRSA TAP), cone-searched and projected onto the viewer's pixel grid. Gaia markers move along Gaia's own proper motions to each frame's date; AllWISE (2010) and 2MASS (1997–2001) markers stay at their survey epoch, so a fast mover visibly leaves them. |
| Coordinates in the URL for embedding | **Real.** `/sky?ra=&dec=&fov=&mode=`, every control included; `&ui=pro` opens the same view in the workstation. |
| Display metadata like contamination flags | **Real.** Per-frame FLAGS fractions, a colour-coded RGBA overlay with a legend, and a per-pixel flag bitmask used to explain empty spectra. The Pro workstation adds a searchable metadata panel. |
| Use Astropy / Aladin | **Real.** Astropy throughout the pipeline (WCS, reprojection, coordinates); Aladin Lite v3 embedded as an optional, lazily-loaded sky-context panel. |

## Seeing the motion: measured, drawn, checked

The movers shift 1–2 SPHEREx pixels over the survey so far. Real, but easy to miss by eye,
so each view now carries a measurement (`pipeline/deepfield/sky/motion.py`, baked into
`motion.json`, served by `GET /sky/motion/{slug}`):

1. each exposure loses its own median background;
2. per visit, the exposures that see the source are inverse-variance coadded and a 2-D
   Gaussian plus background is fitted in a 7×7 box (SPHEREx under-samples its PSF, so a plain
   centroid is biased by pixel phase);
3. x(t), y(t) are fitted as straight lines, errors scaled up when the visits scatter more than
   they predict;
4. the nearest Gaia DR3 source, carried to the same epoch, is the comparison.

| Target | This tool, from SPHEREx | Gaia DR3 | |
| --- | --- | --- | --- |
| Barnard's Star | 10.393 ± 0.543″/yr, PA 356.6° (5 visits usable; the core is flagged in the rest) | 10.393″/yr, PA 355.6° | 0.14σ |
| Epsilon Indi Ba | 4.490 ± 0.301″/yr, PA 123.8° (18 visits) | 4.684″/yr, PA 121.8° | 0.54σ |
| RW Aurigae (control) | 0.446 ± 0.312″/yr — no detectable motion | 0.028″/yr | 0.95σ |
| A static field star in the WISE 0855 view (control) | 0.29 ± 0.47″/yr | — | — |

The player draws it: a dashed ring where the source started, its measured position at every
visit, the fitted line, and a solid ring riding the fit to the current frame. Pinned by
`tests/test_sky_motion.py` (synthetic views with a known answer) and `lib/workstation/engine.test.ts`.

### The epoch bug this exposed

Catalogue positions were J2000. Barnard's Star moves 10.4″/yr, so by 2025 it was 4.4 arcmin
north of its J2000 position — **outside its own 0.1° view**; the "bright star at the centre"
was a different star. Epsilon Indi Ba was 2 arcmin off-centre. Built-in movers now carry Gaia
DR3 astrometry (source ids in `sky/resolver.py`) and are centred on it carried forward to
2025-09-07 (`VIEW_EPOCH_MJD`, fixed so a view's slug does not change daily). Barnard's Star
and Epsilon Indi B were rebuilt from IRSA. Proxima Centauri (not a challenge target) is not
yet carried forward: the Gaia archive timed out on its crowded field.

### WISE 0855

It is too cold for Gaia, and the brief's position — used verbatim — is from 2010-era WISE
data. Carried forward with its published motion (~8.1″/yr west), it lies about 2 arcmin west
of the view centre in 2025, **within 8 arcsec of a brighter background star**. SPHEREx's 6″
pixels do not separate the two. Two hints that it is there: that star is twice as bright at
4–5 µm relative to its short-wavelength light as the field's typical star (0.55 vs 0.27; 2
MADs — suggestive, not conclusive), and its long-wavelength position sits ~0.5 px toward the
predicted WISE 0855 position. Only 4 visits detect it beyond 3.8 µm, so a motion fit gives
±4.9″/yr — useless — and the tool does not claim one.

## Spectral classification fix

The "star" hypothesis was one fixed 4500 K blackbody, while "reflected sunlight" is a 5772 K
blackbody tilted red by an asteroid albedo — so cool stars (an M dwarf is ~3100 K) fitted
"reflected sunlight" better and were labelled asteroids. The star hypothesis is now the best
blackbody between 2,300 and 12,000 K, in `sky/analyse.py` and its browser port
`lib/spectralFit.ts`, held together by the regenerated Python fixture. The Planet X search's
own `fit_templates` is unchanged.

On real data: Barnard's Star now reads **star-like at 3165–3346 K** at every pixel with a
usable spectrum (an M4 dwarf's effective temperature is ~3100–3200 K). **Limit, measured:**
Epsilon Indi Ba — a T-type brown dwarf — also reads "star-like", at ~2500 K. The methane
template is reflected *sunlight* with methane dips, right for a cold planet but not for a
self-luminous brown dwarf; an emitting version with the same dips fitted Ba *worse* than a
plain blackbody (Δχ² −270 to −400), because the dips are illustrative rather than real T-dwarf
band shapes. Rather than add a hypothesis the data rejects, the "star-like" text now says a
warm brown dwarf can land there, and Ba's guidance no longer promises methane in its spectrum.
Real brown-dwarf templates are the fix.

## Two interfaces

- **Simple** (default): the original single page, plain language, phone-friendly.
- **Pro** (`?ui=pro`, desktop): a workstation over the same data session, playback engine and
  frame renderer — layers (incl. the motion track), properties, searchable metadata, pixel
  histogram in calibrated MJy/sr, the processing graph, undo/redo, a time-axis timeline, and a
  cache/performance panel that reads real cache state (and `GET /sky/cache` on the server).
  Tools with no backing operation (region selections, annotation, tracking) are shown disabled
  and say what they would need.

## Beyond the brief

| Feature | State |
| --- | --- |
| Find what changed | **Real, calibrated on real data.** Removes each exposure's background, fits each pixel's brightness as a smooth curve in wavelength, and scores the residual against the field's own distribution. On the baked targets the two variable stars rank first in their fields (RW Aurigae z=43, R Draconis z=10). **Limit:** a slow mover in a crowded field need not top the list — which is why motion is now *measured* rather than left to this scan. |
| Spectral classification | **Real.** Methane-rich reflection / reflected sunlight / stellar blackbody (fitted temperature), plus a free colour temperature, with a χ² ranking and a 10% systematic floor. Refuses below three distinct colours. **Limit:** these are simple shapes; the UI says a match is a hint, not an identification. |
| "Odd one out" flag | **Real, field-relative.** Flagged when a point fits worse than 95% of 150 randomly sampled points in the same field, calibrated at bake time. |
| Machine-written field captions | **Real.** Coordinates outside the built-in catalogue get a plain-language caption written from measured facts by an LLM, with claim-rejection and a deterministic fallback. Always labelled. |

## Real, verified against live services

| Thing | Evidence |
| --- | --- |
| SPHEREx SIA2 search | 2026-11-14: WISE 0855 returns 282 DR1 exposures, 11 visits, MJD 60800.70–61174.29 (374 days). Barnard's Star (re-centred) 386; Epsilon Indi B (re-centred) 486. |
| SPHEREx cutouts | 91 fetched on 2026-11-14 for the two re-centred views (101 requested, 10 skipped as unusable); 591 Level 2 cutouts in the local fetch cache in all. MEF decoded: IMAGE, FLAGS, VARIANCE, ZODI, EPSF, WCS-WAVE. |
| Gaia DR3 astrometry | ESA TAP, 2026-11-14: source ids, J2016.0 positions and proper motions for Barnard's Star, Epsilon Indi Ba and Teegarden's Star. |
| Release discovery | IRSA ObsTAP returns `spherex_dr1, spherex_dr1_cal, spherex_dr1_cube, spherex_dr1_deep, spherex_qr3, spherex_qr3_deep`. The viewer searches the two image releases. |
| Freshness checks | Uncached 4.8 s against IRSA, cached 0.002 s. |
| On-the-fly spectra | Assembled per click from the per-exposure cube; the browser decoder matches the Python reference on the real bundle to within one quantisation step (`lib/sky.cube.test.ts`). |
| Planet X shift-and-stack | Patch P001: 39 exposures, 201 trials, max stacked SNR 33.3, 18 known bodies matched from JPL SBIdent. |
| JPL Horizons | SPHEREx (−163182) heliocentric vectors, cached. |
| Caltech reference population | 100,000 orbits, md5 verified. |

## Faked, simulated, or placeholder — and labelled as such in the UI

| Thing | Note |
| --- | --- |
| Planet X · experimental (`/hunt`, `/lab`, `/classify`, `/proof`) | Serve the synthetic **SAMPLE** bundle (candidates C0001–C0012). Grouped under "Planet X · experimental" in the nav, with a banner on every page; the site's front door is the Sky Viewer. |
| Exclusion counter | Computed from the real Caltech population for the prior term, but the Deep Field term is driven by the SAMPLE patches. |
| Candidate dossiers | `generator: "offline-template"`; the agent team has never run on this machine. |
| Injection completeness | Real run, but P001 recovered 0/32 injections. The honest answer, and the Proof page curve is therefore flat. |

## Blocked or not started

| Thing | Why |
| --- | --- |
| Nothing is deployed | `vercel.json`, `fly.toml`, Dockerfiles and the Supabase migration are ready; the deploy itself is a human action. A static Vercel deploy serves the five baked targets with no API; any other coordinate needs the API. |
| Measuring motion at an arbitrary pixel without the API | `GET /sky/motion/{slug}?x=&y=` does it server side; the static deployment ships only the baked measurement of each view's target. |
| The LLM endpoint is slow | 62–220 s per reply; captions are written once at bake time and cached, never waited on in the request path. |
| CDS Sesame / Aladin may be unreachable | Name resolution falls back to the built-in catalogue; the Aladin panel loads only on request and says so if it fails. Typed coordinates always work. |
| Two-visit patches cannot be localised (Planet X) | **Diagnosed and enforced, not a bug.** See §Cross-visit search. |

## Live refresh — how the tool keeps up with new data

Three independent layers, so no single thing has to be remembered:

1. **Collection discovery.** `releases.py` asks IRSA ObsTAP which `spherex_*` collections
   exist and caches it for 6 h. When `spherex_dr2` appears it is searched immediately —
   no code change, no redeploy. Non-image products (`_cal`, `_cube`, `_deep`) are listed
   but excluded by the pattern `^spherex_(dr|qr)\d+$`.
2. **Per-view freshness.** Every `sky.json` records the exposure count and latest `t_max`
   per collection at build time. `GET /sky/bundle/{slug}/freshness` diffs that against
   what IRSA has now, and the web app shows a *"N new exposures — rebuild"* banner.
   Answers are served from a background sweep (`SKY_REFRESH_MINUTES`, default 30) so
   many pollers do not become many upstream queries.
3. **Scheduled re-bake.** `.github/workflows/sky-refresh.yml` rebuilds the committed demo
   targets weekly and opens a PR when they change.

Knobs: `SKY_REFRESH_MINUTES`, `SKY_AUTO_REBUILD`, `SKY_ALLOW_LIVE`, `SKY_FETCH_WORKERS`,
`SKY_MAX_ACTIVE_JOBS`, `SKY_FRESHNESS_TTL_HOURS`, `SPHEREX_COLLECTIONS`.

## Cross-visit search — what the visit count buys you

Measured on synthetic patches (a source at 500 AU plus two variable stars, amp 8 in unit noise):

| Visits | Result |
| --- | --- |
| 1 | Plain co-add. No distance information; the global median absorbs a sub-pixel mover. |
| 2 | **Position not recoverable.** Peak lands 73 px away even though the source is strong. Two time samples cannot separate parallax from proper motion. |
| 3 | Position recovered to within 2 px. Distance poorly constrained. |
| 4 | Position recovered; distance 498 AU against a true 500 AU. |

Two further findings, both now pinned by tests:

- **The detection threshold was meaningless.** The SNR map is a *maximum over every trial* at
  every pixel, which inflates it far above a single-test z-score. On a real two-visit patch with
  8038 trials the map's own median was 4.7, so the fixed 5-sigma cut passed roughly half the map.
  The 14 peaks the first P001 run reported were almost certainly all noise. The threshold is now
  calibrated per patch from the map's own robust median and MAD plus `sqrt(2 ln N_eff)`, floored
  at 5, and recorded in `summary.json`.
- **"Median of the other visits" is the wrong static template at two visits.** With V visits the
  source occupies 1/(V−1) of the frames in that median, so at V = 2 the template *is* the other
  visit, source included, and subtracting it stamps a negative ghost of the source into the
  residual (measured: −3.97 at the other visit's source position for an amp-8 source in unit
  noise). The search locks onto those ghosts. `prepare()` now defaults to the global median,
  which is clean for V ≥ 3 because the source is then in only 1/V of the frames.

## Tests

```
python -m pytest tests -q -m "not network"   198 pass, 0 fail   (2026-11-14)
                                   5 network tests (CDS Sesame) run separately; they skip when CDS is down
cd apps/web && npm test            242 pass
cd apps/web && npx tsc --noEmit    clean
cd apps/web && npm run build       clean
python scripts/check_manifest_domains.py   allowlist holds
```

The two cross-language checks are the ones worth knowing about, because they catch the
failure mode that silent divergence would cause:

- `apps/web/lib/sky.test.ts` asserts the TypeScript coordinate parser and slug produce
  exactly the strings `tests/test_sky_api.py` asserts on the Python side. If they drift,
  the same search addresses different bundles in DEMO mode and API mode.
- `apps/web/lib/sky.cube.test.ts` runs the browser's spectrum decoder over the real baked
  WISE 0855 cube and compares it against a Python-generated fixture
  (`scripts/make_spectrum_fixture.py`). It found two genuine bugs: a dropped good-pixel
  mask, and a quantiser range poisoned by the 1e6 variance fill used for bad pixels.

## Three features that passed their tests and were still wrong

Each was caught by running the merged app on the real baked targets, not by the synthetic
tests, and each is now pinned by a test that would have caught it:

- **Change detection detected colour.** A constant-brightness model ignores that every SPHEREx
  exposure sees a different wavelength. Median χ²/dof across *empty sky* was 7–97 and nearly
  every pixel flagged. Fixed with per-frame background removal (7.1 → 0.95 on Barnard's Star),
  a wavelength-polynomial model, and a field-relative z.
- **"Odd one out" fired on every real star.** Random sky pixels have a median best-template
  χ²/dof of 13–19, so any fixed threshold flags everything. Now field-relative.
- **The browser cube lost variance precision.** Variance spans ~4×10⁹ within one frame; linear
  uint16 left 10% of pixels wrong by >38%. Now stored in log space (p99 error 0.015%). The test
  that should have caught it derived its tolerance from the quantiser's own step — a tolerance
  that scales with the quantiser cannot catch a bad quantiser. It is now a fixed 0.5%.

## AI and ML — what is trained, what is not, and on whose weights

| Component | What it is | Weights |
| --- | --- | --- |
| Real/bogus classifier | Small CNN over 3×32×32 stamps | **Trained from scratch** on our own injections. Exported to ONNX and runs in the browser. |
| Spectral classification | Weighted least-squares fit of three physical templates + a blackbody temperature | **No model at all** — the templates are closed-form physics in `spectral/templates.py`. |
| Change detection | Per-pixel χ² against a constant | **No model at all.** |
| "Odd one out" | Best-template χ²/dof over a threshold | **No model at all.** |
| Field captions | Hosted LLM writing prose from a numeric fact sheet | Third-party **text** service. Touches no pixel and feeds nothing back into the science. |

The project rule excludes third-party pretrained weights from the data path, and that holds:
every number in this tool comes from physics or from a network we trained ourselves. The LLM
writes captions and nothing else. `manifest.yaml` records the open question (from PLAN.md §1.6)
of whether the rule is meant to reach AI services at all; if organisers say it is, clearing
`LLM_API_KEY` drops the viewer to the deterministic fact-based caption with no other change.

The endpoint offers 80-odd models, several of which the rule excludes, so model ids are checked
against a vendor blocklist rather than trusted — pointing `LLM_MODEL` at one of those yields the
offline fallback and a logged warning, not a silent rule break.

## Compliance

- `manifest.yaml` lists every dataset with owner, country and licence.
  `scripts/check_manifest_domains.py` fails CI on any host not listed.
- The runtime guard now validates **every redirect hop**, not just the requested URL.
  This matters concretely: CDS load-balances Sesame across VizieR mirrors and one of
  them is `vizier.china-vo.org`. The allowlist names the mirrors we accept; a redirect
  anywhere else is refused and name resolution falls back to the offline catalogue.
- The classifier is trained from scratch on our own injections. No third-party weights.
- Every image and number in the UI carries a source label; everything simulated is
  tagged `Simulated` or `SAMPLE`.
