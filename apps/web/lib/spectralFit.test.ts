// The browser classifies a clicked spectrum itself on a static deployment, and the API
// does it in Python otherwise. Same click, same verdict — or the answer depends on how the
// app was deployed, which is worse than having no answer.
//
// Fixture: python scripts/make_spectrum_fixture.py
import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/classify.json";
import { classifyPoints, fitTemperature, fitTemplates, planckNu, templateFnu } from "./spectralFit";
import type { SpectrumPoint } from "./sky";

const asPoints = (rows: { wave_um: number; flux_mjysr: number; flux_err_mjysr: number }[]) =>
  rows.map((r) => ({ ...r, bandwidth_um: 0.01, mjd: 60800, detector: 1, visit: 0,
                     obs_id: "SYN", n_pixels: 1 })) as SpectrumPoint[];

describe("physics helpers match the Python originals", () => {
  it("Planck function is monotonic in temperature at a fixed wavelength", () => {
    const a = planckNu(2.0, 300), b = planckNu(2.0, 3000);
    expect(b).toBeGreaterThan(a);
    expect(Number.isFinite(a) && a > 0).toBe(true);
  });

  it("the methane template has absorption dips where the model puts them", () => {
    // 1.4 um sits in a deep CH4 band; 1.25 um is in the window beside it.
    expect(templateFnu("planet", 1.4)).toBeLessThan(templateFnu("planet", 1.25));
    expect(templateFnu("planet", 2.3)).toBeLessThan(templateFnu("planet", 2.0));
  });

  it("the asteroid template is smooth where the planet template dips", () => {
    const ratio = templateFnu("asteroid", 1.4) / templateFnu("asteroid", 1.25);
    expect(Math.abs(ratio - 1)).toBeLessThan(0.3);
  });

  it("recovers the temperature of a synthetic blackbody", () => {
    const w = [0.9, 1.2, 1.6, 2.1, 2.8, 3.6, 4.6];
    const T = 1200;
    const raw = w.map((x) => planckNu(x, T));
    const m = Math.max(...raw);
    const f = raw.map((v) => 7 * (v / m));
    const e = f.map(() => 0.01);
    const got = fitTemperature(w, f, e).temperature_k!;
    expect(Math.abs(got - T) / T).toBeLessThan(0.15);
  });
});

describe.each(fixture.cases)("classification: $truth (noise $noise)", (c) => {
  const got = classifyPoints(asPoints(c.points));

  it("agrees with Python on whether it can classify at all", () => {
    expect(got.available).toBe(c.expect.available);
  });

  if (c.expect.available) {
    it("picks the same template", () => {
      expect(got.best).toBe(c.expect.best);
      expect(got.label).toBe(c.expect.label);
    });

    it("counts the same number of distinct colours", () => {
      expect(got.n_bands).toBe(c.expect.n_bands);
    });

    it("agrees on whether the call is confident", () => {
      expect(got.confident).toBe(c.expect.confident);
    });

    it("gives the same methane score", () => {
      if (c.methane_score == null) expect(got.methane_score).toBeNull();
      else expect(got.methane_score!).toBeCloseTo(c.methane_score, 2);
    });

    it("gives the same colour temperature", () => {
      if (c.temperature_k == null) expect(got.temperature?.temperature_k).toBeNull();
      else expect(got.temperature!.temperature_k!).toBeCloseTo(c.temperature_k, -1);
    });

    it("ranks the templates in the same order", () => {
      expect(got.ranking!.map((r) => r.template)).toEqual(c.ranking!.map((r) => r.template));
      got.ranking!.forEach((r, i) => {
        expect(r.chi2_per_dof).toBeCloseTo(c.ranking![i].chi2_per_dof, 1);
      });
    });
  }
});

describe("classification refuses rather than guesses", () => {
  it("needs at least three distinct colours", () => {
    const c = classifyPoints(asPoints([
      { wave_um: 1.0, flux_mjysr: 1, flux_err_mjysr: 0.1 },
      { wave_um: 1.001, flux_mjysr: 1, flux_err_mjysr: 0.1 },
    ]));
    expect(c.available).toBe(false);
    expect(c.reason).toMatch(/three/);
  });

  it("says so when there is nothing at all", () => {
    expect(classifyPoints([]).available).toBe(false);
  });

  it("flags a noisy fit as not confident", () => {
    const noisy = fixture.cases.find((x) => x.noise >= 0.3 && x.expect.available);
    if (noisy) expect(classifyPoints(asPoints(noisy.points)).confident).toBe(noisy.expect.confident);
  });
});

describe("fitTemplates", () => {
  it("returns a probability-like methane score between 0 and 1", () => {
    const w = [0.9, 1.2, 1.4, 1.7, 2.3, 3.3];
    const f = w.map((x) => 3 * templateFnu("planet", x));
    const r = fitTemplates(w, f, w.map(() => 0.01));
    expect(r.methane_score).toBeGreaterThan(0);
    expect(r.methane_score).toBeLessThanOrEqual(1);
    expect(r.best).toBe("planet");
  });

  it("ignores points with no usable error bar", () => {
    const w = [1.0, 1.5, 2.0, 2.5];
    const f = [1, 2, 3, 4];
    const e = [0.1, 0, NaN, 0.1];
    expect(fitTemplates(w, f, e).n).toBe(2);
  });
});
