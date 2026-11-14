// "Find what changed" runs in Python for the API and in the browser for static deployments.
// Same field, same click, same answer — so the browser port is held to the Python output
// on the real WISE 0855 bundle (fixture: python scripts/make_spectrum_fixture.py).
//
// The browser works on the uint16-quantised cube and Python on float32, so continuous
// values may differ in the last digits; *which pixels* changed must not.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/change.json";
import { changeMap, type SkyBundle } from "./sky";

const dir = resolve(__dirname, "../public/demo/sky", fixture.slug);
const bundle = JSON.parse(readFileSync(resolve(dir, "sky.json"), "utf8")) as SkyBundle;
const raw = readFileSync(resolve(dir, "cube.u16"));
const cube = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
const got = changeMap(bundle, cube);

describe("browser change detection matches the Python reference on real data", () => {
  it("lands on the same field-wide calibration", () => {
    expect(got.median_chi2_per_dof!).toBeCloseTo(fixture.median, 1);
    expect(got.mad_chi2_per_dof!).toBeCloseTo(fixture.mad, 1);
  });

  it("finds the same strongest changes", () => {
    const top = (ps: { x: number; y: number }[], n: number) => new Set(ps.slice(0, n).map((p) => `${p.x},${p.y}`));
    const ours = top(got.peaks, 5), theirs = top(fixture.peaks, 5);
    const shared = [...ours].filter((k) => theirs.has(k)).length;
    // Quantisation can swap two near-equal neighbours at the boundary of the top five; any
    // more disagreement than that means the algorithms have diverged.
    expect(shared).toBeGreaterThanOrEqual(4);
  });

  it("agrees on the strongest peak, position and strength", () => {
    expect([got.peaks[0].x, got.peaks[0].y]).toEqual([fixture.peaks[0].x, fixture.peaks[0].y]);
    expect(Math.abs(got.peaks[0].z - fixture.peaks[0].z) / fixture.peaks[0].z).toBeLessThan(0.05);
  });

  it("returns peaks strongest first, capped at twelve", () => {
    expect(got.peaks.length).toBeLessThanOrEqual(12);
    const zs = got.peaks.map((p) => p.z);
    expect(zs).toEqual([...zs].sort((a, b) => b - a));
  });

  it("is calibrated — the typical pixel in a real field is not 'changed'", () => {
    const plane = bundle.npix * bundle.npix;
    expect(got.n_significant_pixels / plane).toBeLessThan(0.1);
    expect(got.median_chi2_per_dof!).toBeLessThan(5);
  });
});
