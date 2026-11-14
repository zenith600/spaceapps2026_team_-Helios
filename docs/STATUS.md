# Status — what works, what is faked, what is blocked

Last updated 2026-11-14, after the Sky Viewer branch (`feat/sky-viewer`).

This page exists so nobody has to guess. If something below is marked **real**, it was
run against the live service and the numbers quoted are from that run.

## The challenge objective

> Create a public-facing web tool to display images of the sky from the SPHEREx mission,
> making it easy for anyone to quickly see how they change over time. Users will enter
> the coordinates of a patch of sky… Your tool will display a series of images of that
> patch like a little video.

| Requirement | State |
| --- | --- |
| Enter RA/Dec | **Real.** `/sky` takes decimal degrees, sexagesimal in four spellings, or a name. |
| Series of images as a video | **Real.** Blink player: play/pause, 0.8–10 fps, scrub, step, keyboard. |
| Test on Barnard's Star | **Real.** 40 frames, 16 visits, 403-day baseline, 37/102 bands. |
| Test on Epsilon Indi B | **Real.** 37 frames, 19 visits, 526-day baseline, 33/102 bands. |
| Test on WISE 0855 | **Real.** 44 frames, 11 visits, 374-day baseline, 41/102 bands. |
| Test on RW Aurigae | **Real.** 42 frames, 7 visits, 380-day baseline, 42/102 bands. |
| Test on R Draconis | **Real.** 31 frames, 31 visits, 416-day baseline, 23/102 bands. |

### Optional considerations from the brief

| Suggestion | State |
| --- | --- |
| Easy to update with new data releases | **Real.** Collections are discovered from IRSA ObsTAP, not hardcoded; a background refresher reports new exposures and new releases; a weekly workflow re-bakes the demo. See §Live refresh. |
| Creative use of the 102 bands | **Partly real.** Per-detector coadds, per-visit coadds, per-exposure wavelengths, honest "N of 102" everywhere. Not done: a colour composite across detectors. |
| Spectra on the fly | **Real.** Click a pixel; the spectrum is assembled at click time from the per-exposure cube, in the browser on a static deployment or in the API otherwise. |
| Add/subtract images from different times | **Partly real.** Stack-all and static-sky overlays, and difference-from-first-visit frames. Not done: user-chosen arbitrary A−B pairs. |
| Let users choose the field of view | **Real.** 0.02°–0.5°, in the URL. |
| Overlay other telescopes (Gaia, WISE) | **Not done.** |
| Coordinates in the URL for embedding | **Real.** `/sky?ra=&dec=&fov=&mode=`, every control included. |
| Display metadata like contamination flags | **Real.** Per-frame FLAGS fractions and a colour-coded RGBA overlay with a legend. |
| Use Astropy / Aladin | **Partly.** Astropy throughout the pipeline (WCS, reprojection, coordinates). Aladin Lite not integrated. |

## Real, verified against live services

| Thing | Evidence |
| --- | --- |
| SPHEREx SIA2 search | 2026-11-14: WISE 0855 returns 282 DR1 exposures, 11 visits, MJD 60800.70–61174.29 (374 days). |
| SPHEREx cutouts | 194 cutouts fetched for the five baked targets. MEF decoded: IMAGE, FLAGS, VARIANCE, ZODI, EPSF, WCS-WAVE. |
| Release discovery | IRSA ObsTAP returns `spherex_dr1, spherex_dr1_cal, spherex_dr1_cube, spherex_dr1_deep, spherex_qr3, spherex_qr3_deep`. The viewer searches the two image releases. |
| Freshness checks | Uncached 4.8 s against IRSA, cached 0.002 s. Correctly reports 282 now vs 282 at build time → not stale. |
| On-the-fly spectra | WISE 0855 centre pixel: 9 points over 7 distinct bands, 0.749–2.365 µm, each from a different exposure, visit and detector. |
| Browser spectrum decoder | Matches the Python reference on the real bundle to within one quantisation step, with identical good-pixel counts (`lib/sky.cube.test.ts`). |
| Planet X shift-and-stack | Patch P001: 39 exposures, 201 trials, max stacked SNR 33.3, 18 known bodies matched from JPL SBIdent. |
| JPL Horizons | SPHEREx (−163182) heliocentric vectors, cached. |
| Caltech reference population | 100,000 orbits, md5 verified. |

## Faked, simulated, or placeholder — and labelled as such in the UI

| Thing | Note |
| --- | --- |
| The Hunt / Candidate Lab / Classify / Proof screens | Still serve the synthetic **SAMPLE** bundle (`kind: "SAMPLE"`, candidates C0001–C0012). Every number there is invented and tagged `SAMPLE` / `Simulated`. The Sky Viewer is the only screen on real data. |
| Exclusion counter | Computed from the real Caltech population for the prior term, but the Deep Field term is driven by the SAMPLE patches. |
| Candidate dossiers | `generator: "offline-template"`. No `ANTHROPIC_API_KEY` on this machine, so the Claude agent team has never run. |
| Injection completeness | Real run, but P001 recovered 0/32 injections. The honest answer, and the Proof page curve is therefore flat. |

## Blocked or not started

| Thing | Why |
| --- | --- |
| `test_stack_two_visits` fails | The cross-visit parallax template puts the peak at (12, 99) instead of (85, 77). Pre-existing, predates the Sky Viewer work, untouched by it. Either fix the trial geometry or cut the feature. |
| Nothing is deployed | No Vercel, Fly.io or Supabase credentials on this machine. `vercel.json`, `fly.toml`, Dockerfiles and the Supabase migration are all committed and ready; the deploy itself is a human action. |
| CDS Sesame resolution | The CDS load balancer currently sends every request to `vizier.idia.ac.za`, which is timing out. Name resolution therefore falls back to the built-in catalogue, which covers the five test targets and a few more. Not a blocker for the demo; typed coordinates always work. |
| ONNX in the browser | Model exported and validated in Python; not loaded client-side. |
| Gaia / WISE overlays, Aladin | Not started. |
| Colour composites across detectors | Not started. |

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

## Tests

```
python -m pytest tests -q          101 pass, 1 fail (test_stack_two_visits, pre-existing)
                                   5 network tests skip when CDS/IRSA are unreachable
cd apps/web && npm test            57 pass
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
