"use client";
// The analysis workstation: a presentation layer over the same data session, playback
// engine and frame renderer the Simple view uses. It adds arrangement (panels, layers,
// timeline), undo, and visibility into what is loading and cached -- not new science.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MODES, type FrameMode, toPlayFrames, usePlayback } from "@/components/SkyPlayer";
import { DEMO } from "@/lib/api";
import { CHANGE_DEFAULTS, type ChangeParams, cubeCacheEntries, getChangeMap } from "@/lib/sky";
import { useSkySession } from "@/lib/useSkySession";
import { changeKey, derivedCache } from "@/lib/workstation/derived";
import { canRedo, canUndo, commit, initHistory, jumpTo, redo as redoH, undo as undoH, type History } from "@/lib/workstation/history";
import {
  EMPTY_LAYER_DOC, buildLayerTree, configOf, moveLayer as moveLayerDoc, resolveLayers, setConfig,
} from "@/lib/workstation/layers";
import {
  type Layout, type Persisted, type Prefs, type WorkspaceId,
  loadPersisted, openPanel as openPanelL, presetLayout, savePersisted,
} from "@/lib/workstation/workspaces";
import {
  type ChangeRun, type DocState, type PB, PBContext, type Task, type Tool, type View, type ViewApi,
  ViewContext, type WS, WSContext,
} from "./context";
import { HelpOverlay, OptionsBar, StatusBar, ToolBar, TopBar, DocTabs } from "./chrome";
import { Dock } from "./Dock";
import { Stage } from "./Stage";
import { Timeline } from "./Timeline";

const DEFAULT_DOC: DocState = { layers: EMPTY_LAYER_DOC, pixel: null, radius: 1, ruler: null, change: CHANGE_DEFAULTS };
const IDLE_CHANGE: ChangeRun = { state: "idle", report: null, params: null, error: null, fromCache: false, ms: null };
const sameParams = (a: ChangeParams | null, b: ChangeParams) =>
  !!a && a.deg === b.deg && a.floor === b.floor && a.threshold === b.threshold;

export function Workstation() {
  const session = useSkySession();
  const { bundle } = session;
  const mode: FrameMode = MODES.some((m) => m.id === session.modeParam) ? session.modeParam : "visits";
  const frames = useMemo(() => (bundle ? toPlayFrames(bundle, mode) : []), [bundle, mode]);
  const playback = usePlayback(frames.length, `${mode}|${bundle?.slug ?? ""}`);
  const pb: PB = useMemo(() => ({ ...playback, n: frames.length, frame: frames[playback.i] }), [playback, frames]);

  // The workstation covers the page; stop the document behind it from scrolling.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // ---- workspace + preferences (localStorage) ------------------------------
  const [persist, setPersist] = useState<Persisted>(() => loadPersisted());
  useEffect(() => { savePersisted(persist); }, [persist]);
  const workspace = persist.workspace;
  const layout = persist.layouts[workspace] ?? presetLayout(workspace);
  const setLayout = useCallback((fn: (l: Layout) => Layout) => {
    setPersist((p) => ({ ...p, layouts: { ...p.layouts, [p.workspace]: fn(p.layouts[p.workspace] ?? presetLayout(p.workspace)) } }));
  }, []);
  const setWorkspace = useCallback((w: WorkspaceId) => setPersist((p) => ({ ...p, workspace: w })), []);
  const resetWorkspace = useCallback(() => setPersist((p) => {
    const layouts = { ...p.layouts };
    delete layouts[p.workspace];
    return { ...p, layouts };
  }), []);
  const setPrefs = useCallback((patch: Partial<Prefs>) => setPersist((p) => ({ ...p, prefs: { ...p.prefs, ...patch } })), []);
  const openPanel = useCallback((id: Parameters<typeof openPanelL>[1]) => setLayout((l) => openPanelL(l, id)), [setLayout]);

  // ---- document history ------------------------------------------------------
  const [history, setHistory] = useState<History<DocState>>(() => initHistory(DEFAULT_DOC));
  const doc = history.present.state;
  const identity = bundle ? `${bundle.slug}@${bundle.generated_at}` : `none:${session.qParam}|${session.raParam}|${session.decParam}`;
  useEffect(() => {
    setHistory(initHistory(DEFAULT_DOC, bundle ? `Open ${bundle.target?.name ?? bundle.slug}` : "Open view"));
  }, [identity]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = useCallback((fn: (d: DocState) => DocState, label: string, coalesceKey?: string) => {
    setHistory((h) => {
      const next = fn(h.present.state);
      return next === h.present.state ? h : commit(h, next, label, { coalesceKey });
    });
  }, []);
  const undo = useCallback(() => setHistory((h) => undoH(h)), []);
  const redo = useCallback(() => setHistory((h) => redoH(h)), []);
  const jump = useCallback((i: number) => setHistory((h) => jumpTo(h, i)), []);

  // ---- layers ----------------------------------------------------------------
  const tree = useMemo(() => (bundle ? buildLayerTree(bundle, session.overlay, mode, session.motion) : null),
    [bundle, session.overlay, mode, session.motion]);
  const layers = useMemo(() => (tree ? resolveLayers(tree, doc.layers) : []), [tree, doc.layers]);
  const layerMap = useMemo(() => new Map(layers.map((l) => [l.node.id, l])), [layers]);
  const layer = useCallback((id: string) => layerMap.get(id), [layerMap]);
  const [selected, select] = useState("frames");

  const setLayer = useCallback((id: string, patch: Partial<WS["doc"]["layers"]["config"][string]>, label: string, coalesceKey?: string) => {
    apply((d) => ({ ...d, layers: setConfig(d.layers, id, patch) }), label, coalesceKey);
  }, [apply]);
  const toggleLayer = useCallback((id: string) => {
    if (!tree) return;
    const c = configOf(tree, doc.layers, id);
    const name = layerMap.get(id)?.name ?? id;
    setLayer(id, { visible: !c.visible }, `${c.visible ? "Hide" : "Show"} ${name}`);
  }, [tree, doc.layers, layerMap, setLayer]);
  const moveLayer = useCallback((id: string, dir: -1 | 1) => {
    if (!tree) return;
    apply((d) => ({ ...d, layers: moveLayerDoc(tree, d.layers, id, dir) }), `Move ${layerMap.get(id)?.name ?? id} ${dir < 0 ? "up" : "down"}`);
  }, [tree, apply, layerMap]);

  const pick = useCallback((p: { x: number; y: number } | null) => {
    apply((d) => ({ ...d, pixel: p }), p ? `Probe (${p.x}, ${p.y})` : "Clear probe");
  }, [apply]);
  const setRadius = useCallback((r: number) => {
    const rr = Math.max(0, Math.min(3, Math.round(r)));
    apply((d) => ({ ...d, radius: rr }), `Aperture ${2 * rr + 1}×${2 * rr + 1}`, "radius");
  }, [apply]);
  const setRuler = useCallback((r: DocState["ruler"]) => {
    apply((d) => ({ ...d, ruler: r }), r ? "Measure" : "Clear measurement");
  }, [apply]);

  // ---- change detection (derived, cached by identity) ------------------------
  const [change, setChange] = useState<ChangeRun>(IDLE_CHANGE);
  const runToken = useRef(0);
  useEffect(() => {
    runToken.current++;
    setChange(IDLE_CHANGE);
  }, [identity]);

  const runChangeWith = useCallback(async (params: ChangeParams) => {
    if (!bundle) return;
    const token = ++runToken.current;
    const key = changeKey(bundle, params, DEMO);
    const hit = derivedCache.get(key);
    if (hit) {
      setChange({ state: "ready", report: hit as ChangeRun["report"], params, error: null, fromCache: true, ms: 0 });
      return;
    }
    setChange((c) => ({ ...c, state: "running", error: null }));
    const t0 = performance.now();
    try {
      const report = await getChangeMap(bundle, DEMO ? params : undefined);
      const ms = Math.round(performance.now() - t0);
      derivedCache.set(key, report, ms);
      if (token !== runToken.current) { setChange((c) => (c.state === "running" ? { ...c, state: "cancelled" } : c)); return; }
      setChange({ state: "ready", report, params, error: null, fromCache: false, ms });
    } catch (e) {
      if (token !== runToken.current) return;
      setChange({ ...IDLE_CHANGE, state: "error", error: String((e as Error).message || e) });
    }
  }, [bundle]);

  const runChange = useCallback(() => {
    void runChangeWith(doc.change);
    if (tree && !configOf(tree, doc.layers, "change").visible) {
      setLayer("change", { visible: true }, "Show change detection");
    }
  }, [runChangeWith, doc.change, doc.layers, tree, setLayer]);

  // Editing a parameter (or undoing an edit) re-runs only this step: nothing is downstream of it.
  useEffect(() => {
    if (change.report && change.state === "ready" && !sameParams(change.params, doc.change)) void runChangeWith(doc.change);
  }, [doc.change, change, runChangeWith]);

  const setChangeParams = useCallback((p: Partial<ChangeParams>) => {
    const k = Object.keys(p)[0] ?? "param";
    apply((d) => ({ ...d, change: { ...d.change, ...p } }), `Change detection: ${k}`, `change-${k}`);
  }, [apply]);

  const clearLayer = useCallback((id: string) => {
    if (id === "probe") pick(null);
    else if (id === "measure") setRuler(null);
    else if (id === "change") { runToken.current++; setChange(IDLE_CHANGE); }
  }, [pick, setRuler]);

  // ---- frames loaded (the browser's decode of each PNG) ----------------------
  const [loadedSet, setLoadedSet] = useState<Set<string>>(() => new Set());
  const slug = bundle?.slug ?? "";
  const onFrameLoad = useCallback((_id: string, src: string) => {
    const k = `${slug}|${src}`;
    setLoadedSet((s) => (s.has(k) ? s : new Set(s).add(k)));
  }, [slug]);
  const loaded = useMemo(() => ({
    count: frames.filter((f) => loadedSet.has(`${slug}|${f.png}`)).length, total: frames.length,
  }), [frames, loadedSet, slug]);

  // ---- tools / prefs ---------------------------------------------------------
  const [tool, setTool] = useState<Tool>("probe");
  const [showHelp, setShowHelp] = useState(false);
  const setMode = useCallback((m: FrameMode) => session.setUrl({ mode: m }), [session]);

  // ---- tasks: one honest list of what is happening ---------------------------
  const [cubeTick, setCubeTick] = useState(0);
  useEffect(() => {
    if (!bundle) return;
    const id = setInterval(() => setCubeTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [bundle]);
  const tasks = useMemo<Task[]>(() => {
    void cubeTick;
    const out: Task[] = [];
    if (session.busy) out.push({ id: "load", label: session.status ?? "Loading view", state: "loading" });
    if (session.error) out.push({ id: "error", label: session.error, state: "failed" });
    const j = session.job;
    if (j) {
      const st = j.state === "queued" ? "queued" : j.state === "running" ? "processing" : j.state === "error" ? "failed" : "completed";
      out.push({ id: "job", label: "Build view from IRSA", state: st,
        detail: j.n_total ? `${j.n_done}/${j.n_total} images` : j.message, progress: j.progress });
    }
    if (bundle && loaded.total) {
      out.push({ id: "frames", label: `Decode ${loaded.total} frames`, state: loaded.count < loaded.total ? "rendering" : "completed",
        detail: `${loaded.count}/${loaded.total}`, progress: loaded.count / loaded.total });
    }
    const cube = bundle ? cubeCacheEntries().find((c) => c.slug === bundle.slug) : undefined;
    if (cube) {
      out.push({ id: "cube", label: "Pixel cube", state: cube.state === "loading" ? "loading" : cube.state === "error" ? "failed" : "cached",
        detail: cube.state === "error" ? cube.error ?? "" : cube.bytes ? `${(cube.bytes / 1048576).toFixed(1)} MB in memory` : "" });
    }
    if (change.state !== "idle") {
      out.push({ id: "change", label: "Change detection",
        state: change.state === "running" ? "processing" : change.state === "error" ? "failed"
          : change.state === "cancelled" ? "cancelled" : change.fromCache ? "cached" : "completed",
        detail: change.error ?? (change.report ? `${change.report.peaks.length} peaks${change.ms ? ` · ${change.ms} ms` : ""}` : "") });
    }
    return out;
  }, [session.busy, session.status, session.error, session.job, bundle, loaded, change, cubeTick]);

  // ---- viewport --------------------------------------------------------------
  const [view, setView] = useState<View>({ scale: 1, panX: 0, panY: 0, fitted: true });
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const npix = bundle?.npix ?? 0;
  const fitScale = useCallback((vp: { w: number; h: number }) =>
    npix ? Math.max(0.25, (Math.min(vp.w, vp.h) * 0.9) / npix) : 1, [npix]);
  const fit = useCallback(() => setView({ scale: fitScale(viewport), panX: 0, panY: 0, fitted: true }), [fitScale, viewport]);
  const actual = useCallback(() => setView({ scale: 1, panX: 0, panY: 0, fitted: false }), []);
  const zoomBy = useCallback((factor: number, at?: { x: number; y: number }) => {
    setView((v) => {
      const scale = Math.max(0.25, Math.min(96, v.scale * factor));
      if (!npix || scale === v.scale) return v;
      const ax = at?.x ?? viewport.w / 2, ay = at?.y ?? viewport.h / 2;
      const W = npix * v.scale, W2 = npix * scale;
      const left = viewport.w / 2 + v.panX - W / 2, top = viewport.h / 2 + v.panY - W / 2;
      const fx = (ax - left) / W, fy = (ay - top) / W;
      return { scale, panX: ax - fx * W2 - viewport.w / 2 + W2 / 2, panY: ay - fy * W2 - viewport.h / 2 + W2 / 2, fitted: false };
    });
  }, [npix, viewport]);
  // Stay fitted while the window or the field changes, until the user zooms.
  useEffect(() => {
    if (view.fitted && viewport.w && npix) {
      const s = fitScale(viewport);
      if (Math.abs(s - view.scale) > 1e-6 || view.panX || view.panY) setView({ scale: s, panX: 0, panY: 0, fitted: true });
    }
  }, [viewport, npix, view, fitScale]);
  const viewApi: ViewApi = useMemo(() => ({ view, setView, viewport, setViewport, fit, actual, zoomBy }),
    [view, viewport, fit, actual, zoomBy]);

  // ---- context ---------------------------------------------------------------
  const ws: WS = useMemo(() => ({
    session, bundle, mode, setMode, frames, tree, layers, layer,
    doc, history, apply, undo, redo, jump,
    selected, select, setLayer, toggleLayer, moveLayer, clearLayer,
    pick, setRadius, setRuler,
    change, runChange, setChangeParams,
    tool, setTool, prefs: persist.prefs, setPrefs, workspace, setWorkspace, resetWorkspace, layout, setLayout, openPanel,
    loaded, onFrameLoad, tasks, showHelp, setShowHelp,
  }), [session, bundle, mode, setMode, frames, tree, layers, layer, doc, history, apply, undo, redo, jump,
    selected, setLayer, toggleLayer, moveLayer, clearLayer, pick, setRadius, setRuler, change, runChange,
    setChangeParams, tool, persist.prefs, setPrefs, workspace, setWorkspace, resetWorkspace, layout, setLayout,
    openPanel, loaded, onFrameLoad, tasks, showHelp]);

  // ---- keyboard --------------------------------------------------------------
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) {
      if (e.key === "Escape") t.blur();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (mod && (k === "z" || k === "Z")) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && (k === "y" || k === "Y")) { e.preventDefault(); redo(); return; }
    if (mod || e.altKey) return;
    // Space toggles playback unless a button has focus, where space means "press".
    if (k === " ") { if (t?.tagName === "BUTTON") return; e.preventDefault(); pb.toggle(); return; }
    if (k === "ArrowRight") { e.preventDefault(); pb.step(1); return; }
    if (k === "ArrowLeft") { e.preventDefault(); pb.step(-1); return; }
    if (k === "Home") { e.preventDefault(); pb.seek(0); return; }
    if (k === "End") { e.preventDefault(); pb.seek(pb.n - 1); return; }
    if (k === "Escape") { setShowHelp(false); return; }
    if (k === "?") { setShowHelp((v) => !v); return; }
    const low = k.toLowerCase();
    if (/^[1-5]$/.test(k)) { const m = MODES[Number(k) - 1]; if (m) setMode(m.id); return; }
    if (low === "h") setTool("hand");
    else if (low === "z") setTool("zoom");
    else if (low === "i") setTool("probe");
    else if (low === "m") setTool("measure");
    else if (low === "l") pb.setLoop(!pb.loop);
    else if (low === "f") fit();
    else if (k === "0") actual();
    else if (k === "+" || k === "=") zoomBy(1.25);
    else if (k === "-" || k === "_") zoomBy(0.8);
    else if (k === "[") setRadius(doc.radius - 1);
    else if (k === "]") setRadius(doc.radius + 1);
    else if (low === "x") setPrefs({ crosshair: !persist.prefs.crosshair });
    else if (low === "g") setPrefs({ grid: !persist.prefs.grid });
    else if (low === "d") { if (bundle) runChange(); }
    else if (k === "\\") setLayout((l) => ({ ...l, showRight: !l.showRight }));
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  return (
    <WSContext.Provider value={ws}>
      <PBContext.Provider value={pb}>
        <ViewContext.Provider value={viewApi}>
          <div className="fixed inset-0 z-40 flex flex-col bg-ws-bg text-[12px] text-ws-fg antialiased">
            <TopBar canUndo={canUndo(history)} canRedo={canRedo(history)} />
            <OptionsBar />
            <div className="flex min-h-0 flex-1">
              <ToolBar />
              <div className="flex min-w-0 flex-1 flex-col border-l border-ws-edge">
                <DocTabs />
                <Stage />
                {layout.timeline ? (
                  <>
                    <Splitter dir="row" onDrag={(d) => setLayout((l) => ({ ...l, timelineHeight: Math.max(96, Math.min(420, l.timelineHeight - d)) }))} />
                    <div style={{ height: layout.timelineHeight }} className="shrink-0">
                      <Timeline />
                    </div>
                  </>
                ) : null}
              </div>
              {layout.showRight ? (
                <>
                  <Splitter dir="col" onDrag={(d) => setLayout((l) => ({ ...l, rightWidth: Math.max(280, Math.min(720, l.rightWidth - d)) }))} />
                  <div style={{ width: layout.rightWidth }} className="flex shrink-0 flex-col">
                    <Dock />
                  </div>
                </>
              ) : null}
            </div>
            <StatusBar />
            {showHelp ? <HelpOverlay onClose={() => setShowHelp(false)} /> : null}
          </div>
        </ViewContext.Provider>
      </PBContext.Provider>
    </WSContext.Provider>
  );
}

/** A drag handle between regions. Reports movement in pixels since the last event. */
export function Splitter({ dir, onDrag }: { dir: "row" | "col"; onDrag: (delta: number) => void }) {
  const last = useRef<number | null>(null);
  return (
    <div role="separator" aria-orientation={dir === "row" ? "horizontal" : "vertical"}
      onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); last.current = dir === "row" ? e.clientY : e.clientX; }}
      onPointerMove={(e) => {
        if (last.current === null) return;
        const p = dir === "row" ? e.clientY : e.clientX;
        onDrag(p - last.current);
        last.current = p;
      }}
      onPointerUp={() => { last.current = null; }}
      className={dir === "row"
        ? "h-[5px] shrink-0 cursor-row-resize border-y border-ws-edge bg-ws-bg hover:bg-ws-sel/40"
        : "w-[5px] shrink-0 cursor-col-resize border-x border-ws-edge bg-ws-bg hover:bg-ws-sel/40"} />
  );
}
