import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { toPlayFrames } from "../../components/SkyPlayer";
import { CHANGE_DEFAULTS, type Overlay, type SkyBundle } from "../sky";
import { DerivedCache, keyOf } from "./derived";
import { canRedo, canUndo, commit, initHistory, jumpTo, redo, undo } from "./history";
import { cubePlanesForFrame, fluxValues, histogram, robustStats } from "./histogram";
import {
  EMPTY_LAYER_DOC, adjustmentFilter, buildLayerTree, childrenOf, moveLayer, resolveLayers, setConfig,
} from "./layers";
import { buildPipeline, downstreamOf } from "./pipeline";
import { makeScale, nearestByMjd, timeTicks } from "./timeline";
import { PANEL_IDS, WORKSPACES, closePanel, movePanel, openPanel, presetLayout, sanitizeLayout, sanitizePrefs } from "./workspaces";
import { classifyResource, summarizeResources } from "./perf";

const demoDir = resolve(__dirname, "../../public/demo/sky/ra133.7951-dec-7.2451-fov0.100");
const bundle = JSON.parse(readFileSync(resolve(demoDir, "sky.json"), "utf8")) as SkyBundle;
const overlay = JSON.parse(readFileSync(resolve(demoDir, "overlay.json"), "utf8")) as Overlay;
const raw = readFileSync(resolve(demoDir, "cube.u16"));
const cube = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);

// ---------------------------------------------------------------------------
describe("layer tree", () => {
  const tree = buildLayerTree(bundle, overlay, "visits");

  it("references bundle files instead of holding image data", () => {
    expect(tree.nodes.stack.source.files).toEqual([bundle.stack.png]);
    expect(tree.nodes.static.source.files).toEqual([bundle.static.png]);
    expect(JSON.stringify(tree).length).toBeLessThan(20_000);
  });

  it("has one catalogue layer per overlay layer, disabled when the field has none", () => {
    for (const l of overlay.layers) {
      expect(tree.nodes[`cat:${l.id}`].available).toBe(l.n > 0);
    }
  });

  it("defaults match the original viewer: comparison off at 55% screen, catalogue rings at 85%", () => {
    const r = resolveLayers(tree, EMPTY_LAYER_DOC);
    const by = (id: string) => r.find((l) => l.node.id === id)!;
    expect(by("stack").shown).toBe(false);
    expect(by("stack").config.opacity).toBe(0.55);
    expect(by("stack").config.blend).toBe("screen");
    expect(by("frames").shown).toBe(true);
    expect(by(`cat:${overlay.layers[0].id}`).config.opacity).toBe(0.85);
  });

  it("only offers quality flags in Every frame mode", () => {
    expect(tree.nodes.flags.available).toBe(false);
    expect(buildLayerTree(bundle, overlay, "epochs").nodes.flags.available).toBe(true);
  });

  it("hides children of a hidden group and multiplies opacity through groups", () => {
    let doc = setConfig(EMPTY_LAYER_DOC, "stack", { visible: true });
    doc = setConfig(doc, "g-compare", { opacity: 0.5 });
    let r = resolveLayers(tree, doc);
    expect(r.find((l) => l.node.id === "stack")!.opacity).toBeCloseTo(0.275);
    doc = setConfig(doc, "g-compare", { visible: false });
    r = resolveLayers(tree, doc);
    expect(r.find((l) => l.node.id === "stack")!.shown).toBe(false);
  });

  it("paints the observation at the bottom and marks on top", () => {
    const r = resolveLayers(tree, EMPTY_LAYER_DOC).filter((l) => l.node.kind !== "group");
    const z = (id: string) => r.find((l) => l.node.id === id)!.z;
    expect(z("frames")).toBe(1);
    expect(z("probe")).toBeGreaterThan(z("stack"));
  });

  it("reorders among siblings, never past the pinned observation, and not when locked", () => {
    let doc = moveLayer(tree, EMPTY_LAYER_DOC, "static", -1);
    expect(childrenOf(tree, doc, "g-compare")).toEqual(["static", "stack"]);
    expect(moveLayer(tree, doc, "static", -1)).toBe(doc);                 // already first
    expect(moveLayer(tree, EMPTY_LAYER_DOC, "g-compare", 1)).toBe(EMPTY_LAYER_DOC); // would pass g-obs
    expect(moveLayer(tree, EMPTY_LAYER_DOC, "frames", -1)).toBe(EMPTY_LAYER_DOC);
    doc = setConfig(EMPTY_LAYER_DOC, "stack", { locked: true });
    expect(moveLayer(tree, doc, "stack", 1)).toBe(doc);
  });

  it("stores only user changes; a later overlay adds layers without disturbing them", () => {
    const early = buildLayerTree(bundle, null, "visits");
    const doc = setConfig(EMPTY_LAYER_DOC, "stack", { visible: true });
    const r = resolveLayers(buildLayerTree(bundle, overlay, "visits"), doc);
    expect(r.find((l) => l.node.id === "stack")!.shown).toBe(true);
    expect(early.nodes["g-catalogs"].children).toEqual([]);
  });

  it("builds display-only filters", () => {
    expect(adjustmentFilter({ brightness: 1, contrast: 1, invert: false })).toBeUndefined();
    expect(adjustmentFilter({ brightness: 1.2, contrast: 1, invert: true })).toBe("brightness(1.2) invert(1)");
  });
});

// ---------------------------------------------------------------------------
describe("history", () => {
  it("undoes and redoes", () => {
    let h = initHistory(0);
    h = commit(h, 1, "a"); h = commit(h, 2, "b");
    expect(h.present.state).toBe(2);
    h = undo(h); expect(h.present.state).toBe(1); expect(canRedo(h)).toBe(true);
    h = redo(h); expect(h.present.state).toBe(2);
    h = undo(undo(h)); expect(h.present.state).toBe(0); expect(canUndo(h)).toBe(false);
  });
  it("coalesces a slider drag into one step", () => {
    let h = initHistory(0);
    h = commit(h, 1, "opacity", { coalesceKey: "op", now: 1000 });
    h = commit(h, 2, "opacity", { coalesceKey: "op", now: 1100 });
    h = commit(h, 3, "opacity", { coalesceKey: "op", now: 1200 });
    expect(h.past.length).toBe(1);
    expect(undo(h).present.state).toBe(0);
    h = commit(h, 4, "opacity", { coalesceKey: "op", now: 5000 });      // after the window
    expect(h.past.length).toBe(2);
  });
  it("a new commit clears redo, and jumpTo lands on any step", () => {
    let h = initHistory("a");
    h = commit(h, "b", "b"); h = commit(h, "c", "c");
    h = undo(h); h = commit(h, "d", "d");
    expect(h.future).toEqual([]);
    expect(jumpTo(h, 0).present.state).toBe("a");
  });
});

// ---------------------------------------------------------------------------
describe("timeline", () => {
  const mjds = toPlayFrames(bundle, "epochs").map((f) => f.mjd);
  it("time scale is monotonic in MJD and index scale is evenly spaced", () => {
    const t = makeScale(mjds, "time");
    const sorted = [...mjds].map((m, k) => [m, t.frac(k)]).sort((a, b) => a[0] - b[0]);
    for (let k = 1; k < sorted.length; k++) expect(sorted[k][1]).toBeGreaterThanOrEqual(sorted[k - 1][1]);
    const ix = makeScale(mjds, "index");
    expect(ix.frac(1) - ix.frac(0)).toBeCloseTo(ix.frac(2) - ix.frac(1));
  });
  it("scrubbing returns the nearest frame on both scales", () => {
    for (const mode of ["time", "index"] as const) {
      const s = makeScale(mjds, mode);
      for (let k = 0; k < mjds.length; k += 7) expect(mjds[s.nearest(s.frac(k))]).toBe(mjds[k]);
    }
    expect(nearestByMjd([1, 5, 9], 6.9)).toBe(1);
  });
  it("calendar ticks fall inside the range and stay few", () => {
    const t0 = bundle.coverage.mjd_min, t1 = bundle.coverage.mjd_max;
    const ticks = timeTicks(t0, t1, 12);
    expect(ticks.length).toBeGreaterThan(2);
    expect(ticks.length).toBeLessThanOrEqual(13);
    for (const tk of ticks) { expect(tk.mjd).toBeGreaterThanOrEqual(t0); expect(tk.mjd).toBeLessThanOrEqual(t1); }
    expect(timeTicks(60000, 60010, 12).length).toBeGreaterThan(3);
  });
});

// ---------------------------------------------------------------------------
describe("processing graph", () => {
  const ctx = { demo: true, change: { state: "idle" as const, params: CHANGE_DEFAULTS }, aperture: 1, pixelPicked: false };
  const nodes = buildPipeline(bundle, ctx);

  it("is in dependency order: every input appears before it is used", () => {
    const seen = new Set<string>();
    for (const n of nodes) {
      for (const i of n.inputs) expect(seen.has(i)).toBe(true);
      seen.add(n.id);
    }
  });
  it("reports the bundle's own numbers", () => {
    const sel = nodes.find((n) => n.id === "select")!;
    expect(sel.params.find((p) => p.k === "used")!.v).toBe(String(bundle.coverage.n_used));
    expect(nodes.find((n) => n.id === "stretch")!.params[0].v).toBe(bundle.scale.mode);
  });
  it("only in-browser steps are editable, and change detection is fixed in API mode", () => {
    expect(nodes.filter((n) => n.where.startsWith("server · build") && n.editable)).toEqual([]);
    expect(nodes.find((n) => n.id === "change")!.editable).toBe(true);
    const api = buildPipeline(bundle, { ...ctx, demo: false });
    expect(api.find((n) => n.id === "change")!.editable).toBe(false);
  });
  it("a parameter change affects only what is downstream of it", () => {
    expect(downstreamOf(nodes, "change")).toEqual([]);
    expect(downstreamOf(nodes, "spectrum")).toEqual(["classify"]);
    expect(downstreamOf(nodes, "cube")).toEqual(expect.arrayContaining(["change", "spectrum", "classify", "pair-difference"]));
    expect(downstreamOf(nodes, "cube")).not.toContain("stack");
  });
});

// ---------------------------------------------------------------------------
describe("derived-result cache", () => {
  const key = (threshold: number, dataset = "slug@t1") =>
    ({ dataset, op: "change_map", version: "ts-1", params: { deg: 2, floor: 0.05, threshold } });
  it("identity covers dataset, version and every parameter, independent of key order", () => {
    expect(keyOf(key(5))).toBe(keyOf({ ...key(5), params: { threshold: 5, floor: 0.05, deg: 2 } }));
    expect(keyOf(key(5))).not.toBe(keyOf(key(6)));
    expect(keyOf(key(5))).not.toBe(keyOf(key(5, "slug@t2")));
  });
  it("changing one parameter misses without evicting the other result", () => {
    const c = new DerivedCache<number>(4);
    c.set(key(5), 1, 3);
    expect(c.get(key(6))).toBeUndefined();
    c.set(key(6), 2, 3);
    expect(c.get(key(5))).toBe(1);
    expect([c.hits, c.misses]).toEqual([1, 1]);
  });
  it("evicts least recently used past its limit", () => {
    const c = new DerivedCache<number>(2);
    c.set(key(1), 1, 0); c.set(key(2), 2, 0);
    c.get(key(1));
    c.set(key(3), 3, 0);
    expect(c.peek(key(2))).toBeUndefined();
    expect(c.peek(key(1))).toBe(1);
    expect(c.evictions).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("histogram from the cube", () => {
  const cc = bundle.cube_u16!;
  it("maps a single exposure to exactly one cube plane, and visits to all their exposures", () => {
    const e = toPlayFrames(bundle, "epochs");
    for (const f of e.slice(0, 10)) expect(cubePlanesForFrame(cc, f, "epochs")).toHaveLength(1);
    const v = toPlayFrames(bundle, "visits");
    const total = v.reduce((s, f) => s + cubePlanesForFrame(cc, f, "visits").length, 0);
    expect(total).toBe(cc.shape[1]);
    expect(cubePlanesForFrame(cc, toPlayFrames(bundle, "difference")[0], "difference")).toEqual([]);
  });
  it("gives finite statistics in MJy/sr inside the display stretch's neighbourhood", () => {
    const f = toPlayFrames(bundle, "epochs")[0];
    const vals = fluxValues(cc, cube, cubePlanesForFrame(cc, f, "epochs"));
    const s = robustStats(vals)!;
    expect(s.n).toBeGreaterThan(1000);
    expect(s.median).toBeGreaterThan(bundle.scale.vmin - 1);
    expect(s.median).toBeLessThan(bundle.scale.vmax + 1);
    const h = histogram(vals, 32, s.p01, s.p99);
    expect(h.counts.reduce((a, b) => a + b, 0) + h.under + h.over).toBe(s.n);
  });
});

// ---------------------------------------------------------------------------
describe("workspaces", () => {
  it("every preset uses each panel at most once", () => {
    for (const w of WORKSPACES) {
      const ids = [...w.layout.top, ...w.layout.bottom];
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(PANEL_IDS).toContain(id);
    }
  });
  it("sanitises stored junk instead of trusting it", () => {
    const fb = presetLayout("default");
    const l = sanitizeLayout({ top: ["layers", "nope", "layers"], bottom: ["layers", "cache"], split: 9, rightWidth: "x" }, fb);
    expect(l.top).toEqual(["layers"]);
    expect(l.bottom).toEqual(["cache"]);
    expect(l.split).toBe(0.88);
    expect(l.rightWidth).toBe(fb.rightWidth);
    expect(sanitizeLayout(null, fb)).toBe(fb);
    expect(sanitizePrefs({ coordFormat: "weird", timelineScale: "index" })).toMatchObject({ coordFormat: "sexagesimal", timelineScale: "index" });
  });
  it("open / close / move keep each panel in one place", () => {
    let l = presetLayout("spectral");
    l = openPanel(l, "cache");
    expect(l.bottom).toContain("cache");
    l = movePanel(l, "cache");
    expect(l.top).toContain("cache"); expect(l.bottom).not.toContain("cache");
    l = closePanel(l, "cache");
    expect([...l.top, ...l.bottom]).not.toContain("cache");
  });
});

// ---------------------------------------------------------------------------
describe("resource timing summary", () => {
  it("classifies bundle files", () => {
    expect(classifyResource("/demo/sky/x/frames/e001.png")).toBe("frames");
    expect(classifyResource("/demo/sky/x/stack.png")).toBe("composites");
    expect(classifyResource("/demo/sky/x/cube.u16")).toBe("cube");
    expect(classifyResource("/demo/sky/x/sky.json")).toBe("metadata");
  });
  it("counts cache hits, network loads and opaque cross-origin entries separately", () => {
    const g = summarizeResources([
      { name: "/demo/sky/x/frames/a.png", transferSize: 0, encodedBodySize: 10, decodedBodySize: 10, duration: 1 },
      { name: "/demo/sky/x/frames/b.png", transferSize: 300, encodedBodySize: 10, decodedBodySize: 10, duration: 5 },
      { name: "/demo/sky/x/frames/c.png", transferSize: 0, encodedBodySize: 0, decodedBodySize: 0, duration: 5 },
      { name: "/other/thing.js", transferSize: 1, encodedBodySize: 1, decodedBodySize: 1, duration: 1 },
    ], (u) => u.includes("/sky/x/"));
    expect(g).toEqual([expect.objectContaining({ kind: "frames", count: 3, fromCache: 1, network: 1, unknown: 1 })]);
  });
});
