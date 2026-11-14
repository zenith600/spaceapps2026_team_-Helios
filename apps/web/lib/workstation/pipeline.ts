// The processing graph behind a view, read from the bundle itself.
//
// Most of it ran once, on the server, when the bundle was built
// (pipeline/deepfield/sky/service.py: build_sky_bundle). Those steps are shown as
// provenance with the parameters the bundle recorded; they are not editable here because
// the browser does not hold the Level 2 exposures they consumed. The steps that run in
// this browser (or on request through the API) are the ones with live parameters.
//
// The order is fixed by data dependencies, not by preference: nothing here is reorderable.
import { CHANGE_DEFAULTS, type ChangeParams, type Motion, type SkyBundle } from "../sky";

export type NodeState = "baked" | "ready" | "not-run" | "running" | "unavailable" | "on-demand";
export type Where = "IRSA" | "server · build" | "browser" | "server · on request";

export type PipelineNode = {
  id: string;
  label: string;
  where: Where;
  inputs: string[];
  params: { k: string; v: string }[];
  output: string;
  state: NodeState;
  editable: boolean;
  note?: string;
  /** The layer that shows this step's output, if any. */
  layer?: string;
};

export type PipelineContext = {
  demo: boolean;
  change: { state: "idle" | "running" | "ready" | "error"; params: ChangeParams };
  aperture: number;
  pixelPicked: boolean;
  motion?: Motion | null;
};

const fx = (v: number, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : "—");

export function buildPipeline(b: SkyBundle, ctx: PipelineContext): PipelineNode[] {
  const cov = b.coverage;
  const cube = b.cube_u16;
  const hasCube = Boolean(cube) || !ctx.demo;   // in API mode the server reads cube.npz
  const nodes: PipelineNode[] = [];
  const add = (n: PipelineNode) => nodes.push(n);

  add({
    id: "search", label: "Coverage search", where: "IRSA", inputs: [], state: "baked", editable: false,
    params: [
      { k: "collections searched", v: b.search.collections_searched.join(", ") || "—" },
      { k: "collections published", v: b.search.collections_available.join(", ") || "—" },
      { k: "source", v: b.search.collection_source },
    ],
    output: `${cov.n_exposures_available} exposures cover this field`,
  });
  add({
    id: "select", label: "Exposure selection", where: "server · build", inputs: ["search"], state: "baked", editable: false,
    params: [
      { k: "requested", v: String(cov.n_requested) },
      { k: "used", v: String(cov.n_used) },
      { k: "skipped", v: String(cov.n_skipped) },
    ],
    output: `${cov.n_used} exposures in ${cov.n_visits} visits`,
  });
  add({
    id: "reproject", label: "Cutout + reprojection", where: "server · build", inputs: ["select"], state: "baked", editable: false,
    params: [
      { k: "grid", v: `${b.npix} × ${b.npix} px` },
      { k: "pixel scale", v: `${b.pixel_arcsec}″` },
      { k: "projection", v: b.wcs?.ctype?.join(" / ") ?? "tangent plane" },
      { k: "flux", v: "bilinear" },
      { k: "flags", v: "nearest-neighbour" },
    ],
    output: "every exposure on one common grid",
  });
  add({
    id: "stretch", label: "Display stretch", where: "server · build", inputs: ["reproject"], state: "baked", editable: false,
    params: [
      { k: "mode", v: b.scale.mode },
      { k: "vmin", v: `${fx(b.scale.vmin)} ${b.scale.unit}` },
      { k: "vmax", v: `${fx(b.scale.vmax)} ${b.scale.unit}` },
    ],
    output: "8-bit display PNGs", note: b.scale.note,
  });
  add({
    id: "epochs", label: "Single exposures", where: "server · build", inputs: ["reproject", "stretch"], state: "baked",
    editable: false, params: [{ k: "frames", v: String(b.frames.epochs.length) }],
    output: "Every frame mode + quality-flag images", layer: "frames",
  });
  add({
    id: "coadd-visit", label: "Per-visit coadd", where: "server · build", inputs: ["reproject", "stretch"], state: "baked",
    editable: false, params: [{ k: "weighting", v: "inverse variance" }, { k: "frames", v: String(b.frames.visits.length) }],
    output: "Time-lapse mode", layer: "frames",
  });
  add({
    id: "coadd-detector", label: "Per-detector coadd", where: "server · build", inputs: ["reproject", "stretch"], state: "baked",
    editable: false, params: [{ k: "weighting", v: "inverse variance" }, { k: "frames", v: String(b.frames.detectors.length) }],
    output: "Deeper mode", layer: "frames",
  });
  add({
    id: "colour", label: "False-colour composite", where: "server · build", inputs: ["reproject"],
    state: b.colour?.available ? "baked" : "unavailable", editable: false,
    params: (b.colour?.channels ?? []).map((c) => ({ k: c.colour, v: c.range_um })),
    output: "In colour mode", note: b.colour?.available ? undefined : b.colour?.reason, layer: "frames",
  });
  add({
    id: "difference", label: "Difference vs first visit", where: "server · build", inputs: ["coadd-visit"],
    state: b.difference.length ? "baked" : "unavailable", editable: false,
    params: [{ k: "frames", v: String(b.difference.length) }, { k: "stretch", v: "linear, symmetric, 2–98%" }],
    output: "What changed mode", layer: "frames",
  });
  add({
    id: "stack", label: "Deep stack", where: "server · build", inputs: ["reproject", "stretch"], state: "baked", editable: false,
    params: [{ k: "exposures", v: String(b.stack.n) }], output: "Comparison layer", note: b.stack.note, layer: "stack",
  });
  add({
    id: "static", label: "Static sky", where: "server · build", inputs: ["reproject", "stretch"], state: "baked", editable: false,
    params: [{ k: "method", v: b.static.method }], output: "Comparison layer", note: b.static.note, layer: "static",
  });
  add({
    id: "cube", label: "Pixel cube export", where: "server · build", inputs: ["reproject"],
    state: hasCube ? "baked" : "unavailable", editable: false,
    params: cube ? [
      { k: "shape", v: cube.shape.join(" × ") },
      { k: "planes", v: cube.planes.join(", ") },
      { k: "flux codec", v: "uint16, linear" },
      { k: "variance codec", v: "uint16, log" },
    ] : [{ k: "format", v: ctx.demo ? "not exported" : "cube.npz (server)" }],
    output: "per-exposure flux + variance at every pixel",
    note: hasCube ? undefined : "This view was exported without its pixel cube: spectra and change detection need it.",
  });

  const mo = ctx.motion;
  add({
    id: "motion", label: "Proper-motion fit", where: "server · build", inputs: ["cube"],
    state: !hasCube ? "unavailable" : mo?.available ? "baked" : mo ? "unavailable" : "not-run", editable: false,
    params: mo?.available && mo.pm ? [
      { k: "visits used", v: String(mo.visits?.length ?? 0) },
      { k: "baseline", v: `${mo.baseline_days} d` },
      { k: "position model", v: "2-D Gaussian + background, 7×7 px" },
      { k: "result", v: `${mo.pm.total_arcsec_yr.toFixed(3)} ± ${mo.pm.err_total.toFixed(3)} ″/yr` },
      { k: "Gaia DR3", v: mo.comparison ? `${mo.comparison.total_arcsec_yr.toFixed(3)} ″/yr (${mo.comparison.n_sigma}σ)` : "no match" },
    ] : [{ k: "status", v: mo?.reason ?? "not measured for this view" }],
    output: "measured track + proper motion", layer: "motion",
    note: mo?.caveat,
  });

  const ch = ctx.change;
  add({
    id: "change", label: "Change detection", where: ctx.demo ? "browser" : "server · on request", inputs: ["cube"],
    state: !hasCube ? "unavailable" : ch.state === "ready" ? "ready" : ch.state === "running" ? "running" : "not-run",
    editable: ctx.demo && hasCube,
    note: ctx.demo ? undefined : "The API route has no parameters; the server's defaults apply.",
    params: [
      { k: "polynomial degree", v: String(ctx.demo ? ch.params.deg : CHANGE_DEFAULTS.deg) },
      { k: "error floor", v: String(ctx.demo ? ch.params.floor : CHANGE_DEFAULTS.floor) },
      { k: "threshold (robust z)", v: String(ctx.demo ? ch.params.threshold : CHANGE_DEFAULTS.threshold) },
    ],
    output: "χ² peaks", layer: "change",
  });
  add({
    id: "spectrum", label: "Spectrum extraction", where: ctx.demo ? "browser" : "server · on request", inputs: ["cube"],
    state: !hasCube ? "unavailable" : ctx.pixelPicked ? "ready" : "on-demand", editable: hasCube,
    params: [{ k: "aperture", v: `${2 * ctx.aperture + 1} × ${2 * ctx.aperture + 1} px` }],
    output: "flux vs wavelength at the probe", layer: "probe",
  });
  add({
    id: "classify", label: "Template classification", where: ctx.demo ? "browser" : "server · on request", inputs: ["spectrum"],
    state: !hasCube ? "unavailable" : ctx.pixelPicked ? "ready" : "on-demand", editable: false,
    params: [{ k: "odd-one-out χ²/dof", v: b.classify ? String(b.classify.odd_threshold) : "—" }],
    output: "spectral shape label", note: b.classify?.note,
  });
  add({
    id: "pair-difference", label: "Visit difference A − B", where: ctx.demo ? "browser" : "server · on request",
    inputs: ["cube"], state: hasCube ? "on-demand" : "unavailable", editable: hasCube,
    params: [{ k: "weighting", v: "inverse variance per visit" }, { k: "stretch", v: "linear, symmetric, 98%" }],
    output: "calibrated-flux difference (Compare panel)",
  });
  return nodes;
}

/** Every step that consumes `id`'s output, directly or not, in pipeline order. */
export function downstreamOf(nodes: PipelineNode[], id: string): string[] {
  const out = new Set<string>();
  let frontier = [id];
  while (frontier.length) {
    const next: string[] = [];
    for (const n of nodes) {
      if (out.has(n.id)) continue;
      if (n.inputs.some((i) => frontier.includes(i))) { out.add(n.id); next.push(n.id); }
    }
    frontier = next;
  }
  return nodes.filter((n) => out.has(n.id)).map((n) => n.id);
}
