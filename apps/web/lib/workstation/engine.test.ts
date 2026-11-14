// Regression tests for the pieces extracted from SkyPlayer and lib/sky.ts so the
// workstation could share them. Each pins the new shared code to the behaviour of the
// code it came from.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MODES, fracToPixel, toPlayFrames } from "../../components/SkyPlayer";
import { catalogAt, decodeSpectrum, mjdLabel, motionAt, pixelToSky, type SkyBundle } from "../sky";
import { formatArcsec, measure, separationArcsec } from "./measure";

const demoDir = resolve(__dirname, "../../public/demo/sky/ra133.7951-dec-7.2451-fov0.100");
const bundle = JSON.parse(readFileSync(resolve(demoDir, "sky.json"), "utf8")) as SkyBundle;
const raw = readFileSync(resolve(demoDir, "cube.u16"));
const cube = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);

describe("toPlayFrames (frame model shared by player and workstation)", () => {
  it("gives one frame per bundle entry in every mode, in bundle order", () => {
    const expected: Record<string, string[]> = {
      visits: bundle.frames.visits.map((f) => f.id),
      colour: (bundle.frames.colour ?? []).map((f) => f.id),
      detectors: bundle.frames.detectors.map((f) => f.id),
      epochs: bundle.frames.epochs.map((f) => f.id),
      difference: bundle.difference.map((f) => f.id),
    };
    for (const m of MODES) {
      expect(toPlayFrames(bundle, m.id).map((f) => f.id)).toEqual(expected[m.id]);
    }
  });

  it("keeps the original titles and the PNG paths", () => {
    const v = toPlayFrames(bundle, "visits")[0];
    expect(v.png).toBe(bundle.frames.visits[0].png);
    expect(v.title).toBe(mjdLabel(bundle.frames.visits[0].mjd));
    expect(v.title).toBe("2025-05-06");
    expect(v.subtitle).toMatch(/^visit 0 · \d+ exposures · \d+ bands?$/);
    const e = toPlayFrames(bundle, "epochs")[0];
    expect(e.flagPng).toBe(bundle.frames.epochs[0].flag_png);
    expect(e.detail).toContain(bundle.frames.epochs[0].obs_id);
  });

  it("carries cube references (visit / detector / obs id) without copying data", () => {
    const e = toPlayFrames(bundle, "epochs")[3];
    const src = bundle.frames.epochs[3];
    expect([e.visit, e.detector, e.obsId]).toEqual([src.visit, src.detector, src.obs_id]);
    const d = toPlayFrames(bundle, "detectors")[0];
    expect([d.visit, d.detector]).toEqual([bundle.frames.detectors[0].visit, bundle.frames.detectors[0].detector]);
  });
});

describe("fracToPixel (click -> pixel, moved out of SkyPlayer)", () => {
  // The expression SkyPlayer used inline before the extraction.
  const original = (fx: number, fy: number, npix: number) => {
    const clamp = (v: number) => Math.max(0, Math.min(npix - 1, Math.floor(v)));
    return { x: clamp(fx * npix), y: clamp((1 - fy) * npix) };
  };
  it("matches the original expression everywhere, edges included", () => {
    for (const npix of [29, 59, 117]) {
      for (const fx of [0, 0.0001, 0.25, 0.5, 0.9999, 1]) {
        for (const fy of [0, 0.0001, 0.3, 0.5, 0.9999, 1]) {
          expect(fracToPixel(fx, fy, npix)).toEqual(original(fx, fy, npix));
        }
      }
    }
  });
  it("flips y: the top of the image is the last row of the array", () => {
    expect(fracToPixel(0, 0, 59)).toEqual({ x: 0, y: 58 });
    expect(fracToPixel(0, 0.99, 59)).toEqual({ x: 0, y: 0 });
  });
});

describe("moving catalogue markers and motion tracks", () => {
  const layer = {
    id: "gaia", name: "Gaia DR3", owner: "ESA", colour: "#fff", note: "", n: 2, band: "G",
    epoch_mjd: 61000, moves: true,
    sources: [{ x: 10, y: 10, mag: 8, vx: 0, vy: 1.7 }, { x: 20, y: 20, mag: 15 }],
  };
  it("moves only sources with a proper motion, by their velocity times the elapsed years", () => {
    const later = catalogAt(layer, 61000 + 365.25);
    expect(later.sources[0]).toMatchObject({ x: 10, y: 11.7 });
    expect(later.sources[1]).toEqual(layer.sources[1]);
    expect(catalogAt(layer, 61000).sources[0].y).toBe(10);
  });
  it("leaves catalogues without motions, or with no date, untouched", () => {
    expect(catalogAt({ ...layer, moves: false }, 62000)).toEqual({ ...layer, moves: false });
    expect(catalogAt(layer, undefined)).toBe(layer);
  });
  it("puts a measured source where its fit says on any date", () => {
    const m = { slug: "s", available: true, prior: { x: 0, y: 0, note: "" }, pixel_arcsec: 6.15, min_wave_um: null,
      t_ref_mjd: 61000, fit: { x0: 30, y0: 29, vx_px_per_yr: -0.1, vy_px_per_yr: 1.7, ex0: 0, ey0: 0, evx: 0, evy: 0, chi2_x: 0, chi2_y: 0, dof: 3 } };
    expect(motionAt(m, 61000)).toEqual({ x: 30, y: 29 });
    const p = motionAt(m, 61000 + 365.25 / 2)!;
    expect(p.x).toBeCloseTo(29.95); expect(p.y).toBeCloseTo(29.85);
    expect(motionAt({ ...m, available: false }, 61000)).toBeNull();
  });
});

describe("measurement tool geometry", () => {
  it("one pixel along a row is one pixel scale; north is +y and east is -x", () => {
    const c = (bundle.npix - 1) / 2;
    const north = measure(bundle, { x: c, y: c }, { x: c, y: c + 10 });
    expect(north.arcsec).toBeCloseTo(10 * bundle.pixel_arcsec, 1);
    expect(north.pa_deg).toBeCloseTo(0, 0);
    const east = measure(bundle, { x: c, y: c }, { x: c - 10, y: c });
    expect(east.arcsec).toBeCloseTo(10 * bundle.pixel_arcsec, 1);
    expect(east.pa_deg).toBeCloseTo(90, 0);
  });
  it("separation is symmetric and formats arcminutes", () => {
    expect(separationArcsec(10, 20, 10.01, 20.02)).toBeCloseTo(separationArcsec(10.01, 20.02, 10, 20), 9);
    expect(formatArcsec(75.25)).toBe("1′ 15.3″");
  });
});

describe("pixelToSky agrees with the spectrum header", () => {
  it("gives exactly the RA/Dec decodeSpectrum reports for the same pixel", () => {
    for (const [x, y] of [[0, 0], [29, 29], [58, 0], [10, 47], [58, 58]]) {
      const s = decodeSpectrum(bundle, cube, x, y, 0);
      const p = pixelToSky(bundle, x, y);
      expect(p.ra_deg).toBe(s.ra_deg);
      expect(p.dec_deg).toBe(s.dec_deg);
    }
  });
  it("puts the centre pixel on the bundle centre", () => {
    const c = pixelToSky(bundle, (bundle.npix - 1) / 2, (bundle.npix - 1) / 2);
    expect(c.ra_deg).toBeCloseTo(bundle.ra_deg, 10);
    expect(c.dec_deg).toBeCloseTo(bundle.dec_deg, 10);
  });
});
