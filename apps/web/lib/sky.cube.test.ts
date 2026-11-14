// The browser decodes spectra from a quantised uint16 cube; the API computes them in
// Python from the float32 cube. The same click must give the same science either way.
//
// This runs the TypeScript decoder over the real baked WISE 0855 bundle and compares it
// against the Python reference in __fixtures__/spectrum.json, regenerated with:
//     python scripts/make_spectrum_fixture.py
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeSpectrum, type SkyBundle } from "./sky";
import fixture from "./__fixtures__/spectrum.json";

const demoDir = resolve(__dirname, "../public/demo/sky", fixture.slug);
const bundle = JSON.parse(readFileSync(resolve(demoDir, "sky.json"), "utf8")) as SkyBundle;
const raw = readFileSync(resolve(demoDir, "cube.u16"));
const cube = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);

// The only legitimate disagreement is the quantiser itself, so the tolerance is read
// from the codec rather than guessed: one step of the coarsest frame. Averaging a box
// can only shrink the error, never grow it past a single step.
const step = (plane: string) =>
  Math.max(...bundle.cube_u16!.codec.filter((c) => c.plane === plane).map((c) => c.scale));
const FLUX_TOL = step("flux");
// err = sqrt(sum var)/n, so d(err) <= n*step_var / (2*sqrt(sum var)*n) = step_var/(2*err).
const errTol = (err: number) => step("var") / (2 * Math.max(err, 1e-9));

describe("uint16 cube decoder matches the Python reference", () => {
  it("loaded a real baked bundle", () => {
    expect(bundle.cube_u16).toBeTruthy();
    const [planes, n, ny, nx] = bundle.cube_u16!.shape;
    expect(planes).toBe(2);
    expect(cube.length).toBe(planes * n * ny * nx);
    expect(bundle.coverage.n_used).toBe(n);
  });

  for (const c of fixture.cases) {
    describe(`pixel (${c.x}, ${c.y}) r=${c.r}`, () => {
      const got = decodeSpectrum(bundle, cube, c.x, c.y, c.r);

      it("finds the same exposures, in the same order", () => {
        expect(got.n_points).toBe(c.n_points);
        expect(got.n_bands).toBe(c.n_bands);
        expect(got.points.map((p) => p.obs_id)).toEqual(c.points.map((p) => p.obs_id));
      });

      it("recovers the same flux within one quantisation step", () => {
        got.points.forEach((p, i) => {
          expect(Math.abs(p.flux_mjysr - c.points[i].flux_mjysr)).toBeLessThan(FLUX_TOL);
        });
      });

      it("recovers the same uncertainties and pixel counts", () => {
        got.points.forEach((p, i) => {
          const exp = c.points[i].flux_err_mjysr;
          expect(Math.abs(p.flux_err_mjysr - exp)).toBeLessThan(errTol(exp));
          // Equal counts prove the browser applies the same good-pixel mask as Python.
          expect(p.n_pixels).toBe(c.points[i].n_pixels);
        });
      });

      it("labels each point with the same wavelength, detector and visit", () => {
        got.points.forEach((p, i) => {
          expect(p.wave_um).toBeCloseTo(c.points[i].wave_um, 4);
          expect(p.detector).toBe(c.points[i].detector);
          expect(p.visit).toBe(c.points[i].visit);
        });
      });

      it("counts usable and excluded exposures the same way Python does", () => {
        expect(got.n_exposures).toBe(c.n_exposures);
        expect(got.n_excluded).toBe(c.n_excluded);
        expect(got.quality.n_usable).toBe(c.quality.n_usable);
        expect(got.quality.saturated).toBe(c.quality.saturated);
        expect([...got.quality.flags].sort()).toEqual([...c.quality.flags].sort());
      });

      it("maps the pixel to the same sky position", () => {
        // Python inverts the full TAN projection; the browser uses the small-angle
        // approximation, which is good to well under a pixel over a 0.1 deg field.
        expect(got.ra_deg).toBeCloseTo(c.ra_deg, 3);
        expect(got.dec_deg).toBeCloseTo(c.dec_deg, 3);
      });
    });
  }
});

// R Draconis is a real saturation case: it is bright enough that SPHEREx zeroes and flags its
// core in every exposure, so a click on the obvious bright blob has no photometry behind it.
// The viewer has to explain that rather than show an empty panel.
describe("real saturated source (R Draconis)", () => {
  const dir = resolve(__dirname, "../public/demo/sky/ra248.1676-dec+66.7550-fov0.100");
  const rdra = JSON.parse(readFileSync(resolve(dir, "sky.json"), "utf8")) as SkyBundle;
  const raw2 = readFileSync(resolve(dir, "cube.u16"));
  const cube2 = new Uint16Array(raw2.buffer, raw2.byteOffset, raw2.byteLength / 2);
  const c = Math.floor(rdra.npix / 2);

  it("has no usable exposure at the saturated centre", () => {
    const s = decodeSpectrum(rdra, cube2, c, c, 0);
    expect(s.n_points).toBe(0);
    expect(s.quality.n_usable).toBe(0);
    expect(s.n_excluded).toBe(s.n_exposures);
  });

  it("says why, and names the flag classes", () => {
    const q = decodeSpectrum(rdra, cube2, c, c, 0).quality;
    expect(q.reason).toMatch(/saturate/);
    expect(q.saturated).toBe(true);
    expect(q.flags.length).toBeGreaterThan(0);
  });

  it("points at a nearby pixel that does have data", () => {
    const q = decodeSpectrum(rdra, cube2, c, c, 0).quality;
    expect(q.nearest_usable).not.toBeNull();
    const near = q.nearest_usable!;
    expect(near.n_usable).toBeGreaterThanOrEqual(Math.floor(rdra.coverage.n_used / 2));
    expect(near.distance_arcsec).toBeGreaterThan(0);
    // and that pixel really does yield a spectrum
    const s2 = decodeSpectrum(rdra, cube2, near.x, near.y, 0);
    expect(s2.n_points).toBeGreaterThanOrEqual(near.n_usable);
    expect(s2.quality.reason).toBeNull();
  });

  it("usable exposures increase with distance from the saturated core", () => {
    const counts = [0, 2, 5, 8, 12].map((d) => decodeSpectrum(rdra, cube2, c + d, c, 0).quality.n_usable);
    expect(counts[0]).toBe(0);
    expect(counts[counts.length - 1]).toBeGreaterThan(counts[1]);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
  });
});

describe("decoder edge cases", () => {
  it("refuses a pixel outside the field", () => {
    expect(() => decodeSpectrum(bundle, cube, 9999, 0, 1)).toThrow(/outside/);
    expect(() => decodeSpectrum(bundle, cube, 0, -5, 1)).toThrow(/outside/);
  });

  it("clamps the box radius rather than reading out of bounds", () => {
    const n = bundle.npix;
    const corner = decodeSpectrum(bundle, cube, 0, 0, 4);
    expect(corner.points.every((p) => p.n_pixels <= 25)).toBe(true);
    expect(corner.points.every((p) => p.n_pixels >= 1)).toBe(true);
    expect(decodeSpectrum(bundle, cube, n - 1, n - 1, 4).points.length).toBeGreaterThan(0);
  });

  it("returns points sorted by wavelength", () => {
    const s = decodeSpectrum(bundle, cube, 20, 20, 1);
    const waves = s.points.map((p) => p.wave_um);
    expect(waves).toEqual([...waves].sort((a, b) => a - b));
  });

  it("reports band count as distinct wavelengths, not exposure count", () => {
    const s = decodeSpectrum(bundle, cube, 20, 20, 1);
    expect(s.n_bands).toBeLessThanOrEqual(s.n_points);
    expect(s.bands_total).toBe(102);
  });
});
