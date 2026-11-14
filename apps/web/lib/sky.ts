// Sky Viewer data layer. Two backends, same shapes:
//  - DEMO_MODE: static files under /demo/sky. Names resolve against a baked catalogue,
//    coordinates are parsed here, and spectra are computed in the browser from a
//    uint16 pixel cube. No server at all.
//  - API mode: the FastAPI /sky/* routes, which can also build a view of ANY coordinate
//    live from IRSA.
import { API_URL, DEMO } from "./api";
import { classifyPoints } from "./spectralFit";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type SkyTarget = {
  query: string; name: string; ra_deg: number; dec_deg: number;
  resolver: "builtin" | "coords" | "sesame"; note: string; slug: string;
  look_for?: string; kind?: string;
};

export type FlagSummary = Record<string, number>;

export type EpochFrame = {
  id: string; png: string; flag_png?: string; obs_id: string; detector: number; mjd: number;
  wave_um: number; bandwidth_um: number; visit: number; collection: string;
  good_fraction: number; psf_fwhm_arcsec: number; flags: FlagSummary;
};
export type DetectorFrame = {
  id: string; png: string; visit: number; detector: number; n: number; mjd: number;
  wave_um: number; wave_min_um: number; wave_max_um: number; flags: FlagSummary;
};
export type VisitFrame = {
  id: string; png: string; visit: number; n: number; mjd: number; mjd_start: number; mjd_end: number;
  label: string; detectors: number[]; n_bands: number; flags: FlagSummary;
};
export type DiffFrame = { id: string; png: string; visit: number; reference_visit: number; mjd: number; label: string };

export type CubeU16 = {
  file: string; shape: [number, number, number, number]; planes: string[]; nodata_code: number;
  codec: { plane: string; i: number; offset: number; scale: number }[];
  mjd: number[]; wave_um: number[]; bandwidth_um: number[]; detector: number[]; visit: number[]; obs_id: string[];
};

export type SkyBundle = {
  schema_version: number; slug: string; generated_at: string; source: string;
  target: SkyTarget; ra_deg: number; dec_deg: number; fov_deg: number; npix: number; pixel_arcsec: number;
  coverage: {
    n_exposures_available: number; n_requested: number; n_used: number; n_skipped: number;
    mjd_min: number; mjd_max: number; baseline_days: number; n_visits: number;
    n_bands: number; bands_total: number; wave_min_um: number; wave_max_um: number; detectors: number[];
  };
  search: { collections_searched: string[]; collections_available: string[]; collection_source: string };
  visits: { visit: number; n_exposures: number; mjd_start: number; mjd_end: number; label: string }[];
  frames: { epochs: EpochFrame[]; detectors: DetectorFrame[]; visits: VisitFrame[]; colour?: ColourFrame[] };
  colour?: ColourMeta;
  difference: DiffFrame[];
  stack: { png: string; n: number; note: string };
  static: { png: string; method: string; note: string };
  scale: { mode: string; vmin: number; vmax: number; unit: string; note: string };
  flag_legend: { id: string; colour: string; flags: string[] }[];
  pixel_quality?: { flag_class: number[]; classes: string[]; note: string };
  limits: string[];
  cube_u16?: CubeU16;
  file_base?: string;
};

export type SkyIndexEntry = {
  slug: string; query: string; name: string; note: string; look_for?: string; kind?: string;
  ra_deg: number; dec_deg: number; fov_deg: number;
  n_frames: number; n_visits: number; n_bands: number; bands_total: number; baseline_days: number;
  mjd_min: number; mjd_max: number; generated_at: string;
};

export type Epochs = {
  ra_deg: number; dec_deg: number; fov_deg: number; npix?: number; slug?: string;
  n_exposures: number; n_visits?: number; mjd_min?: number; mjd_max?: number; baseline_days?: number;
  detectors?: number[];
  visits: { visit: number; n_exposures: number; mjd_start: number; mjd_end: number; span_days: number; label: string; detectors: number[] }[];
  search: { collections_searched: string[]; collections_available: string[]; collection_source: string };
  estimate: { n_frames: number; download_mb: number; seconds: number } | null;
  already_built?: boolean; message?: string;
};

export type Job = {
  job_id: string | null; state: "queued" | "running" | "done" | "error"; slug: string;
  n_done: number; n_total: number; message: string; error: string | null; progress: number;
  bundle_url: string | null;
};

export type Freshness = {
  new_exposures: number; new_collections: string[]; latest_mjd: number | null; stale: boolean;
  checked_at: string; built_at: string; slug: string;
  per_collection: Record<string, { n_now: number; n_built: number; new: number; latest_mjd: number | null }>;
};

export type SpectrumPoint = {
  wave_um: number; bandwidth_um: number; flux_mjysr: number; flux_err_mjysr: number;
  mjd: number; detector: number; visit: number; obs_id: string; n_pixels: number;
};
export type PixelQuality = {
  n_usable: number; n_exposures: number; flags: string[]; saturated: boolean;
  reason: string | null;
  nearest_usable: { x: number; y: number; dx: number; dy: number; n_usable: number; distance_arcsec: number } | null;
};

export type Spectrum = {
  slug: string; x: number; y: number; r: number; ra_deg: number; dec_deg: number;
  n_points: number; n_exposures: number; n_excluded: number;
  n_bands: number; bands_total: number; points: SpectrumPoint[];
  unit: string; source: string; note: string; quality: PixelQuality;
};

export type ColourFrame = {
  id: string; png: string; visit: number; n: number; mjd: number; label: string; bands: number[][];
};
export type ColourMeta = {
  available: boolean; reason?: string; png?: string; note?: string;
  channels?: { colour: string; role: string; range_um: string }[];
};

export type ChangeReport = {
  slug: string; threshold: number; median_chi2_per_dof: number | null;
  n_significant_pixels: number;
  peaks: { x: number; y: number; chi2_per_dof: number; n_used: number }[];
  method: string; caveat: string;
};

export type Classification = {
  available: boolean; reason?: string; best?: string; label?: string; meaning?: string;
  confident?: boolean; methane_score?: number | null; n_bands?: number;
  ranking?: { template: string; label: string; chi2_per_dof: number }[];
  temperature?: { temperature_k: number | null; chi2_per_dof: number | null };
  method?: string; caveat?: string;
};

export type OverlayLayer = {
  id: string; name: string; owner: string; colour: string; note: string; n: number;
  band: string | null; sources: { x: number; y: number; mag: number | null }[];
};
export type Overlay = { layers: OverlayLayer[]; radius_deg: number; note: string };

export type Explanation = {
  text: string; generator: string; generated_at: string;
  is_machine_written: boolean; disclaimer: string;
};

export const FOV_MIN = 0.02;
export const FOV_MAX = 0.5;
export const DEFAULT_FOV = 0.1;
export const BANDS_TOTAL = 102;

// ---------------------------------------------------------------------------
// Identity. Must match SkyRequest.slug in pipeline/deepfield/sky/service.py.
// ---------------------------------------------------------------------------
export function skySlug(ra: number, dec: number, fov: number): string {
  const d = dec >= 0 ? `+${dec.toFixed(4)}` : dec.toFixed(4);
  return `ra${ra.toFixed(4)}-dec${d}-fov${fov.toFixed(3)}`;
}

export function skyFileUrl(slug: string, rel: string): string {
  if (!rel) return "";
  return DEMO ? `/demo/sky/${slug}/${rel}` : `${API_URL}/sky/files/${slug}/${rel}`;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) {
    let detail = `${r.status}`;
    try { detail = (await r.json()).detail || detail; } catch { /* keep status */ }
    throw new Error(detail);
  }
  return (await r.json()) as T;
}

// ---------------------------------------------------------------------------
// Resolving. Mirrors pipeline/deepfield/sky/resolver.py so DEMO mode needs no API.
// ---------------------------------------------------------------------------
type CatalogueEntry = {
  slug: string; name: string; ra_deg: number; dec_deg: number;
  note: string; look_for?: string; kind?: string; featured: boolean;
};
let catalogueCache: CatalogueEntry[] | null = null;

export async function getCatalogue(): Promise<CatalogueEntry[]> {
  if (catalogueCache) return catalogueCache;
  try {
    const j = await getJson<{ targets: CatalogueEntry[] }>("/demo/sky/catalogue.json");
    catalogueCache = j.targets;
  } catch {
    catalogueCache = [];
  }
  return catalogueCache;
}

const normalise = (s: string) => s.toLowerCase().replace(/'/g, "").replace(/-/g, " ").replace(/\s+/g, " ").trim();

/** Decimal degrees, or sexagesimal with RA in hours. Returns null if it is not a coordinate. */
export function parseCoords(text: string): { ra: number; dec: number } | null {
  const s = text.trim();
  if (!s) return null;

  const dec = s.match(/^\s*([-+]?\d+(?:\.\d+)?)\s*[,\s]\s*([-+]?\d+(?:\.\d+)?)\s*$/);
  if (dec) {
    const ra = parseFloat(dec[1]), d = parseFloat(dec[2]);
    if (ra < 0 || ra > 360 || d < -90 || d > 90) throw new Error(`coordinates out of range: RA ${ra}, Dec ${d}`);
    return { ra, dec: d };
  }

  // 08 55 10.831 -07 14 42.53  /  08h55m10.831s -07d14m42.53s  /  08:55:10.831 -07:14:42.53
  // The Dec degrees token is kept as a string: "-00 30 00" is negative even though
  // parseFloat("-00") is 0, so the sign has to come from the text, not the number.
  const tokens = s.replace(/[hdms°'"]/gi, " ").replace(/[:,]/g, " ").trim().split(/\s+/);
  if (tokens.length !== 6 || tokens.some((t) => !/^[-+]?\d+(\.\d+)?$/.test(t))) return null;
  const [rh, rm, rs, ddTok, dm, ds] = tokens;
  const ra = 15 * (Math.abs(parseFloat(rh)) + parseFloat(rm) / 60 + parseFloat(rs) / 3600);
  const sign = ddTok.trim().startsWith("-") ? -1 : 1;
  const d = sign * (Math.abs(parseFloat(ddTok)) + parseFloat(dm) / 60 + parseFloat(ds) / 3600);
  if (ra < 0 || ra > 360 || d < -90 || d > 90) throw new Error(`coordinates out of range: RA ${ra}, Dec ${d}`);
  return { ra, dec: d };
}

export async function resolveTarget(query: string): Promise<SkyTarget> {
  const q = query.trim();
  if (!q) throw new Error("type a name or coordinates");

  const cat = await getCatalogue();
  const hit = cat.find((c) => normalise(c.name) === normalise(q) || normalise(c.slug) === normalise(q));
  if (hit) {
    return { query: q, name: hit.name, ra_deg: hit.ra_deg, dec_deg: hit.dec_deg, resolver: "builtin",
             note: hit.note, slug: hit.slug, look_for: hit.look_for, kind: hit.kind };
  }

  const coords = parseCoords(q);
  if (coords) {
    return { query: q, name: `RA ${coords.ra.toFixed(5)} Dec ${coords.dec >= 0 ? "+" : ""}${coords.dec.toFixed(5)}`,
      ra_deg: coords.ra, dec_deg: coords.dec, resolver: "coords", note: "", slug: "" };
  }

  if (!DEMO) return getJson<SkyTarget>(`${API_URL}/sky/resolve?q=${encodeURIComponent(q)}`);
  throw new Error(
    `Could not resolve "${q}" offline. Type coordinates like "08 55 10.831 -07 14 42.53" or "133.795 -7.245", ` +
    `or pick one of the built-in targets.`);
}

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------
export async function getSkyIndex(): Promise<{ targets: SkyIndexEntry[]; collections_at_bake_time: string[]; generated_at: string }> {
  try {
    return await getJson("/demo/sky/index.json");
  } catch {
    return { targets: [], collections_at_bake_time: [], generated_at: "" };
  }
}

export async function getSkyBundle(slug: string): Promise<SkyBundle> {
  return DEMO ? getJson<SkyBundle>(`/demo/sky/${slug}/sky.json`) : getJson<SkyBundle>(`${API_URL}/sky/bundle/${slug}`);
}

export async function getEpochs(ra: number, dec: number, fov: number): Promise<Epochs> {
  if (DEMO) throw new Error("coverage lookup needs the API");
  return getJson<Epochs>(`${API_URL}/sky/epochs?ra=${ra}&dec=${dec}&fov=${fov}`);
}

export async function startSkyJob(ra: number, dec: number, fov: number, opts: { label?: string; maxFrames?: number } = {}): Promise<Job> {
  const r = await fetch(`${API_URL}/sky/jobs`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ra_deg: ra, dec_deg: dec, fov_deg: fov, label: opts.label ?? "", max_frames: opts.maxFrames ?? 48 }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `job failed: ${r.status}`);
  return (await r.json()) as Job;
}

export async function getSkyJob(jobId: string): Promise<Job> {
  return getJson<Job>(`${API_URL}/sky/jobs/${jobId}`);
}

export async function getFreshness(slug: string): Promise<Freshness> {
  return getJson<Freshness>(`${API_URL}/sky/bundle/${slug}/freshness`);
}

// ---------------------------------------------------------------------------
// Spectra. With an API, ask it. Without one, decode the uint16 cube in the browser:
// this is what keeps "spectra on the fly" working on a static deployment.
// ---------------------------------------------------------------------------
const cubeCache = new Map<string, Promise<Uint16Array>>();

async function loadCube(slug: string, cube: CubeU16): Promise<Uint16Array> {
  let p = cubeCache.get(slug);
  if (!p) {
    p = fetch(skyFileUrl(slug, cube.file)).then(async (r) => {
      if (!r.ok) throw new Error(`cube: ${r.status}`);
      return new Uint16Array(await r.arrayBuffer());
    });
    cubeCache.set(slug, p);
  }
  return p;
}

/**
 * Decode a spectrum from the uint16 cube. Pure, so it can be tested against the
 * Python `spectrum_at` output on the same real bundle (lib/sky.cube.test.ts).
 */
export function decodeSpectrum(bundle: SkyBundle, data: Uint16Array, x: number, y: number, r = 1): Spectrum {
  const slug = bundle.slug;
  const cube = bundle.cube_u16;
  if (!cube) throw new Error("this view was exported without its pixel cube");
  const [, n, ny, nx] = cube.shape;
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || xi >= nx || yi < 0 || yi >= ny) throw new Error(`pixel (${xi}, ${yi}) is outside the ${nx}x${ny} field`);
  const rr = Math.max(0, Math.min(4, Math.round(r)));
  const plane = ny * nx;
  const codec = (which: string, i: number) => cube.codec.find((c) => c.plane === which && c.i === i)!;

  const points: SpectrumPoint[] = [];
  for (let i = 0; i < n; i++) {
    const cf = codec("flux", i), cv = codec("var", i);
    let sum = 0, vsum = 0, npx = 0;
    for (let dy = -rr; dy <= rr; dy++) {
      const yy = yi + dy;
      if (yy < 0 || yy >= ny) continue;
      for (let dx = -rr; dx <= rr; dx++) {
        const xx = xi + dx;
        if (xx < 0 || xx >= nx) continue;
        const off = yy * nx + xx;
        const fc = data[i * plane + off];
        const vc = data[(n + i) * plane + off];
        if (fc === cube.nodata_code || vc === cube.nodata_code) continue;
        sum += cf.offset + fc * cf.scale;
        vsum += cv.offset + vc * cv.scale;
        npx++;
      }
    }
    if (!npx) continue;
    points.push({
      wave_um: cube.wave_um[i], bandwidth_um: cube.bandwidth_um[i],
      flux_mjysr: sum / npx, flux_err_mjysr: Math.sqrt(Math.max(vsum, 0)) / npx,
      mjd: cube.mjd[i], detector: cube.detector[i], visit: cube.visit[i],
      obs_id: cube.obs_id[i], n_pixels: npx,
    });
  }
  points.sort((a, b) => a.wave_um - b.wave_um);

  // Pixel -> sky, on the same tangent plane the bundle was built on.
  const half = (bundle.npix - 1) / 2;
  const scale = bundle.pixel_arcsec / 3600;
  const dec = bundle.dec_deg + (yi - half) * scale;
  const ra = bundle.ra_deg - ((xi - half) * scale) / Math.cos((bundle.dec_deg * Math.PI) / 180);

  return {
    slug, x: xi, y: yi, r: rr, ra_deg: ra, dec_deg: dec,
    n_points: points.length,
    n_exposures: n,
    n_excluded: n - points.length,
    n_bands: new Set(points.map((p) => p.wave_um.toFixed(2))).size,
    bands_total: bundle.coverage.bands_total ?? BANDS_TOTAL,
    points, unit: "MJy/sr", source: bundle.source,
    quality: pixelQuality(bundle, data, xi, yi),
    note: "Each point is one SPHEREx exposure, at the wavelength that exposure's filter position gave this pixel. " +
      "Points at the same wavelength from different visits show variability, not spectral structure.",
  };
}

/** How many exposures are usable at one pixel (the same rule the spectrum applies). */
function usableAt(bundle: SkyBundle, data: Uint16Array, x: number, y: number): number {
  const cube = bundle.cube_u16!;
  const [, n, ny, nx] = cube.shape;
  if (x < 0 || x >= nx || y < 0 || y >= ny) return 0;
  const plane = ny * nx, off = y * nx + x;
  let c = 0;
  for (let i = 0; i < n; i++) {
    if (data[i * plane + off] !== cube.nodata_code && data[(n + i) * plane + off] !== cube.nodata_code) c++;
  }
  return c;
}

/**
 * Why does this pixel have few or no usable exposures, and where should the user click?
 * Mirrors `pixel_quality` in pipeline/deepfield/sky/service.py. A bright source saturates
 * the detector and SPHEREx flags its core; an unexplained empty panel reads as a broken
 * feature rather than the real instrumental limit it is.
 */
export function pixelQuality(bundle: SkyBundle, data: Uint16Array, x: number, y: number): PixelQuality {
  const cube = bundle.cube_u16!;
  const [, n, ny, nx] = cube.shape;
  const nUsed = usableAt(bundle, data, x, y);
  const pq = bundle.pixel_quality;
  const here = pq ? (pq.flag_class[y * bundle.npix + x] ?? 0) : 0;
  const flags = pq ? pq.classes.filter((_c, i) => here & (1 << i)) : [];

  const out: PixelQuality = { n_usable: nUsed, n_exposures: n, flags, saturated: false, reason: null, nearest_usable: null };
  const want = Math.max(1, Math.floor(n / 2));
  if (nUsed >= want) return out;

  const blocking = flags.includes("bad_pixel") || flags.includes("artifact");
  out.saturated = nUsed === 0 && blocking;
  out.reason = nUsed === 0
    ? "No exposure has usable data at this pixel. " +
      (blocking
        ? "This source is bright enough to saturate the detector: SPHEREx's pipeline zeroes and flags the " +
          "saturated core, so there is no photometry to show here. "
        : "Every exposure flags it, or it falls outside the overlap of the frames. ") +
      "Click a few pixels away from the centre for a real spectrum."
    : `Only ${nUsed} of ${n} exposures have usable data at this pixel; the rest are flagged. ` +
      "The spectrum below is built from those few.";

  outer:
  for (let radius = 1; radius < Math.min(nx, ny) / 2; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || xx >= nx || yy < 0 || yy >= ny) continue;
        const c = usableAt(bundle, data, xx, yy);
        if (c >= want) {
          out.nearest_usable = {
            x: xx, y: yy, dx, dy, n_usable: c,
            distance_arcsec: Math.round(Math.hypot(dx, dy) * bundle.pixel_arcsec * 10) / 10,
          };
          break outer;
        }
      }
    }
  }
  return out;
}

export async function getSpectrum(bundle: SkyBundle, x: number, y: number, r = 1): Promise<Spectrum> {
  if (!DEMO) {
    return getJson<Spectrum>(
      `${API_URL}/sky/spectrum/${bundle.slug}?x=${Math.round(x)}&y=${Math.round(y)}&r=${r}`);
  }
  if (!bundle.cube_u16) throw new Error("this view was exported without its pixel cube");
  return decodeSpectrum(bundle, await loadCube(bundle.slug, bundle.cube_u16), x, y, r);
}

// ---------------------------------------------------------------------------
// Analysis, overlays and captions
//
// In DEMO mode everything that can be computed from data already in the browser is,
// so a static deployment keeps every feature. Only the things that genuinely need a
// server -- an arbitrary visit difference rendered from calibrated flux, a live model
// call -- fall back to the API.
// ---------------------------------------------------------------------------

/** Where did anything move or vary? Mirrors `change_map` in sky/analyse.py. */
export function changeMap(bundle: SkyBundle, data: Uint16Array): ChangeReport {
  const cube = bundle.cube_u16!;
  const [, n, ny, nx] = cube.shape;
  const plane = ny * nx;
  const codec = (which: string, i: number) => cube.codec.find((c) => c.plane === which && c.i === i)!;
  const cf = Array.from({ length: n }, (_, i) => codec("flux", i));
  const cv = Array.from({ length: n }, (_, i) => codec("var", i));

  const chi = new Float32Array(plane).fill(NaN);
  const used = new Int16Array(plane);
  for (let p = 0; p < plane; p++) {
    let wsum = 0, wfsum = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      const fc = data[i * plane + p], vc = data[(n + i) * plane + p];
      if (fc === cube.nodata_code || vc === cube.nodata_code) continue;
      const v = cv[i].offset + vc * cv[i].scale;
      if (!(v > 0)) continue;
      const f = cf[i].offset + fc * cf[i].scale;
      wsum += 1 / v; wfsum += f / v; cnt++;
    }
    used[p] = cnt;
    if (cnt < 3 || wsum <= 0) continue;
    const mean = wfsum / wsum;
    let c2 = 0;
    for (let i = 0; i < n; i++) {
      const fc = data[i * plane + p], vc = data[(n + i) * plane + p];
      if (fc === cube.nodata_code || vc === cube.nodata_code) continue;
      const v = cv[i].offset + vc * cv[i].scale;
      if (!(v > 0)) continue;
      const d = cf[i].offset + fc * cf[i].scale - mean;
      c2 += (d * d) / v;
    }
    chi[p] = c2 / (cnt - 1);
  }

  const threshold = 3.0;
  const finite = Array.from(chi).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const peaks: ChangeReport["peaks"] = [];
  const sep = 3;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const v = chi[y * nx + x];
      if (!Number.isFinite(v) || v < threshold) continue;
      let isMax = true;
      for (let dy = -sep; dy <= sep && isMax; dy++) {
        for (let dx = -sep; dx <= sep; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || yy >= ny || xx < 0 || xx >= nx) continue;
          const u = chi[yy * nx + xx];
          if (Number.isFinite(u) && u > v) { isMax = false; break; }
        }
      }
      if (isMax) peaks.push({ x, y, chi2_per_dof: Math.round(v * 100) / 100, n_used: used[y * nx + x] });
    }
  }
  peaks.sort((a, b) => b.chi2_per_dof - a.chi2_per_dof);

  return {
    slug: bundle.slug, threshold,
    median_chi2_per_dof: finite.length ? Math.round(finite[Math.floor(finite.length / 2)] * 1000) / 1000 : null,
    n_significant_pixels: Array.from(chi).filter((v) => v > threshold).length,
    peaks: peaks.slice(0, 12),
    method: "Chi-squared of each pixel's brightness against a single constant value, weighted by the " +
      "measured noise. Untrained and transparent: it reports where the data disagree with “nothing happened here”.",
    caveat: "Flags change of any kind — real movement, variability, a cosmic ray, or the edge of a " +
      "saturated star. It is a place to look, not a discovery.",
  };
}

export async function getChangeMap(bundle: SkyBundle): Promise<ChangeReport> {
  if (!DEMO) return getJson<ChangeReport>(`${API_URL}/sky/change/${bundle.slug}`);
  if (!bundle.cube_u16) throw new Error("this view was exported without its pixel cube");
  return changeMap(bundle, await loadCube(bundle.slug, bundle.cube_u16));
}

export async function getClassification(bundle: SkyBundle, x: number, y: number, r = 1): Promise<Classification> {
  if (!DEMO) {
    return getJson<Classification>(
      `${API_URL}/sky/classify/${bundle.slug}?x=${Math.round(x)}&y=${Math.round(y)}&r=${r}`);
  }
  // In DEMO mode the browser already has the spectrum; the template fit runs here.
  const spec = await getSpectrum(bundle, x, y, r);
  return classifyPoints(spec.points);
}

export async function getOverlay(bundle: SkyBundle): Promise<Overlay> {
  return DEMO
    ? getJson<Overlay>(`/demo/sky/${bundle.slug}/overlay.json`)
    : getJson<Overlay>(`${API_URL}/sky/overlay/${bundle.slug}`);
}

export async function getExplanation(bundle: SkyBundle): Promise<Explanation> {
  return DEMO
    ? getJson<Explanation>(`/demo/sky/${bundle.slug}/explain.json`)
    : getJson<Explanation>(`${API_URL}/sky/explain/${bundle.slug}`);
}

/**
 * Difference between any two visits.
 *
 * Precomputing every pair would be N² images — 961 for R Draconis — so it is made on
 * demand. In the browser that means decoding the cube and painting a canvas, which keeps
 * true A−B comparison working on a static deployment; with an API the server renders it
 * from the same calibrated flux. Either way the subtraction is of real surface brightness,
 * never of the 8-bit display PNGs.
 */
export async function differenceImage(bundle: SkyBundle, a: number, b: number): Promise<string> {
  if (!DEMO) return `${API_URL}/sky/difference/${bundle.slug}?a=${a}&b=${b}`;
  const cube = bundle.cube_u16;
  if (!cube) throw new Error("this view was exported without its pixel cube");
  const data = await loadCube(bundle.slug, cube);
  const [, n, ny, nx] = cube.shape;
  const plane = ny * nx;
  const codec = (which: string, i: number) => cube.codec.find((c) => c.plane === which && c.i === i)!;

  const coadd = (visit: number) => {
    const out = new Float64Array(plane).fill(NaN);
    const num = new Float64Array(plane), den = new Float64Array(plane);
    for (let i = 0; i < n; i++) {
      if (cube.visit[i] !== visit) continue;
      const cf = codec("flux", i), cv = codec("var", i);
      for (let p = 0; p < plane; p++) {
        const fc = data[i * plane + p], vc = data[(n + i) * plane + p];
        if (fc === cube.nodata_code || vc === cube.nodata_code) continue;
        const v = cv.offset + vc * cv.scale;
        if (!(v > 0)) continue;
        num[p] += (cf.offset + fc * cf.scale) / v;
        den[p] += 1 / v;
      }
    }
    for (let p = 0; p < plane; p++) if (den[p] > 0) out[p] = num[p] / den[p];
    return out;
  };

  const A = coadd(a), B = coadd(b);
  const diff = new Float64Array(plane);
  const finite: number[] = [];
  for (let p = 0; p < plane; p++) {
    diff[p] = B[p] - A[p];
    if (Number.isFinite(diff[p])) finite.push(Math.abs(diff[p]));
  }
  finite.sort((x, y) => x - y);
  const lim = finite.length ? finite[Math.floor(finite.length * 0.98)] || 1 : 1;

  const canvas = document.createElement("canvas");
  canvas.width = nx; canvas.height = ny;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(nx, ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const v = diff[y * nx + x];
      // PNG rows run top-down, the array bottom-up.
      const o = ((ny - 1 - y) * nx + x) * 4;
      const g = Number.isFinite(v) ? Math.round(255 * Math.min(1, Math.max(0, (v / lim + 1) / 2))) : 0;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = g;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

// ---------------------------------------------------------------------------
// Small helpers shared by the viewer
// ---------------------------------------------------------------------------
export function mjdToDate(mjd: number): Date {
  return new Date((mjd - 40587) * 86400000);   // MJD 40587 is 1970-01-01
}

export function mjdLabel(mjd: number): string {
  return mjdToDate(mjd).toISOString().slice(0, 10);
}

export function formatRa(ra: number): string {
  const h = ra / 15, hh = Math.floor(h), m = (h - hh) * 60, mm = Math.floor(m), ss = (m - mm) * 60;
  return `${String(hh).padStart(2, "0")}h ${String(mm).padStart(2, "0")}m ${ss.toFixed(2).padStart(5, "0")}s`;
}

export function formatDec(dec: number): string {
  const sign = dec < 0 ? "-" : "+", a = Math.abs(dec);
  const d = Math.floor(a), m = (a - d) * 60, mm = Math.floor(m), ss = (m - mm) * 60;
  return `${sign}${String(d).padStart(2, "0")}d ${String(mm).padStart(2, "0")}m ${ss.toFixed(1).padStart(4, "0")}s`;
}
