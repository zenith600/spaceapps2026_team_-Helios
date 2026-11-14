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
| Test on Barnard's Star | **Real.** 42 frames, 16 visits, 403-day baseline, 39/102 bands. |
| Test on Epsilon Indi B | **Real.** 55 frames, 19 visits, 526-day baseline, 49/102 bands. |
| Test on WISE 0855 | **Real.** 44 frames, 11 visits, 374-day baseline, 41/102 bands. |
| Test on RW Aurigae | **Real.** 42 frames, 7 visits, 380-day baseline, 42/102 bands. |
| Test on R Draconis | **Real.** 93 frames, 31 visits, 426-day baseline, 82/102 bands. Its core saturates (0 of 93 exposures usable at the centre pixel, 75 at 8 px out), which the spectrum panel now explains instead of showing an empty chart. |

### Optional considerations from the brief

| Suggestion | State |
| --- | --- |
| Easy to update with new data releases | **Real.** Collections are discovered from IRSA ObsTAP, not hardcoded; a background refresher reports new exposures and new releases; a weekly workflow re-bakes the demo. See §Live refresh. |
| Creative use of the 102 bands | **Real.** Per-detector coadds, per-visit coadds, per-exposure wavelengths, honest "N of 102" everywhere, and false-colour composites mapping the bands to RGB (longest red, shortest blue). |
| Spectra on the fly | **Real.** Click a pixel; the spectrum is assembled at click time from the per-exposure cube, in the browser on a static deployment or in the API otherwise. A pixel with no usable data explains why (saturation, flags) and offers a jump to the nearest usable pixel. The shape is also fitted against three physical templates plus a blackbody colour temperature. |
| Add/subtract images from different times | **Real.** Stack-all and static-sky overlays, difference-from-first-visit frames, and an arbitrary visit-A-minus-visit-B comparison made on demand from calibrated flux. |
| Let users choose the field of view | **Real.** 0.02°–0.5°, in the URL, labelled in plain words. |
| Overlay other telescopes (Gaia, WISE) | **Real.** Gaia DR3 (ESA TAP), AllWISE and 2MASS (IRSA TAP), cone-searched and projected onto the viewer's pixel grid. ~130 sources per layer on Barnard's Star. |
| Coordinates in the URL for embedding | **Real.** `/sky?ra=&dec=&fov=&mode=`, every control included. |
| Display metadata like contamination flags | **Real.** Per-frame FLAGS fractions, a colour-coded RGBA overlay with a legend, and a per-pixel flag bitmask used to explain empty spectra. |
| Use Astropy / Aladin | **Real.** Astropy throughout the pipeline (WCS, reprojection, coordinates); Aladin Lite v3 embedded as an optional, lazily-loaded sky-context panel. |

### Beyond the brief

| Feature | State |
| --- | --- |
| Find what changed | **Real, calibrated on real data.** Removes each exposure's background, fits each pixel's brightness as a smooth curve in wavelength, and scores the residual against the field's own distribution. On the baked targets the two variable stars rank first in their fields (RW Aurigae z=43, R Draconis z=10). **Limit:** slow movers in crowded fields do not top the list — Barnard's Star moves ~1.8 px over the whole baseline and other sources in its dense field vary more. |
| Spectral classification | **Real.** Three physical templates (methane-rich / reflected sunlight / stellar) plus a blackbody colour temperature, with a χ² ranking and a 10% systematic floor. Refuses below three distinct colours rather than guessing. **Limit:** these are toy shapes — Barnard's Star, an M dwarf, comes out as "reflected sunlight". The UI says a shape match is a hint, not an identification. |
| "Odd one out" flag | **Real, field-relative.** Flagged when a point fits worse than 95% of 150 randomly sampled points in the same field, calibrated at bake time. On the baked data it fires on exactly the two variable stars, whose changing brightness scrambles their spectra across epochs, and on none of the three steady targets. |
| Machine-written field captions | **Real.** Coordinates outside the built-in catalogue get a plain-language caption written from measured facts by an LLM, with claim-rejection and a deterministic fallback. Always labelled. |
| Classifier in the browser | **Real.** The from-scratch CNN ships as ONNX and scores a candidate on the visitor's machine from the same normalised float stamps used in training. |

## Real, verified against live services

| Thing | Evidence |
| --- | --- |
| SPHEREx SIA2 search | 2026-11-14: WISE 0855 returns 282 DR1 exposures, 11 visits, MJD 60800.70–61174.29 (374 days). |
| SPHEREx cutouts | 274 cutouts fetched for the five baked targets. MEF decoded: IMAGE, FLAGS, VARIANCE, ZODI, EPSF, WCS-WAVE. |
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
| The LLM endpoint is slow | `openai/gpt-oss-20b` on NVIDIA's endpoint took 62–220 s for a two-token reply when measured on 2026-11-14. Captions are therefore written once at bake time and cached by fact sheet; nothing in the request path ever waits on it. |
| CDS Sesame / Aladin may be unreachable | CDS has been intermittently down all week. Name resolution falls back to the built-in catalogue; the Aladin panel loads only on request and says so if it fails. Neither blocks the viewer. |
| Two-visit patches cannot be localised | **Diagnosed and now enforced, not a bug.** Two time samples cannot separate parallax (curved in time) from proper motion (linear): a wrong (distance, rate) pair reproduces the same inter-visit shift and peaks elsewhere, often harder than the truth. Measured: the search put its peak 73 px from an amp-8 source it had ample signal to find. Three visits recover the position; four recover the distance to 0.4%. `run_patch` now searches distance only at two visits and says so in the summary. See §Cross-visit search. |
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
python -m pytest tests -q          188 pass, 0 fail
                                   5 network tests skip when CDS/IRSA are unreachable
cd apps/web && npm test            186 pass
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
