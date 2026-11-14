// The workstation's layer model.
//
// Four things are kept apart on purpose:
//   1. source data       -- the SkyBundle and its files, never copied here;
//   2. processing        -- described in ./pipeline.ts, not owned by layers;
//   3. visualisation     -- LayerConfig (visibility, opacity, blend, display adjustments);
//   4. UI metadata       -- names, lock, collapsed state.
// A layer is a *reference* to something the bundle (or a derived result) already holds.
// The tree is derived from the data every render; only the user's config is stored, so a
// layer that appears later (catalogue overlays arrive asynchronously) never breaks undo.
import type { Overlay, SkyBundle } from "../sky";
import type { FrameMode } from "../../components/SkyPlayer";

export type BlendMode = "normal" | "screen" | "lighten" | "difference";

export const BLEND_MODES: { id: BlendMode; label: string; note: string }[] = [
  { id: "normal", label: "Normal", note: "Paints over what is below, by opacity." },
  { id: "screen", label: "Screen", note: "Brightens only; faint structure below stays visible. The original viewer's comparison blend." },
  { id: "lighten", label: "Lighten", note: "Keeps the brighter of the two display values per pixel." },
  { id: "difference", label: "Difference", note: "Display-level |A − B|. A quick visual check only: it subtracts stretched 8-bit display values, not calibrated flux. For a real flux subtraction use Compare." },
];

export type LayerKind = "group" | "frames" | "stack" | "static" | "flags" | "change" | "catalog" | "probe" | "measure";

export type LayerConfig = {
  visible: boolean;
  locked: boolean;
  opacity: number;
  blend: BlendMode;
  collapsed: boolean;
  name?: string;
  /** Display-only adjustments (CSS filters). They never touch calibrated values. */
  brightness: number;
  contrast: number;
  invert: boolean;
};

export type Temporal = "per-frame" | "all-exposures" | "epochs-only" | "static" | "none";

export type LayerNode = {
  id: string;
  kind: LayerKind;
  defaultName: string;
  typeLabel: string;
  parent: string | null;
  children?: string[];
  canOpacity: boolean;
  canBlend: boolean;
  canAdjust: boolean;
  canReorder: boolean;
  /** "Clear" removes a derived result or a mark; source layers cannot be removed. */
  canClear: boolean;
  available: boolean;
  unavailableReason?: string;
  /** What the layer refers to. File paths are relative to the bundle. */
  source: { dataset: string; files: string[]; note: string };
  temporal: Temporal;
  defaults: LayerConfig;
};

export type LayerTree = { nodes: Record<string, LayerNode>; root: string[] };

/** Only the user's changes are stored. Anything absent falls back to the node's defaults. */
export type LayerDoc = {
  config: Record<string, Partial<LayerConfig>>;
  order: Record<string, string[]>;
};

export const EMPTY_LAYER_DOC: LayerDoc = { config: {}, order: {} };

const BASE: LayerConfig = {
  visible: true, locked: false, opacity: 1, blend: "normal", collapsed: false,
  brightness: 1, contrast: 1, invert: false,
};

export const MODE_LAYER: Record<FrameMode, { name: string; type: string }> = {
  visits: { name: "Time-lapse · per-visit coadds", type: "Observation epochs (visit coadds)" },
  colour: { name: "False colour · per-visit RGB", type: "False-colour composite" },
  detectors: { name: "Deeper · per-detector coadds", type: "Per-detector coadds" },
  epochs: { name: "Every frame · single exposures", type: "Level 2 exposures" },
  difference: { name: "What changed · visit − first visit", type: "Difference image sequence" },
};

const ROOT = "root";
const ORDER_ROOT = ["g-annot", "g-analysis", "g-catalogs", "g-compare", "g-obs"];

/** Build the layer tree for a bundle. Pure: the same inputs give the same tree. */
export function buildLayerTree(bundle: SkyBundle, overlay: Overlay | null, mode: FrameMode): LayerTree {
  const nodes: Record<string, LayerNode> = {};
  const ds = bundle.slug;
  const add = (n: Omit<LayerNode, "defaults"> & { defaults?: Partial<LayerConfig> }) => {
    nodes[n.id] = { ...n, defaults: { ...BASE, ...(n.defaults ?? {}) } };
  };
  const group = (id: string, name: string, children: string[], canReorder: boolean, note: string) =>
    add({
      id, kind: "group", defaultName: name, typeLabel: "Group", parent: null, children,
      canOpacity: true, canBlend: false, canAdjust: false, canReorder, canClear: false, available: true,
      source: { dataset: ds, files: [], note }, temporal: "none",
    });

  // ---- Observation (the source) -------------------------------------------------
  const nFrames = mode === "difference" ? bundle.difference.length
    : mode === "colour" ? (bundle.frames.colour?.length ?? 0)
    : mode === "detectors" ? bundle.frames.detectors.length
    : mode === "epochs" ? bundle.frames.epochs.length : bundle.frames.visits.length;
  group("g-obs", "Observation", ["frames"], false,
    "The SPHEREx data for this field. Always drawn at the bottom of the stack.");
  add({
    id: "frames", kind: "frames", defaultName: MODE_LAYER[mode].name, typeLabel: MODE_LAYER[mode].type,
    parent: "g-obs", canOpacity: true, canBlend: false, canAdjust: true, canReorder: false, canClear: false,
    available: nFrames > 0, unavailableReason: nFrames > 0 ? undefined : "No frames in this mode for this view.",
    source: { dataset: ds, files: [`${nFrames} PNG frames (${mode})`],
      note: "Rendered by the build pipeline with one shared stretch, so brightness is comparable between frames." },
    temporal: "per-frame",
  });

  // ---- Comparison images ---------------------------------------------------------
  group("g-compare", "Comparison", ["stack", "static"], true,
    "Whole-baseline images laid over the current frame. The original viewer's “Compare with”.");
  add({
    id: "stack", kind: "stack", defaultName: `Deep stack · ${bundle.stack.n} exposures`, typeLabel: "Temporal composite",
    parent: "g-compare", canOpacity: true, canBlend: true, canAdjust: false, canReorder: true, canClear: false,
    available: Boolean(bundle.stack.png), source: { dataset: ds, files: [bundle.stack.png], note: bundle.stack.note },
    temporal: "all-exposures", defaults: { visible: false, opacity: 0.55, blend: "screen" },
  });
  add({
    id: "static", kind: "static", defaultName: "Static sky · median", typeLabel: "Temporal composite (median)",
    parent: "g-compare", canOpacity: true, canBlend: true, canAdjust: false, canReorder: true, canClear: false,
    available: Boolean(bundle.static.png),
    source: { dataset: ds, files: [bundle.static.png], note: `${bundle.static.method}. ${bundle.static.note}` },
    temporal: "all-exposures", defaults: { visible: false, opacity: 0.55, blend: "screen" },
  });

  // ---- Catalogues ----------------------------------------------------------------
  const cats = overlay?.layers ?? [];
  group("g-catalogs", "Catalogues", cats.map((l) => `cat:${l.id}`), true,
    overlay?.note ?? "Known sources from other surveys, in this image's pixel coordinates.");
  for (const l of cats) {
    add({
      id: `cat:${l.id}`, kind: "catalog", defaultName: `${l.name}`, typeLabel: `Catalogue overlay · ${l.owner}`,
      parent: "g-catalogs", canOpacity: true, canBlend: false, canAdjust: false, canReorder: true, canClear: false,
      available: l.n > 0, unavailableReason: l.n > 0 ? undefined : "No catalogued sources in this field.",
      source: { dataset: ds, files: ["overlay.json"], note: l.note }, temporal: "static",
      defaults: { visible: false, opacity: 0.85 },
    });
  }

  // ---- Analysis ------------------------------------------------------------------
  group("g-analysis", "Analysis", ["change", "flags"], true, "Results computed from the pixel cube or shipped with the bundle.");
  add({
    id: "change", kind: "change", defaultName: "Change detection · χ² peaks", typeLabel: "Flicker / motion detection",
    parent: "g-analysis", canOpacity: true, canBlend: false, canAdjust: false, canReorder: true, canClear: true,
    available: true,
    source: { dataset: ds, files: bundle.cube_u16 ? [bundle.cube_u16.file] : ["(server cube)"],
      note: "Per-pixel χ² against a smooth-in-wavelength model; peaks are places to look, not detections." },
    temporal: "all-exposures", defaults: { visible: true },
  });
  const hasFlags = bundle.frames.epochs.some((f) => f.flag_png);
  add({
    id: "flags", kind: "flags", defaultName: "Quality flags · NASA", typeLabel: "Contamination / quality mask",
    parent: "g-analysis", canOpacity: true, canBlend: false, canAdjust: false, canReorder: true, canClear: false,
    available: mode === "epochs" && hasFlags,
    unavailableReason: !hasFlags ? "This bundle has no flag images."
      : "Flags belong to single exposures: switch to Every frame to see them.",
    source: { dataset: ds, files: ["flags/*.png"], note: "Level 2 FLAGS plane, nearest-neighbour reprojected (bitmasks are never interpolated)." },
    temporal: "epochs-only", defaults: { visible: false },
  });

  // ---- Annotations ---------------------------------------------------------------
  group("g-annot", "Marks", ["probe", "measure"], true, "Your marks on this view. Not saved with the data.");
  add({
    id: "probe", kind: "probe", defaultName: "Spectral probe", typeLabel: "Pixel selection + aperture",
    parent: "g-annot", canOpacity: true, canBlend: false, canAdjust: false, canReorder: true, canClear: true,
    available: true, source: { dataset: ds, files: [], note: "The pixel and aperture the spectrum is built from." },
    temporal: "none",
  });
  add({
    id: "measure", kind: "measure", defaultName: "Measurement", typeLabel: "Distance / position angle",
    parent: "g-annot", canOpacity: true, canBlend: false, canAdjust: false, canReorder: true, canClear: true,
    available: true, source: { dataset: ds, files: [], note: "Angular separation on the bundle's tangent plane." },
    temporal: "none",
  });

  return { nodes, root: ORDER_ROOT };
}

export function childrenOf(tree: LayerTree, doc: LayerDoc, parent: string | null): string[] {
  const key = parent ?? ROOT;
  const base = parent ? tree.nodes[parent]?.children ?? [] : tree.root;
  const stored = doc.order[key];
  if (!stored) return base;
  // Keep stored order for ids that still exist, then append any new ones in default order.
  const known = stored.filter((id) => base.includes(id));
  return [...known, ...base.filter((id) => !known.includes(id))];
}

export function configOf(tree: LayerTree, doc: LayerDoc, id: string): LayerConfig {
  const n = tree.nodes[id];
  return { ...(n?.defaults ?? BASE), ...(doc.config[id] ?? {}) };
}

export type ResolvedLayer = {
  node: LayerNode;
  config: LayerConfig;
  depth: number;
  name: string;
  /** Visible after its parents' visibility, and available for this mode. */
  shown: boolean;
  /** Opacity multiplied through its parents. */
  opacity: number;
  /** Paint order for leaves; higher draws on top. Groups get 0. */
  z: number;
  /** Hidden because a parent group is collapsed. */
  folded: boolean;
};

/** Flatten the tree in display order (top of the panel = top of the stack). */
export function resolveLayers(tree: LayerTree, doc: LayerDoc): ResolvedLayer[] {
  const out: ResolvedLayer[] = [];
  const walk = (ids: string[], depth: number, parentShown: boolean, parentOpacity: number, folded: boolean) => {
    for (const id of ids) {
      const node = tree.nodes[id];
      if (!node) continue;
      const config = configOf(tree, doc, id);
      const shown = parentShown && config.visible && node.available;
      const opacity = parentOpacity * config.opacity;
      out.push({ node, config, depth, name: config.name?.trim() || node.defaultName, shown, opacity, z: 0, folded });
      if (node.kind === "group") walk(childrenOf(tree, doc, id), depth + 1, shown, opacity, folded || config.collapsed);
    }
  };
  walk(childrenOf(tree, doc, null), 0, true, 1, false);
  const leaves = out.filter((l) => l.node.kind !== "group");
  leaves.forEach((l, k) => { l.z = leaves.length - k; });
  return out;
}

/** Whether the user may change this layer's properties. Visibility is always allowed. */
export function isEditable(config: LayerConfig): boolean {
  return !config.locked;
}

export function setConfig(doc: LayerDoc, id: string, patch: Partial<LayerConfig>): LayerDoc {
  return { ...doc, config: { ...doc.config, [id]: { ...(doc.config[id] ?? {}), ...patch } } };
}

/**
 * Move a layer one step up (-1) or down (+1) among its siblings. Only reorderable,
 * unlocked layers move, and they never jump over a sibling that is pinned in place.
 * Returns the same doc when the move is not allowed.
 */
export function moveLayer(tree: LayerTree, doc: LayerDoc, id: string, dir: -1 | 1): LayerDoc {
  const node = tree.nodes[id];
  if (!node || !node.canReorder || configOf(tree, doc, id).locked) return doc;
  const sibs = childrenOf(tree, doc, node.parent);
  const k = sibs.indexOf(id);
  const j = k + dir;
  if (k < 0 || j < 0 || j >= sibs.length) return doc;
  const other = tree.nodes[sibs[j]];
  if (!other || !other.canReorder) return doc;
  const next = [...sibs];
  [next[k], next[j]] = [next[j], next[k]];
  return { ...doc, order: { ...doc.order, [node.parent ?? ROOT]: next } };
}

export function canMove(tree: LayerTree, doc: LayerDoc, id: string, dir: -1 | 1): boolean {
  return moveLayer(tree, doc, id, dir) !== doc;
}

/** CSS filter for the display-only adjustments; undefined when nothing is adjusted. */
export function adjustmentFilter(c: Pick<LayerConfig, "brightness" | "contrast" | "invert">): string | undefined {
  const parts: string[] = [];
  if (c.brightness !== 1) parts.push(`brightness(${c.brightness})`);
  if (c.contrast !== 1) parts.push(`contrast(${c.contrast})`);
  if (c.invert) parts.push("invert(1)");
  return parts.length ? parts.join(" ") : undefined;
}
