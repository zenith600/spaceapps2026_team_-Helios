"use client";
// Shared state for the workstation, split in three so that fast-changing state does not
// re-render everything: the playback index ticks up to 10x a second, and the viewport
// changes on every pan; neither should re-run the spectrum plot.
import { createContext, useContext, useSyncExternalStore } from "react";
import type { FrameMode, PlayFrame, usePlayback } from "@/components/SkyPlayer";
import type { ChangeParams, ChangeReport, SkyBundle } from "@/lib/sky";
import type { SkySession } from "@/lib/useSkySession";
import type { History } from "@/lib/workstation/history";
import type { LayerConfig, LayerDoc, LayerTree, ResolvedLayer } from "@/lib/workstation/layers";
import type { Layout, PanelId, Prefs, WorkspaceId } from "@/lib/workstation/workspaces";
import type { TaskState } from "./ui";

export type Pixel = { x: number; y: number };
export type Ruler = { a: Pixel; b: Pixel };

/** Everything undo/redo covers. Navigation (field, mode) lives in the URL instead. */
export type DocState = {
  layers: LayerDoc;
  pixel: Pixel | null;
  radius: number;
  ruler: Ruler | null;
  change: ChangeParams;
};

export type Tool = "hand" | "zoom" | "probe" | "measure";

export type ChangeRun = {
  state: "idle" | "running" | "ready" | "error" | "cancelled";
  report: ChangeReport | null;
  params: ChangeParams | null;
  error: string | null;
  fromCache: boolean;
  ms: number | null;
};

export type Task = { id: string; label: string; state: TaskState; detail?: string; progress?: number };

export type WS = {
  session: SkySession;
  bundle: SkyBundle | null;
  mode: FrameMode;
  setMode: (m: FrameMode) => void;
  frames: PlayFrame[];
  tree: LayerTree | null;
  layers: ResolvedLayer[];
  layer: (id: string) => ResolvedLayer | undefined;

  doc: DocState;
  history: History<DocState>;
  apply: (fn: (d: DocState) => DocState, label: string, coalesceKey?: string) => void;
  undo: () => void;
  redo: () => void;
  jump: (index: number) => void;

  selected: string;
  select: (id: string) => void;
  setLayer: (id: string, patch: Partial<LayerConfig>, label: string, coalesceKey?: string) => void;
  toggleLayer: (id: string) => void;
  moveLayer: (id: string, dir: -1 | 1) => void;
  clearLayer: (id: string) => void;

  pick: (p: Pixel | null) => void;
  setRadius: (r: number) => void;
  setRuler: (r: Ruler | null) => void;

  change: ChangeRun;
  runChange: () => void;
  setChangeParams: (p: Partial<ChangeParams>) => void;

  tool: Tool;
  setTool: (t: Tool) => void;
  prefs: Prefs;
  setPrefs: (p: Partial<Prefs>) => void;
  workspace: WorkspaceId;
  setWorkspace: (w: WorkspaceId) => void;
  resetWorkspace: () => void;
  layout: Layout;
  setLayout: (fn: (l: Layout) => Layout) => void;
  openPanel: (id: PanelId) => void;

  loaded: { count: number; total: number };
  onFrameLoad: (id: string, src: string) => void;
  tasks: Task[];
  showHelp: boolean;
  setShowHelp: (v: boolean) => void;
};

export type PB = ReturnType<typeof usePlayback> & { n: number; frame: PlayFrame | undefined };

export type View = { scale: number; panX: number; panY: number; fitted: boolean };
export type ViewApi = {
  view: View;
  setView: (fn: (v: View) => View) => void;
  viewport: { w: number; h: number };
  setViewport: (vp: { w: number; h: number }) => void;
  fit: () => void;
  actual: () => void;
  zoomBy: (factor: number, at?: { x: number; y: number }) => void;
};

export const WSContext = createContext<WS | null>(null);
export const PBContext = createContext<PB | null>(null);
export const ViewContext = createContext<ViewApi | null>(null);

export function useWS(): WS {
  const v = useContext(WSContext);
  if (!v) throw new Error("useWS outside the workstation");
  return v;
}
export function usePB(): PB {
  const v = useContext(PBContext);
  if (!v) throw new Error("usePB outside the workstation");
  return v;
}
export function useView(): ViewApi {
  const v = useContext(ViewContext);
  if (!v) throw new Error("useView outside the workstation");
  return v;
}

// ---------------------------------------------------------------------------
// The cursor moves on every mousemove; it is a tiny external store so only the readouts
// that show it re-render.
// ---------------------------------------------------------------------------
export type Cursor = { x: number; y: number; ra: number; dec: number; flux: number | null; inside: boolean } | null;

let cursor: Cursor = null;
const cursorListeners = new Set<() => void>();
export function setCursor(c: Cursor) {
  cursor = c;
  for (const fn of cursorListeners) fn();
}
export function useCursor(): Cursor {
  return useSyncExternalStore(
    (fn) => { cursorListeners.add(fn); return () => { cursorListeners.delete(fn); }; },
    () => cursor, () => null);
}
