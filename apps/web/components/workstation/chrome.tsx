"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Check, ChevronDown, Circle, Crosshair, Grid3x3, Hand, Keyboard, Link as LinkIcon, LoaderCircle, Maximize,
  Pentagon, Pipette, Radar, Redo2, Route, Ruler, Settings, Square, Type, Undo2, X, ZoomIn, ZoomOut, Compass,
} from "lucide-react";
import { MODES } from "@/components/SkyPlayer";
import { DEMO } from "@/lib/api";
import { formatDec, formatRa } from "@/lib/sky";
import { ZOOMS } from "@/lib/useSkySession";
import { cn } from "@/lib/utils";
import { formatArcsec, measure } from "@/lib/workstation/measure";
import { readHeap } from "@/lib/workstation/perf";
import { PANELS, WORKSPACES } from "@/lib/workstation/workspaces";
import { type Tool, useCursor, usePB, useView, useWS } from "./context";
import { IconBtn, Menu, MenuItem, MenuLabel, MenuSep, Select, STATE_STYLE, StateChip, type TaskState, TextBtn } from "./ui";

const MODULES = [
  { href: "/sky", label: "Sky Workstation" },
  { href: "/", label: "The Hunt" },
  { href: "/lab", label: "Candidate Lab" },
  { href: "/classify", label: "Classify" },
  { href: "/proof", label: "Proof" },
];

/** Most urgent first, so the top bar shows what the user most needs to know. */
const PRIORITY: TaskState[] = ["failed", "processing", "queued", "loading", "rendering", "cancelled", "cached", "completed"];

export function fmtCoord(ra: number, dec: number, f: "sexagesimal" | "decimal") {
  return f === "decimal" ? `${ra.toFixed(5)}°  ${dec >= 0 ? "+" : ""}${dec.toFixed(5)}°` : `${formatRa(ra)}  ${formatDec(dec)}`;
}

// ---------------------------------------------------------------------------
export function TopBar({ canUndo, canRedo }: { canUndo: boolean; canRedo: boolean }) {
  const ws = useWS();
  const s = ws.session;
  const b = ws.bundle;
  const [copied, setCopied] = useState(false);
  const top = [...ws.tasks].sort((x, y) => PRIORITY.indexOf(x.state) - PRIORITY.indexOf(y.state))[0];
  const active = top && ["failed", "processing", "queued", "loading", "rendering"].includes(top.state) ? top : null;

  const copy = async () => {
    try { await navigator.clipboard.writeText(window.location.href); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard blocked: the address bar still has it */ }
  };

  return (
    <header className="flex h-9 shrink-0 items-center gap-2 border-b border-ws-edge bg-ws-bg px-2">
      <Link href="/sky" onClick={() => s.clear()} className="flex items-center gap-1.5 pr-1" title="Deep Field — all targets">
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
          <circle cx="9" cy="9" r="7.5" fill="none" stroke="var(--color-accent)" strokeWidth="1.4" />
          <circle cx="9" cy="9" r="3.2" fill="none" stroke="var(--color-accent)" strokeWidth="1.2" opacity="0.7" />
          <circle cx="9" cy="9" r="1" fill="var(--color-accent)" />
        </svg>
        <span className="text-[12.5px] font-semibold tracking-tight">Deep Field</span>
      </Link>

      <Menu trigger={(o) => <MenuButton open={o}>Modules</MenuButton>}>
        {(close) => MODULES.map((m) => (
          <Link key={m.href} href={m.href} onClick={close}
            className="flex items-center gap-2 px-2.5 py-1 text-[11.5px] text-ws-fg hover:bg-ws-selbg">
            <span className="w-3 text-ws-sel">{m.href === "/sky" ? "✓" : ""}</span>{m.label}
          </Link>
        ))}
      </Menu>
      <WindowMenu />

      <div className="mx-2 h-4 w-px bg-ws-line" />
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-[12px] font-medium" title="Current field">{s.target?.name ?? (s.qParam || "No field open")}</span>
        {b ? (
          <span className="mono hidden truncate text-[10.5px] text-ws-muted xl:inline" title="Dataset identifier (bundle slug) and the SPHEREx collections it was built from">
            {b.slug} · {b.search.collections_searched.join("+")}
          </span>
        ) : null}
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        {active ? (
          <span className="flex max-w-[260px] items-center gap-1.5 truncate text-[11px]" title={active.detail ?? active.label}>
            {["processing", "loading", "rendering", "queued"].includes(active.state)
              ? <LoaderCircle size={12} className={cn("animate-spin", STATE_STYLE[active.state].text)} /> : <StateChip state={active.state} compact />}
            <span className={STATE_STYLE[active.state].text}>{STATE_STYLE[active.state].label}</span>
            <span className="truncate text-ws-muted">{active.label}{active.detail ? ` · ${active.detail}` : ""}</span>
          </span>
        ) : b ? <span className="flex items-center gap-1 text-[11px] text-ws-muted"><StateChip state="completed" compact /> Ready</span> : null}

        <div className="mx-1 h-4 w-px bg-ws-line" />
        <button onClick={copy} disabled={!b}
          title="Field, mode and field of view are all in the address: copy it to share or bookmark exactly this view. Layer settings are not saved."
          className="flex h-6 items-center gap-1 rounded-[3px] px-1.5 text-[11px] text-ws-muted hover:bg-ws-hover hover:text-ws-fg disabled:opacity-30">
          {copied ? <Check size={13} className="text-ws-ok" /> : <LinkIcon size={13} />}
          {copied ? "Copied" : "View in URL"}
        </button>
        <IconBtn icon={Undo2} label={canUndo ? `Undo ${ws.history.present.label}` : "Nothing to undo"} shortcut="Ctrl+Z" disabled={!canUndo} onClick={ws.undo} />
        <IconBtn icon={Redo2} label={canRedo ? `Redo ${ws.history.future[0]?.label}` : "Nothing to redo"} shortcut="Ctrl+Shift+Z" disabled={!canRedo} onClick={ws.redo} />
        <div className="mx-1 h-4 w-px bg-ws-line" />
        <Select label="Workspace" value={ws.workspace} className="w-[150px]"
          options={WORKSPACES.map((w) => ({ value: w.id, label: w.label }))} onChange={ws.setWorkspace} />
        <SettingsMenu />
        <IconBtn icon={Keyboard} label="Keyboard shortcuts" shortcut="?" onClick={() => ws.setShowHelp(true)} />
        <button onClick={() => s.setUrl({ ui: "simple" })} title="The original single-page viewer"
          className="ml-1 h-6 rounded-[3px] border border-ws-line px-2 text-[11px] text-ws-muted hover:text-ws-fg">Simple view</button>
      </div>
    </header>
  );
}

function MenuButton({ children, open }: { children: React.ReactNode; open: boolean }) {
  return (
    <button type="button" className={cn("flex h-6 items-center gap-0.5 rounded-[3px] px-1.5 text-[11.5px] text-ws-muted hover:bg-ws-hover hover:text-ws-fg",
      open && "bg-ws-hover text-ws-fg")}>
      {children}<ChevronDown size={11} />
    </button>
  );
}

function WindowMenu() {
  const ws = useWS();
  const l = ws.layout;
  const isOpen = (id: string) => (l.top as string[]).includes(id) || (l.bottom as string[]).includes(id);
  return (
    <Menu trigger={(o) => <MenuButton open={o}>Window</MenuButton>} width={250}>
      {(close) => (
        <>
          <MenuLabel>Panels</MenuLabel>
          {PANELS.map((p) => (
            <MenuItem key={p.id} checked={isOpen(p.id)} title={p.hint} onClick={() => { ws.openPanel(p.id); close(); }}>{p.title}</MenuItem>
          ))}
          <MenuSep />
          <MenuItem checked={l.showRight} hint="\" onClick={() => { ws.setLayout((x) => ({ ...x, showRight: !x.showRight })); close(); }}>Panel dock</MenuItem>
          <MenuItem checked={l.timeline} onClick={() => { ws.setLayout((x) => ({ ...x, timeline: !x.timeline })); close(); }}>Timeline</MenuItem>
          <MenuSep />
          <MenuLabel>Workspace</MenuLabel>
          {WORKSPACES.map((w) => (
            <MenuItem key={w.id} checked={ws.workspace === w.id} title={w.hint} onClick={() => { ws.setWorkspace(w.id); close(); }}>{w.label}</MenuItem>
          ))}
          <MenuItem onClick={() => { ws.resetWorkspace(); close(); }}>Reset “{WORKSPACES.find((w) => w.id === ws.workspace)?.label}”</MenuItem>
        </>
      )}
    </Menu>
  );
}

function SettingsMenu() {
  const ws = useWS();
  const p = ws.prefs;
  return (
    <Menu align="right" width={240} trigger={() => <IconBtn icon={Settings} label="Settings" />}>
      {() => (
        <>
          <MenuLabel>Coordinates</MenuLabel>
          <MenuItem checked={p.coordFormat === "sexagesimal"} onClick={() => ws.setPrefs({ coordFormat: "sexagesimal" })}>Sexagesimal (hms / dms)</MenuItem>
          <MenuItem checked={p.coordFormat === "decimal"} onClick={() => ws.setPrefs({ coordFormat: "decimal" })}>Decimal degrees</MenuItem>
          <MenuSep />
          <MenuLabel>Canvas</MenuLabel>
          <MenuItem checked={p.crosshair} hint="X" onClick={() => ws.setPrefs({ crosshair: !p.crosshair })}>Crosshair</MenuItem>
          <MenuItem checked={p.grid} hint="G" onClick={() => ws.setPrefs({ grid: !p.grid })}>Pixel grid (when zoomed in)</MenuItem>
          <MenuItem checked={p.compass} onClick={() => ws.setPrefs({ compass: !p.compass })}>Compass</MenuItem>
          <MenuItem checked={p.hints} onClick={() => ws.setPrefs({ hints: !p.hints })}>Hints</MenuItem>
          <MenuSep />
          <div className="px-2.5 py-1 text-[10.5px] leading-snug text-ws-dim">
            Layout and these settings are kept in this browser only. {DEMO ? "Serving ready-made views (no server)." : "Connected to the live API."}
          </div>
        </>
      )}
    </Menu>
  );
}

// ---------------------------------------------------------------------------
export function OptionsBar() {
  const ws = useWS();
  const { view, zoomBy, fit, actual } = useView();
  const b = ws.bundle;
  const r = ws.doc.radius;
  const ToolIcon = TOOL_ICON[ws.tool];
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-ws-edge bg-ws-panel px-2 text-[11px]">
      <span className="flex w-[104px] items-center gap-1.5 text-ws-fg">
        <ToolIcon size={14} strokeWidth={1.75} />{TOOLS.find((t) => t.id === ws.tool)?.label}
      </span>
      <div className="h-4 w-px bg-ws-line" />
      {ws.tool === "probe" ? (
        <>
          <span className="text-ws-muted">Aperture</span>
          <Select label="Spectrum aperture" value={r} onChange={ws.setRadius}
            options={[0, 1, 2, 3].map((k) => ({ value: k, label: ["1 pixel", "3 × 3", "5 × 5", "7 × 7"][k] }))} />
          <span className="text-ws-dim" title="Photoshop-style brush-size keys">[ ]</span>
          {ws.doc.pixel ? (
            <>
              <span className="mono text-ws-fg">({ws.doc.pixel.x}, {ws.doc.pixel.y})</span>
              <TextBtn onClick={() => ws.pick(null)}>Clear</TextBtn>
            </>
          ) : <span className="text-ws-muted">Click a pixel to build its spectrum from every exposure.</span>}
        </>
      ) : ws.tool === "measure" ? (
        ws.doc.ruler && b ? (() => {
          const m = measure(b, ws.doc.ruler.a, ws.doc.ruler.b);
          return (
            <>
              <span className="mono text-ws-fg">{formatArcsec(m.arcsec)}</span>
              <span className="mono text-ws-muted">{m.pixels.toFixed(2)} px · Δx {m.dx.toFixed(2)} Δy {m.dy.toFixed(2)} · PA {m.pa_deg.toFixed(1)}° E of N</span>
              <TextBtn onClick={() => ws.setRuler(null)}>Clear</TextBtn>
            </>
          );
        })() : <span className="text-ws-muted">Drag between two points for their separation and position angle.</span>
      ) : ws.tool === "hand" ? (
        <span className="text-ws-muted">Drag to pan · double-click to fit · middle-drag pans with any tool.</span>
      ) : (
        <span className="text-ws-muted">Click to zoom in · Alt-click to zoom out · scroll wheel zooms at the cursor.</span>
      )}

      <div className="ml-auto flex items-center gap-1">
        <IconBtn icon={ZoomOut} label="Zoom out" shortcut="−" onClick={() => zoomBy(0.8)} disabled={!b} />
        <span className="mono w-[52px] text-center text-ws-fg" title="Screen pixels per image pixel × 100">{b ? `${Math.round(view.scale * 100)}%` : "—"}</span>
        <IconBtn icon={ZoomIn} label="Zoom in" shortcut="+" onClick={() => zoomBy(1.25)} disabled={!b} />
        <TextBtn onClick={fit} disabled={!b} active={view.fitted} title="Fit to screen (F)"><Maximize size={11} />Fit</TextBtn>
        <TextBtn onClick={actual} disabled={!b} title="Actual pixels: one image pixel per screen pixel (0)">100%</TextBtn>
        <div className="mx-1 h-4 w-px bg-ws-line" />
        <IconBtn icon={Crosshair} label="Crosshair" shortcut="X" active={ws.prefs.crosshair} onClick={() => ws.setPrefs({ crosshair: !ws.prefs.crosshair })} />
        <IconBtn icon={Grid3x3} label="Pixel grid" shortcut="G" active={ws.prefs.grid} onClick={() => ws.setPrefs({ grid: !ws.prefs.grid })} />
        <IconBtn icon={Compass} label="Compass and scale bar" active={ws.prefs.compass} onClick={() => ws.setPrefs({ compass: !ws.prefs.compass })} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
const TOOLS: { id: Tool; label: string; key: string; icon: typeof Hand; hint: string }[] = [
  { id: "hand", label: "Pan", key: "H", icon: Hand, hint: "Drag to move around the image" },
  { id: "zoom", label: "Zoom", key: "Z", icon: ZoomIn, hint: "Click to zoom in, Alt-click to zoom out" },
  { id: "probe", label: "Spectral probe", key: "I", icon: Pipette, hint: "Click a pixel for its spectrum, built from every exposure" },
  { id: "measure", label: "Measure", key: "M", icon: Ruler, hint: "Angular separation and position angle" },
];
const TOOL_ICON = Object.fromEntries(TOOLS.map((t) => [t.id, t.icon])) as Record<Tool, typeof Hand>;

/**
 * Extension points: shown so the toolbar's shape is stable, but disabled and labelled,
 * because no part of the pipeline consumes these yet. Each names what it would need.
 */
const PLANNED: { label: string; icon: typeof Hand; why: string }[] = [
  { label: "Rectangle region", icon: Square, why: "needs a region-statistics or region-spectrum operation; spectra currently take a square aperture around one pixel (the probe)" },
  { label: "Ellipse region", icon: Circle, why: "needs a region operation in the API and the in-browser cube decoder" },
  { label: "Polygon region", icon: Pentagon, why: "needs a region operation in the API and the in-browser cube decoder" },
  { label: "Annotation", icon: Type, why: "needs somewhere to store notes; views are shared by URL and have no project storage" },
  { label: "Object tracking", icon: Route, why: "needs a source-detection and track-fitting step; change detection finds where pixels vary, not tracks" },
];

export function ToolBar() {
  const ws = useWS();
  const changeOn = ws.change.state === "ready" && ws.layer("change")?.shown;
  return (
    <nav aria-label="Tools" className="flex w-10 shrink-0 flex-col items-center gap-0.5 bg-ws-panel py-1.5">
      {TOOLS.map((t) => (
        <ToolButton key={t.id} active={ws.tool === t.id} onClick={() => ws.setTool(t.id)}
          label={`${t.label} (${t.key}) — ${t.hint}`} icon={t.icon} />
      ))}
      <div className="my-1 h-px w-6 bg-ws-line" />
      <ToolButton icon={Radar} label={`Change detection (D) — score every pixel against “nothing happened here”${ws.change.state === "running" ? " · running" : ""}`}
        active={Boolean(changeOn)} busy={ws.change.state === "running"} disabled={!ws.bundle}
        onClick={() => {
          if (ws.change.state === "ready") ws.toggleLayer("change"); else ws.runChange();
        }} />
      <div className="my-1 h-px w-6 bg-ws-line" />
      {PLANNED.map((p) => (
        <ToolButton key={p.label} icon={p.icon} disabled label={`${p.label} — not available: ${p.why}.`} planned />
      ))}
    </nav>
  );
}

function ToolButton({ icon: Icon, label, active, onClick, disabled, planned, busy }: {
  icon: typeof Hand; label: string; active?: boolean; onClick?: () => void; disabled?: boolean; planned?: boolean; busy?: boolean;
}) {
  return (
    // Disabled tools still need a tooltip, so they are aria-disabled rather than disabled.
    <button type="button" aria-label={label} title={label} aria-pressed={active} aria-disabled={disabled}
      onClick={disabled ? undefined : onClick}
      className={cn("relative flex h-8 w-8 items-center justify-center rounded-[3px] transition-colors",
        active ? "bg-ws-selbg text-ws-fg ring-1 ring-inset ring-ws-sel/60" : "text-ws-muted hover:bg-ws-hover hover:text-ws-fg",
        disabled && "cursor-not-allowed opacity-30 hover:bg-transparent hover:text-ws-muted")}>
      {busy ? <LoaderCircle size={16} className="animate-spin text-ws-warn" /> : <Icon size={16} strokeWidth={1.6} />}
      {planned ? <span className="absolute bottom-0.5 right-0.5 h-1 w-1 rounded-full bg-ws-dim" /> : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
export function DocTabs() {
  const ws = useWS();
  const b = ws.bundle;
  if (!b) return <div className="h-7 shrink-0 border-b border-ws-edge bg-ws-bg" />;
  const count = (id: string) =>
    id === "difference" ? b.difference.length : id === "visits" ? b.frames.visits.length
      : id === "detectors" ? b.frames.detectors.length : id === "colour" ? (b.frames.colour?.length ?? 0) : b.frames.epochs.length;
  return (
    <div className="flex h-7 shrink-0 items-end gap-px border-b border-ws-edge bg-ws-bg pl-1" role="tablist" aria-label="Frame sequence">
      {MODES.map((m, k) => {
        const n = count(m.id);
        const on = ws.mode === m.id;
        return (
          <button key={m.id} role="tab" aria-selected={on} disabled={n === 0} onClick={() => ws.setMode(m.id)}
            title={`${m.hint}  (${k + 1})`}
            className={cn("flex h-[26px] items-center gap-1.5 rounded-t-[3px] border border-b-0 px-3 text-[11.5px] disabled:opacity-30",
              on ? "border-ws-line bg-ws-canvas text-ws-fg" : "border-transparent text-ws-muted hover:bg-ws-panel hover:text-ws-fg")}>
            {m.label}<span className="mono text-[10px] text-ws-dim">{n}</span>
          </button>
        );
      })}
      <div className="ml-auto flex items-center gap-1.5 self-center pr-2">
        <span className="text-[10.5px] text-ws-muted" title="How much sky the view covers. A different size is a different bundle, which may need building.">Field</span>
        <Select label="Field of view" value={ws.session.fov}
          options={[...(ZOOMS.some((z) => Math.abs(z.fov - ws.session.fov) < 1e-6) ? [] : [{ value: ws.session.fov, label: `${ws.session.fov}°` }]),
            ...ZOOMS.map((z) => ({ value: z.fov, label: `${z.label} · ${z.hint}` }))]}
          onChange={(f) => ws.session.setUrl({ fov: f })} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
export function StatusBar() {
  const ws = useWS();
  const pb = usePB();
  const { view } = useView();
  const c = useCursor();
  const b = ws.bundle;
  const [heap, setHeap] = useState<ReturnType<typeof readHeap>>(null);
  useEffect(() => {
    const tick = () => setHeap(readHeap());
    tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, []);
  const sorted = [...ws.tasks].sort((x, y) => PRIORITY.indexOf(x.state) - PRIORITY.indexOf(y.state));

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-ws-edge bg-ws-panel px-2 text-[10.5px] text-ws-muted">
      <Menu width={340} trigger={() => (
        <button type="button" className="flex items-center gap-1.5 hover:text-ws-fg" title="Background tasks">
          {sorted[0] ? <StateChip state={sorted[0].state} /> : <span>Idle</span>}
          <span>· {ws.tasks.length} task{ws.tasks.length === 1 ? "" : "s"}</span>
        </button>
      )}>
        {() => (
          <div className="max-h-72 overflow-auto px-2.5 py-1">
            {sorted.length ? sorted.map((t) => (
              <div key={t.id} className="border-b border-ws-line/60 py-1.5 last:border-0">
                <div className="flex items-center gap-2 text-[11px] text-ws-fg">
                  <StateChip state={t.state} compact /><span className="min-w-0 flex-1 truncate">{t.label}</span>
                  <span className={cn("text-[10px]", STATE_STYLE[t.state].text)}>{STATE_STYLE[t.state].label}</span>
                </div>
                {t.detail ? <div className="mono mt-0.5 truncate pl-3.5 text-[10px] text-ws-muted">{t.detail}</div> : null}
                {t.progress !== undefined && t.progress < 1 ? (
                  <div className="ml-3.5 mt-1 h-1 overflow-hidden rounded bg-ws-raised"><div className="h-full bg-ws-sel" style={{ width: `${Math.round(t.progress * 100)}%` }} /></div>
                ) : null}
              </div>
            )) : <div className="py-2 text-[11px] text-ws-muted">Nothing running.</div>}
          </div>
        )}
      </Menu>

      <div className="h-3 w-px bg-ws-line" />
      <span className="mono min-w-0 flex-1 truncate text-ws-fg" aria-live="off">
        {c && b ? (
          <>
            x {String(c.x).padStart(3)} y {String(c.y).padStart(3)}
            <span className="text-ws-muted"> · </span>{fmtCoord(c.ra, c.dec, ws.prefs.coordFormat)}
            {c.flux !== null ? <><span className="text-ws-muted"> · </span>{c.flux.toFixed(4)} MJy/sr</> : null}
          </>
        ) : <span className="text-ws-dim">{b ? "Move over the image for coordinates" : ""}</span>}
      </span>

      {b ? (
        <>
          <span className="mono">{Math.round(view.scale * 100)}%</span>
          <span className="mono" title="Image size · pixel scale · field of view">{b.npix}×{b.npix} · {b.pixel_arcsec}″/px · {b.fov_deg}°</span>
          <span className="mono">frame {pb.i + 1}/{pb.n}</span>
        </>
      ) : null}
      {heap ? <span className="mono" title="JavaScript heap in use (Chromium only)">heap {(heap.used / 1048576).toFixed(0)} MB</span> : null}
      <span className={cn("mono", DEMO ? "text-ws-muted" : "text-ws-ok")}>{DEMO ? "static" : "API"}</span>
    </footer>
  );
}

// ---------------------------------------------------------------------------
const SHORTCUTS: [string, string][] = [
  ["Space", "Play / pause"], ["← / →", "Previous / next frame"], ["Home / End", "First / last frame"], ["L", "Loop on / off"],
  ["1 – 5", "Time-lapse · In colour · Deeper · Every frame · What changed"],
  ["H", "Pan tool"], ["Z", "Zoom tool (Alt-click zooms out)"], ["I", "Spectral probe"], ["M", "Measure"],
  ["[ / ]", "Smaller / larger spectrum aperture"], ["F", "Fit to screen"], ["0", "Actual pixels (100%)"], ["+ / −", "Zoom in / out"],
  ["Wheel", "Zoom at the cursor"], ["Middle-drag", "Pan with any tool"], ["X", "Crosshair"], ["G", "Pixel grid"],
  ["D", "Run / show change detection"], ["Ctrl+Z", "Undo"], ["Ctrl+Shift+Z / Ctrl+Y", "Redo"], ["\\", "Show / hide the panel dock"],
  ["?", "This sheet"], ["Esc", "Close / leave a text field"],
];

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-[80] flex items-center justify-center bg-black/60" onClick={onClose} role="dialog" aria-label="Keyboard shortcuts">
      <div className="w-[560px] max-w-[92vw] rounded-[4px] border border-ws-line bg-ws-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center border-b border-ws-line px-3 py-2">
          <Keyboard size={14} className="mr-2 text-ws-muted" />
          <span className="text-[12px] font-semibold">Keyboard shortcuts</span>
          <IconBtn icon={X} label="Close" className="ml-auto" onClick={onClose} />
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 px-4 py-3">
          {SHORTCUTS.map(([k, v]) => (
            <div key={k} className="flex items-baseline gap-2 text-[11px]">
              <kbd className="mono min-w-[88px] shrink-0 rounded-[3px] border border-ws-line bg-ws-raised px-1.5 py-px text-center text-[10.5px] text-ws-fg">{k}</kbd>
              <span className="text-ws-muted">{v}</span>
            </div>
          ))}
        </div>
        <p className="border-t border-ws-line px-4 py-2 text-[10.5px] text-ws-dim">
          Space and the arrow keys work as they did in the Simple view. Shortcuts are ignored while typing in a field.
        </p>
      </div>
    </div>
  );
}
