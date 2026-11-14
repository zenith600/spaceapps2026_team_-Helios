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

`visits` is the default, because inter-visit motion is what the challenge is about.

Band coverage is reported honestly: a point gets ~10–30 distinct bands per visit, not
102. The UI says **"N of 102 bands measured"** and never implies full coverage.

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

`<slug>` is `name-ra-dec-fov` (e.g. `wise-0855-133.79513-7.245147-0.100`), so a bundle
is addressable and cacheable.

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
   re-runs the SIA2 search (cached, 10 min TTL) and reports
   `{new_exposures, new_collections, latest_mjd, stale}`. The web app polls it and shows
   a **"N new exposures since this view was built — Rebuild"** banner.
3. **Scheduled re-bake.** `python -m deepfield.cli sky bake --refresh` rebuilds every
   pinned target that has gone stale. `.github/workflows/sky-refresh.yml` runs it on a
   cron and opens a PR when the demo bundle changes, so the shipped demo tracks new
   releases without anyone remembering to do it.

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
  resolver.py    names and coordinate strings -> (ra, dec); built-in catalogue first
  releases.py    IRSA ObsTAP collection discovery + cache + freshness comparison
  service.py     search_epochs, build_sky_bundle, spectrum_at, flag summaries
  render.py      array -> PNG (asinh/zscale), flag mask -> RGBA overlay
apps/api/deepfield_api/sky.py      /sky/* routes + the job runner
apps/web/app/sky/page.tsx          the viewer screen
apps/web/components/SkyPlayer.tsx  blink player (play/pause/speed/scrub/step)
apps/web/components/SkySpectrum.tsx on-the-fly spectrum panel
data/sky/<slug>/                   built bundles (gitignored)
apps/web/public/demo/sky/<slug>/   the five baked challenge targets (committed)
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

### `GET /sky/spectrum/{slug}?x=&y=&r=`

```jsonc
{"slug":"…","x":29,"y":31,"r":1,"ra_deg":…,"dec_deg":…,
 "n_bands":27,"bands_total":102,
 "points":[{"wave_um":1.21,"bandwidth_um":0.012,"flux_mjysr":…,
            "flux_err_mjysr":…,"mjd":…,"detector":3,"obs_id":"…"}],
 "source":"…"}
```

## 8. Honest limits shown in the UI

- 6.15″ pixels: crowded fields blend. Stated on the page.
- "N of 102 bands", never "102 bands".
- Flux is surface brightness in MJy/sr straight from the Level 2 product. No photometric
  calibration of our own, no absolute magnitudes.
- Frames are reprojected with bilinear interpolation onto a common grid; that smooths
  noise slightly and is not a substitute for proper drizzling.
- Nothing in this viewer is a detection claim. It is a display of public NASA data.
