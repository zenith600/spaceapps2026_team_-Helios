// Workspace presets: different arrangements of the same panels. Nothing here changes what a
// panel does. Layouts and preferences persist in localStorage, the same mechanism the app
// already uses for the demo crowd store (lib/api.ts).
import type { TimeScale } from "./timeline";

export type PanelId =
  | "layers" | "properties" | "metadata" | "histogram" | "spectrum"
  | "processing" | "cache" | "compare" | "context" | "history" | "targets";

export const PANELS: { id: PanelId; title: string; hint: string }[] = [
  { id: "layers", title: "Layers", hint: "What is drawn on the canvas, in order" },
  { id: "properties", title: "Properties", hint: "The selected layer: settings and provenance" },
  { id: "metadata", title: "Metadata", hint: "Everything the bundle records about this field" },
  { id: "histogram", title: "Histogram", hint: "Pixel statistics of the current frame" },
  { id: "spectrum", title: "Spectral Data", hint: "Spectrum and shape at the probe" },
  { id: "processing", title: "Processing", hint: "The processing graph behind this view" },
  { id: "cache", title: "Cache / Performance", hint: "What is held in memory and on the server" },
  { id: "compare", title: "Compare", hint: "Subtract any visit from any other, in calibrated flux" },
  { id: "context", title: "Sky Context", hint: "About this field, and where it sits on the sky" },
  { id: "history", title: "History", hint: "Undo steps for this view" },
  { id: "targets", title: "Targets", hint: "Ready-made fields and search" },
];
export const PANEL_IDS = PANELS.map((p) => p.id);

export type Layout = {
  top: PanelId[];
  bottom: PanelId[];
  topActive: PanelId | null;
  bottomActive: PanelId | null;
  topCollapsed: boolean;
  bottomCollapsed: boolean;
  /** Fraction of the dock height given to the top group. */
  split: number;
  rightWidth: number;
  showRight: boolean;
  timeline: boolean;
  timelineHeight: number;
};

export type WorkspaceId = "default" | "image" | "temporal" | "spectral" | "processing" | "performance";

const L = (p: Partial<Layout> & Pick<Layout, "top" | "bottom">): Layout => ({
  topActive: p.top[0] ?? null, bottomActive: p.bottom[0] ?? null, topCollapsed: false, bottomCollapsed: false,
  split: 0.5, rightWidth: 380, showRight: true, timeline: true, timelineHeight: 168, ...p,
});

export const WORKSPACES: { id: WorkspaceId; label: string; hint: string; layout: Layout }[] = [
  { id: "default", label: "Default", hint: "Balanced: spectrum and layers side by side",
    layout: L({ top: ["spectrum", "histogram", "context"], bottom: ["layers", "properties", "metadata", "processing", "cache", "compare", "history", "targets"], split: 0.48 }) },
  { id: "image", label: "Image Analysis", hint: "Pixel statistics, layers and metadata",
    layout: L({ top: ["histogram", "properties"], bottom: ["layers", "metadata", "history"], split: 0.5, timelineHeight: 120 }) },
  { id: "temporal", label: "Temporal Analysis", hint: "A tall timeline and visit comparison",
    layout: L({ top: ["compare", "properties"], bottom: ["layers", "history"], split: 0.6, timelineHeight: 250 }) },
  { id: "spectral", label: "Spectral Analysis", hint: "A large spectrum view",
    layout: L({ top: ["spectrum"], bottom: ["properties", "metadata", "layers"], split: 0.66, rightWidth: 460, timelineHeight: 120 }) },
  { id: "processing", label: "Processing", hint: "The processing graph and its parameters",
    layout: L({ top: ["processing"], bottom: ["layers", "properties", "history"], split: 0.6, rightWidth: 420 }) },
  { id: "performance", label: "Performance Monitoring", hint: "Caches, jobs and loading",
    layout: L({ top: ["cache"], bottom: ["processing", "metadata"], split: 0.62, rightWidth: 420 }) },
];

export function presetLayout(id: WorkspaceId): Layout {
  const w = WORKSPACES.find((x) => x.id === id) ?? WORKSPACES[0];
  return { ...w.layout, top: [...w.layout.top], bottom: [...w.layout.bottom] };
}

const clamp = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

/**
 * Accept a stored layout only in a shape the UI can render: known panel ids, each in at
 * most one group, actives that exist, sizes in range. Anything else falls back.
 */
export function sanitizeLayout(raw: unknown, fallback: Layout): Layout {
  if (!raw || typeof raw !== "object") return fallback;
  const r = raw as Partial<Layout>;
  const seen = new Set<PanelId>();
  const clean = (xs: unknown): PanelId[] => (Array.isArray(xs) ? xs : []).filter((x): x is PanelId => {
    if (!PANEL_IDS.includes(x as PanelId) || seen.has(x as PanelId)) return false;
    seen.add(x as PanelId);
    return true;
  });
  const top = clean(r.top);
  const bottom = clean(r.bottom);
  const act = (a: unknown, list: PanelId[]) => (list.includes(a as PanelId) ? (a as PanelId) : list[0] ?? null);
  return {
    top, bottom,
    topActive: act(r.topActive, top),
    bottomActive: act(r.bottomActive, bottom),
    topCollapsed: Boolean(r.topCollapsed),
    bottomCollapsed: Boolean(r.bottomCollapsed),
    split: clamp(r.split, 0.12, 0.88, fallback.split),
    rightWidth: clamp(r.rightWidth, 280, 720, fallback.rightWidth),
    showRight: r.showRight === undefined ? fallback.showRight : Boolean(r.showRight),
    timeline: r.timeline === undefined ? fallback.timeline : Boolean(r.timeline),
    timelineHeight: clamp(r.timelineHeight, 96, 420, fallback.timelineHeight),
  };
}

/** Open a panel: activate it where it is, or add it to the bottom group. */
export function openPanel(l: Layout, id: PanelId): Layout {
  if (l.top.includes(id)) return { ...l, topActive: id, topCollapsed: false, showRight: true };
  if (l.bottom.includes(id)) return { ...l, bottomActive: id, bottomCollapsed: false, showRight: true };
  return { ...l, bottom: [...l.bottom, id], bottomActive: id, bottomCollapsed: false, showRight: true };
}

export function closePanel(l: Layout, id: PanelId): Layout {
  const top = l.top.filter((x) => x !== id), bottom = l.bottom.filter((x) => x !== id);
  return {
    ...l, top, bottom,
    topActive: l.topActive === id ? top[0] ?? null : l.topActive,
    bottomActive: l.bottomActive === id ? bottom[0] ?? null : l.bottomActive,
  };
}

/** Dock a panel in the other group (Photoshop's drag-to-dock, as a command). */
export function movePanel(l: Layout, id: PanelId): Layout {
  const toBottom = l.top.includes(id);
  const removed = closePanel(l, id);
  return toBottom
    ? { ...removed, bottom: [...removed.bottom, id], bottomActive: id, bottomCollapsed: false }
    : { ...removed, top: [...removed.top, id], topActive: id, topCollapsed: false };
}

export type Prefs = {
  coordFormat: "sexagesimal" | "decimal";
  crosshair: boolean;
  grid: boolean;
  compass: boolean;
  timelineScale: TimeScale;
  hints: boolean;
};

export const DEFAULT_PREFS: Prefs = {
  coordFormat: "sexagesimal", crosshair: false, grid: false, compass: true, timelineScale: "time", hints: true,
};

export function sanitizePrefs(raw: unknown): Prefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Prefs>;
  return {
    coordFormat: r.coordFormat === "decimal" ? "decimal" : "sexagesimal",
    crosshair: Boolean(r.crosshair ?? DEFAULT_PREFS.crosshair),
    grid: Boolean(r.grid ?? DEFAULT_PREFS.grid),
    compass: Boolean(r.compass ?? DEFAULT_PREFS.compass),
    timelineScale: r.timelineScale === "index" ? "index" : "time",
    hints: Boolean(r.hints ?? DEFAULT_PREFS.hints),
  };
}

export type Persisted = { v: 1; workspace: WorkspaceId; layouts: Partial<Record<WorkspaceId, Layout>>; prefs: Prefs };

export const STORAGE_KEY = "deepfield-workstation-v1";

export function loadPersisted(): Persisted {
  const empty: Persisted = { v: 1, workspace: "default", layouts: {}, prefs: DEFAULT_PREFS };
  if (typeof window === "undefined") return empty;
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
    if (!raw || raw.v !== 1) return empty;
    const workspace = WORKSPACES.some((w) => w.id === raw.workspace) ? raw.workspace as WorkspaceId : "default";
    const layouts: Persisted["layouts"] = {};
    for (const w of WORKSPACES) {
      if (raw.layouts?.[w.id]) layouts[w.id] = sanitizeLayout(raw.layouts[w.id], presetLayout(w.id));
    }
    return { v: 1, workspace, layouts, prefs: sanitizePrefs(raw.prefs) };
  } catch {
    return empty;
  }
}

export function savePersisted(p: Persisted): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch { /* storage full or blocked */ }
}
