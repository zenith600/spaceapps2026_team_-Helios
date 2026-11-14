// Offline name resolution on a static deployment: what a judge types must open a baked view.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const demo = resolve(__dirname, "../public/demo/sky");
const catalogue = JSON.parse(readFileSync(resolve(demo, "catalogue.json"), "utf8"));

beforeAll(() => {
  vi.stubGlobal("fetch", async (url: string) => {
    if (!String(url).endsWith("/demo/sky/catalogue.json")) throw new Error(`unexpected fetch ${url}`);
    return { ok: true, status: 200, json: async () => catalogue };
  });
});
afterAll(() => { vi.unstubAllGlobals(); });

describe("resolveTarget offline", () => {
  it("resolves aliases the Python resolver knows, not only exact names", async () => {
    const { resolveTarget } = await import("./sky");
    for (const [q, slug] of [["eps Ind B", "epsilon-indi-b"], ["GJ 699", "barnards-star"], ["R Dra", "r-draconis"],
                             ["wise 0855", "wise-0855"], ["Barnard's Star", "barnards-star"]]) {
      expect((await resolveTarget(q)).slug, q).toBe(slug);
    }
  });

  it("every featured target resolves to a view that is actually baked", async () => {
    const { resolveTarget, skySlug } = await import("./sky");
    for (const t of catalogue.targets.filter((x: { featured: boolean }) => x.featured)) {
      const r = await resolveTarget(t.name);
      const dir = resolve(demo, skySlug(r.ra_deg, r.dec_deg, 0.1));
      expect(existsSync(resolve(dir, "sky.json")), `${t.name} -> ${dir}`).toBe(true);
      expect(existsSync(resolve(dir, "motion.json")), `${t.name} motion.json`).toBe(true);
    }
  });

  it("movers carry the catalogue position they were carried forward from", async () => {
    const { resolveTarget } = await import("./sky");
    const b = await resolveTarget("Barnard's Star");
    expect(b.catalog_dec_deg).toBeLessThan(b.dec_deg);       // it moves north
    expect(b.epoch_note).toMatch(/Gaia DR3/);
  });
});
