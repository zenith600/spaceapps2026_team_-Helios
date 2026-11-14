# Sky Viewer — design and data flow

The Sky Viewer is Deep Field's answer to the literal challenge objective:

> Users will enter the coordinates of a patch of sky (Right Ascension and declination).
> Your tool will display a series of images of that patch like a little video, making it
> easy to spot moving objects.

It is the front door of the app. The Planet X search (shift-and-stack, injections,
crowd voting) sits behind it as the second act: *this is what the viewer makes possible*.

Written 2026-11-14. Every service fact below was checked against the live endpoint on
that date, not assumed.

## 1. What a user does

```
/sky?ra=133.79513&dec=-7.245147&fov=0.1&mode=visits
/sky?target=wise-0855
/sky?q=Barnard%27s+Star
```

1. Type a name (`Barnard's Star`) or coordinates (`08 55 10.831 -07 14 42.53`,
   `08h55m10.8s -07d14m42.5s`, or `133.795 -7.245`).
2. Pick a field of view (0.05° – 0.5°).
3. The viewer lists the SPHEREx epochs that cover that point, then plays them as a
   blink movie: play/pause, speed, scrub, step.
4. Toggles: per-detector coadd, visit coadd, stack-all, difference-from-reference,
   contamination-flag overlay.
5. Click any pixel → an on-the-fly spectrum built from the per-exposure wavelengths.

Every state above is in the URL, so any view can be linked or embedded.

## 2. Why the modes exist (the 102-band problem)

SPHEREx is a spectral imager with a linear variable filter: **each pixel sees one
wavelength, set by where it falls on the detector**. A single exposure is therefore not
a 102-band datacube of your target — it is one narrow band, and *which* band depends on
the detector (D1–D6) and the position on it.

That has a direct consequence for a blink movie: if you order raw exposures by time and
play them, consecutive frames jump between wavelengths, and an astrophysical colour
change looks exactly like motion. So the viewer offers three framings, and always labels
the wavelength of what you are looking at:

| Mode | A frame is… | Good for |
| --- | --- | --- |
| `epochs` | one exposure | seeing the raw cadence, flags, per-exposure wavelength |
| `detectors` | all exposures of one detector in one visit, coadded | depth: ~√N noise gain at a near-constant wavelength (the brief's own suggestion) |
| `visits` | all exposures of one visit, coadded | **motion**: one clean frame per visit, visits are ~6 months apart |

| `colour` | a visit's exposures split into three wavelength groups → RGB | **composition**: longest wavelengths red, shortest blue, so a cold dusty source looks different from a hot star without reading a chart |

`visits` is the default, because inter-visit motion is what the challenge is about.

Band coverage is reported honestly: a point gets ~10–30 distinct bands per visit, not
102. The UI says **"N of 102 bands measured"** and never implies full coverage.

### Why each visit gets at least three exposures

Dividing a flat frame budget by the number of visits starves the targets SPHEREx
revisits most. R Draconis sits near the north ecliptic pole: 578 exposures across 31
visits. A budget of 48 gave each visit exactly one exposure — and one exposure is one
detector, which is one wavelength, chosen arbitrarily by whichever frame happened to be
picked. Blinking that movie shows the brightness jumping between *bands*, which on a
Mira variable is precisely the instrumental artefact a user would read as the
astrophysics.

So `select_exposures` guarantees `SKY_MIN_PER_VISIT` (3) exposures per visit wherever
they exist and lets the total grow to `SKY_HARD_FRAME_CAP` (120) rather than letting the
per-visit share collapse. The cost is more download on heavily-revisited fields; the
benefit is that every visit coadd averages several bands, so visit-to-visit changes are
comparable.

## 3. Data flow

```
name or coords
      │  resolver.py   (built-in catalogue → coordinate parser → CDS Sesame)
      ▼
 (ra, dec, fov)
      │  releases.py   (IRSA ObsTAP: which spherex_* collections exist today)
      ▼
 SIA2 search per collection                 irsa.ipac.caltech.edu/SIA
      │  → exposure list: obs_id, access_url, t_min/t_max, detector, em_min/em_max
      │  service.py groups into visits (gap > 2 d = new visit)
      ▼
 cutout fetch, concurrent, disk-cached      <access_url>?center=ra,dec&size=deg
      │  → MEF: IMAGE | FLAGS | VARIANCE | ZODI | EPSF | WCS-WAVE
      ▼
 reproject every cutout onto one tangent grid centred on (ra, dec)
      │  (stack/reproject.py, already used by the Planet X search)
      ▼
 frames + coadds + stack + difference + flag masks  →  PNG
 pixel cube + per-frame wavelength            →  cube.npz  (spectra on demand)
 everything described in                      →  sky.json
```

Output lives in `data/sky/<slug>/`, and the five challenge targets are also exported
into `apps/web/public/demo/sky/<slug>/` so they load instantly with no API and no
network.

### The slug is positional, not named

`<slug>` is `ra{ra:.4f}-dec{dec:+.4f}-fov{fov:.3f}`, e.g.
`ra133.7951-dec-7.2451-fov0.100`. Deliberately **not** the target name.

The first implementation put the resolved name in the slug, and the live check caught
what that costs: searching "WISE 0855" and typing its coordinates produced two different
slugs for the same patch of sky, so `/sky/epochs` reported `already_built: false` for a
view that had just been built, and a second identical build would have downloaded 190 MB
again. The name is metadata; the position and field of view are the identity.

Four decimal places is 0.36 arcsec — well inside one 6.15 arcsec pixel — so two queries
that round to the same slug really are the same patch.

`apps/web/lib/sky.ts` computes the same slug in TypeScript, and both sides pin the exact
strings in tests, because a drift there would silently split DEMO mode and API mode into
addressing different bundles.

## 4. Live refresh — "new SPHEREx data is arriving fast"

Three mechanisms, smallest to largest:

1. **Release discovery.** `releases.py` asks IRSA ObsTAP
   `SELECT DISTINCT obs_collection FROM ivoa.obscore WHERE obs_collection LIKE 'spherex%'`
   and caches the answer for 6 h. When IRSA publishes `spherex_dr2`, the viewer starts
   searching it with **no code change and no redeploy** — it appears in the collection
   list, and every freshness check picks it up. Non-image collections (`_cal`, `_cube`)
   are listed but not searched.
2. **Per-bundle freshness.** Every `sky.json` records, per collection, the exposure
   count and the latest `t_max` seen when it was built. `GET /sky/bundle/{slug}/freshness`
   diffs that against what IRSA has now and reports
   `{new_exposures, new_collections, latest_mjd, stale}`. The web app polls it every
   60 s and shows a **"N new exposures since this view was built — Rebuild"** banner.

   Answers come from a **background sweep**, not from the poll. Each check is a SIA2
   query per collection; measured against the real WISE 0855 bundle an uncached check
   takes 4.8 s and a cached one 0.002 s. With one upstream query per poll per viewer,
   this feature would be an abuse of someone else's archive. The sweep runs every
   `SKY_REFRESH_MINUTES` (default 30), caches per slug, and `?force=1` or
   `POST /sky/refresh` bypasses it deliberately. `SKY_AUTO_REBUILD=1` additionally
   rebuilds a stale view by itself — off by default, because spending bandwidth and
   disk unasked should be a deliberate act.
3. **Scheduled re-bake.** `python -m deepfield.cli sky bake --refresh` rebuilds every
   pinned target that has gone stale. `.github/workflows/sky-refresh.yml` runs it on a
   cron and opens a PR when the demo bundle changes, so the shipped demo tracks new
   releases without anyone remembering to do it. A human still approves the merge.

Nothing is hardcoded to DR1. The collection list is data, not code.

## 5. Cost, and why the demo is pre-baked

One cutout is ~4.3 MB and takes ~12 s from IRSA (3.9 MB of that is the EPSF table we
mostly discard). A 40-frame view is therefore ~170 MB and, fetched serially, ~8 minutes.

So:

- Fetches run concurrently (`SKY_FETCH_WORKERS`, default 6) and stream progress.
- Every cutout is cached on disk by `(obs_id, detector, ra, dec, size)`; a second view of
  the same patch is instant.
- A live request is a **job**: `POST /sky/jobs` returns immediately, `GET /sky/jobs/{id}`
  reports `{state, n_done, n_total, message}`, and the UI shows a progress bar.
- The five challenge targets are baked into the repo, so the demo never waits and never
  depends on IRSA being up during judging.

## 6. Files

```
pipeline/deepfield/sky/
  resolver.py     names and coordinate strings -> (ra, dec); built-in catalogue first
  releases.py     IRSA ObsTAP collection discovery + cache + freshness comparison
  service.py      search_epochs, build_sky_bundle, spectrum_at, flag summaries
  render.py       array -> PNG (one shared asinh stretch), flag mask -> RGBA overlay
  bake.py         pre-build + export the challenge targets, uint16 cube re-encoding
apps/api/deepfield_api/sky.py        /sky/* routes, job runner, background refresher
apps/web/app/sky/page.tsx            the viewer screen (all state in the URL)
apps/web/components/SkyPlayer.tsx    blink player (play/pause/speed/scrub/step/keys)
apps/web/components/SkySpectrum.tsx  on-the-fly spectrum panel
apps/web/lib/sky.ts                  both backends + the TS ports of parser/slug/decoder
scripts/make_spectrum_fixture.py     Python reference for the cross-language test
.github/workflows/sky-refresh.yml    weekly re-bake -> pull request
data/sky/<slug>/                     built bundles (gitignored)
apps/web/public/demo/sky/<slug>/     the five baked challenge targets (committed)
```

## 7. Contracts

### `sky.json`

```jsonc
{
  "slug": "wise-0855-133.79513-7.245147-0.100",
  "schema_version": 1,
  "target": {"query": "WISE 0855", "name": "WISE 0855-0714", "ra_deg": 133.79513,
             "dec_deg": -7.245147, "resolver": "builtin", "note": "…"},
  "fov_deg": 0.1, "npix": 59, "pixel_arcsec": 6.15,
  "wcs": {"crval": [...], "crpix": [...], "cdelt": [...], "ctype": [...]},
  "collections": ["spherex_dr1"],
  "generated_at": "2026-11-14T…Z",
  "source": "NASA SPHEREx DR1 Level 2 spectral images via IRSA (irsa.ipac.caltech.edu)",
  "coverage": {"n_exposures": 282, "n_used": 48, "mjd_min": …, "mjd_max": …,
               "n_visits": 4, "n_bands": 27, "bands_total": 102,
               "detectors": [1,2,3,4,5,6]},
  "freshness": {"built_from": {"spherex_dr1": {"n": 282, "latest_mjd": 61174.29}}},
  "frames": {
    "epochs":    [{"id":"…","png":"frames/e000.png","mjd":…,"detector":3,
                   "wave_um":1.21,"bandwidth_um":0.012,"visit":0,
                   "flags":{"SOURCE":0.11,"HOT":0.0,…},"flag_png":"flags/e000.png",
                   "good_fraction":0.98,"obs_id":"2025W19_1B_0116_1"}],
    "detectors": [{"id":"v0d3","png":"…","visit":0,"detector":3,"n":7,
                   "wave_um":1.21,"mjd":…}],
    "visits":    [{"id":"v0","png":"…","visit":0,"n":14,"mjd":…,"label":"2025W19",
                   "waves":[…]}]
  },
  "stack": {"png":"stack.png","n":48},
  "static": {"png":"static.png","method":"per-visit median"},
  "difference": [{"id":"d1","png":"diff/d1.png","visit":1,"reference":0,"mjd":…}],
  "scale": {"mode":"asinh","vmin":…,"vmax":…,"unit":"MJy/sr"},
  "cube": "cube.npz"
}
```

`cube.npz` holds `flux [n_exposures, npix, npix] float32`, `var`, `good`, plus
`mjd/wave_um/bandwidth_um/detector` vectors — that is what makes the spectrum
on-the-fly rather than precomputed.

### `cube.u16` — spectra with no server

`cube.npz` is float32 NumPy inside a zip, neither of which a browser reads without a
library. The exported demo bundles therefore carry a flat little-endian uint16 buffer
the browser maps straight onto a `Uint16Array`, with one `(offset, scale)` pair per
plane and frame in `sky.json`:

```
value = offset + code * scale          code 65535 = no data
```

Two details are load-bearing, and both were found by testing the browser decoder against
the Python one on a real bundle rather than by reasoning about it:

- **The `good` mask is folded into the no-data code.** The browser has no other copy of
  it, so without this it averaged flagged pixels that `spectrum_at` excludes in Python,
  and the same click gave different answers on a static deployment than through the API.
- **The range is taken over good pixels only.** Reprojection fills unusable variance
  with `1e6`; letting that into the range made the variance quantisation step ~15
  MJy²/sr² and destroyed the error bars on every real pixel.

Quantisation error is then 1/65534 of each frame's own range — far below the per-pixel
noise — at half the size of float32 (~600 KB per target, loaded lazily on first click).
`apps/web/lib/sky.cube.test.ts` holds the two implementations to each other, with a
tolerance read from the codec rather than guessed.

### `GET /sky/spectrum/{slug}?x=&y=&r=`

```jsonc
{"slug":"…","x":29,"y":31,"r":1,"ra_deg":…,"dec_deg":…,
 "n_bands":27,"bands_total":102,
 "points":[{"wave_um":1.21,"bandwidth_um":0.012,"flux_mjysr":…,
            "flux_err_mjysr":…,"mjd":…,"detector":3,"obs_id":"…"}],
 "source":"…"}
```

## 8. When a pixel has no spectrum

Bright sources saturate. SPHEREx's Level 2 pipeline zeroes and flags the saturated core, so
clicking the obvious bright blob on R Draconis finds **0 of 93 exposures usable** — 26 at 5
pixels out, 75 at 8. That is a real instrumental limit, but an empty chart with no explanation
reads as a broken feature, so the spectrum response carries a `quality` block:

```jsonc
{"n_usable": 0, "n_exposures": 93, "flags": ["source", "bad_pixel"], "saturated": true,
 "reason": "No exposure has usable data at this pixel. This source is bright enough to saturate…",
 "nearest_usable": {"x": 33, "y": 29, "dx": 4, "dy": 0, "n_usable": 48, "distance_arcsec": 24.6}}
```

The panel shows the reason and a button that jumps to the nearest usable pixel. The flag names
come from a per-pixel bitmask (`pixel_quality.flag_class` in `sky.json`, unioned over exposures)
over the same four classes as the contamination overlay, so the explanation and the overlay agree.

Computed identically in Python and TypeScript, and held together by the cross-language test.

## 9. Analysis layered on a view

All of it reads data the bundle already carries, so every feature also works in the browser
on a static deployment; the API versions exist for live views and to keep Python and
TypeScript honest against each other through generated fixtures.

| Feature | Module | Method | Trained? |
| --- | --- | --- | --- |
| False colour | `service.build_colour` | thirds of the wavelength-sorted exposures → R/G/B, one stretch per channel | no |
| Known-source overlay | `sky/catalogs.py` | TAP cone search (Gaia DR3 @ ESA, AllWISE + 2MASS @ IRSA), projected onto the bundle WCS, cached 30 days | no |
| Find what changed | `sky/analyse.change_map` | per-pixel χ²/dof against one constant brightness, noise-weighted; peaks by local maximum | no |
| What kind of thing | `sky/analyse.classify_point` | weighted LSQ of three closed-form templates + blackbody colour temperature | no |
| Odd one out | same | best-template χ²/dof > 5 — reported as a gap in our library, never as a discovery | no |
| Any two dates | `GET /sky/difference`, `differenceImage()` | coadd visit A and visit B from calibrated flux, subtract, symmetric stretch | no |
| Field caption | `ai/explain.py` | LLM over a numeric fact sheet, claim filter, deterministic fallback | third-party text service |
| Real/bogus score | `ml/model.py` → ONNX → `lib/onnxScore.ts` | small CNN over 3×32×32 normalised stamps | **ours, from scratch** |

## 10. Honest limits shown in the UI

- 6.15″ pixels: crowded fields blend. Stated on the page.
- "N of 102 bands", never "102 bands".
- Flux is surface brightness in MJy/sr straight from the Level 2 product. No photometric
  calibration of our own, no absolute magnitudes.
- Frames are reprojected with bilinear interpolation onto a common grid; that smooths
  noise slightly and is not a substitute for proper drizzling.
- Nothing in this viewer is a detection claim. It is a display of public NASA data.
