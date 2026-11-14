// Every baked bundle must be complete and self-consistent: each PNG the viewer will
// request has to exist on disk, the index and catalogue have to agree with the bundles,
// and the slugs have to be the ones the TypeScript side computes.
//
// `next build` and `tsc` prove the page compiles; this proves the data it loads is
// actually there. A missing frame shows up as a silently black blink frame otherwise.
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCoords, skySlug, type SkyBundle } from "./sky";

const demoRoot = resolve(__dirname, "../public/demo/sky");
const index = JSON.parse(readFileSync(resolve(demoRoot, "index.json"), "utf8")) as {
  targets: { slug: string; name: string; ra_deg: number; dec_deg: number; fov_deg: number;
             n_frames: number; n_visits: number; n_bands: number; baseline_days: number;
             look_for?: string; kind?: string }[];
  collections_at_bake_time: string[];
};
const catalogue = JSON.parse(readFileSync(resolve(demoRoot, "catalogue.json"), "utf8")) as {
  targets: { slug: string; name: string; ra_deg: number; dec_deg: number; featured: boolean }[];
};

const FIVE = ["Barnard's Star", "Epsilon Indi Ba/Bb", "WISE 0855-0714", "RW Aurigae", "R Draconis"];

describe("the demo index", () => {
  it("has all five targets named in the challenge brief", () => {
    expect(index.targets.map((t) => t.name).sort()).toEqual([...FIVE].sort());
  });

  it("records which SPHEREx releases it was baked from", () => {
    expect(index.collections_at_bake_time).toContain("spherex_dr1");
  });

  it("marks exactly those five as featured in the catalogue", () => {
    expect(catalogue.targets.filter((t) => t.featured).map((t) => t.name).sort()).toEqual([...FIVE].sort());
  });

  it("gives every target a real time baseline, not a single visit", () => {
    for (const t of index.targets) {
      expect(t.n_visits, t.name).toBeGreaterThan(1);
      expect(t.baseline_days, t.name).toBeGreaterThan(300);
      expect(t.n_frames, t.name).toBeGreaterThan(10);
    }
  });

  it("carries the guidance the gallery and viewer show", () => {
    // The gallery renders kind + look_for; without them a first-time visitor is choosing
    // between five names with no idea what any of them does.
    for (const t of index.targets) {
      expect(t.look_for, t.name).toBeTruthy();
      expect(t.kind, t.name).toBeTruthy();
      expect(t.look_for!.length, t.name).toBeGreaterThan(60);
    }
  });

  it("never claims more than the 102 SPHEREx bands, nor zero", () => {
    for (const t of index.targets) {
      expect(t.n_bands, t.name).toBeGreaterThan(0);
      expect(t.n_bands, t.name).toBeLessThanOrEqual(102);
    }
  });
});

describe.each(index.targets)("baked bundle: $name", (entry) => {
  const dir = resolve(demoRoot, entry.slug);
  const bundle = JSON.parse(readFileSync(resolve(dir, "sky.json"), "utf8")) as SkyBundle;

  const exists = (rel: string) => existsSync(resolve(dir, rel));
  const nonEmpty = (rel: string) => exists(rel) && statSync(resolve(dir, rel)).size > 0;

  it("lives at the slug the TypeScript port computes", () => {
    expect(entry.slug).toBe(skySlug(entry.ra_deg, entry.dec_deg, entry.fov_deg));
    expect(bundle.slug).toBe(entry.slug);
  });

  it("agrees with the index", () => {
    expect(bundle.coverage.n_used).toBe(entry.n_frames);
    expect(bundle.coverage.n_visits).toBe(entry.n_visits);
    expect(bundle.ra_deg).toBeCloseTo(entry.ra_deg, 4);
    expect(bundle.dec_deg).toBeCloseTo(entry.dec_deg, 4);
  });

  it("has every per-exposure frame and its flag overlay on disk", () => {
    expect(bundle.frames.epochs.length).toBeGreaterThan(0);
    for (const f of bundle.frames.epochs) {
      expect(nonEmpty(f.png), f.png).toBe(true);
      expect(nonEmpty(f.flag_png!), f.flag_png).toBe(true);
    }
  });

  it("has every visit and detector coadd on disk", () => {
    expect(bundle.frames.visits.length).toBe(entry.n_visits);
    for (const f of [...bundle.frames.visits, ...bundle.frames.detectors]) {
      expect(nonEmpty(f.png), f.png).toBe(true);
    }
  });

  it("has a difference frame for every visit after the first", () => {
    expect(bundle.difference.length).toBe(bundle.frames.visits.length - 1);
    for (const f of bundle.difference) {
      expect(nonEmpty(f.png), f.png).toBe(true);
      expect(f.reference_visit).toBe(bundle.frames.visits[0].visit);
    }
  });

  it("has the stack and static-sky overlays", () => {
    expect(nonEmpty(bundle.stack.png)).toBe(true);
    expect(nonEmpty(bundle.static.png)).toBe(true);
    expect(bundle.stack.n).toBe(bundle.coverage.n_used);
  });

  it("ships a pixel cube sized exactly as declared", () => {
    expect(bundle.cube_u16).toBeTruthy();
    const [planes, n, ny, nx] = bundle.cube_u16!.shape;
    expect([planes, n, ny, nx]).toEqual([2, bundle.coverage.n_used, bundle.npix, bundle.npix]);
    expect(statSync(resolve(dir, bundle.cube_u16!.file)).size).toBe(planes * n * ny * nx * 2);
    expect(bundle.cube_u16!.codec.length).toBe(2 * n);
  });

  it("orders frames in time, which is what makes the blink meaningful", () => {
    const mjds = bundle.frames.epochs.map((f) => f.mjd);
    expect(mjds).toEqual([...mjds].sort((a, b) => a - b));
    const visits = bundle.frames.visits.map((f) => f.mjd);
    expect(visits).toEqual([...visits].sort((a, b) => a - b));
  });

  it("labels every frame with a plausible SPHEREx wavelength", () => {
    for (const f of bundle.frames.epochs) {
      expect(f.wave_um, f.obs_id).toBeGreaterThan(0.6);   // SPHEREx covers 0.75-5.0 um
      expect(f.wave_um, f.obs_id).toBeLessThan(5.2);
      expect(f.detector).toBeGreaterThanOrEqual(1);
      expect(f.detector).toBeLessThanOrEqual(6);
    }
  });

  it("shares one brightness stretch across the frames", () => {
    expect(bundle.scale.vmax).toBeGreaterThan(bundle.scale.vmin);
    expect(bundle.scale.unit).toBe("MJy/sr");
  });

  it("carries provenance and the honest-limits text the UI shows", () => {
    expect(bundle.source).toMatch(/SPHEREx/);
    expect(bundle.source).toMatch(/irsa\.ipac\.caltech\.edu/);
    expect(bundle.limits.length).toBeGreaterThan(3);
    expect(bundle.limits.join(" ")).toMatch(/102/);
    expect(bundle.search.collections_searched).toContain("spherex_dr1");
  });

  it("records what coverage it was built from, so freshness can be diffed", () => {
    const built = (bundle as unknown as { freshness: { built_from: Record<string, { n: number }> } })
      .freshness.built_from;
    expect(Object.keys(built).length).toBeGreaterThan(0);
    expect(built["spherex_dr1"].n).toBeGreaterThan(0);
  });
});

describe("the brief's own test targets resolve to the bundles we baked", () => {
  it("WISE 0855 at the coordinates printed in the brief", () => {
    const c = parseCoords("08 55 10.831 -07 14 42.53")!;
    const slug = skySlug(c.ra, c.dec, 0.1);
    expect(index.targets.map((t) => t.slug)).toContain(slug);
  });

  it("every catalogue entry that is featured has a baked bundle", () => {
    for (const t of catalogue.targets.filter((x) => x.featured)) {
      expect(index.targets.map((x) => x.name), t.name).toContain(t.name);
    }
  });
});
