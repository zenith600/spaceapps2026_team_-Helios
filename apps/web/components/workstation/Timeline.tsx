"use client";
// The time axis of a field. Driven by the same playback engine (usePlayback) as the
// Simple view's player; this only adds a view of *when* each frame was taken.
import { useMemo, useRef } from "react";
import { ChevronFirst, ChevronLast, Pause, Play, Repeat, StepBack, StepForward } from "lucide-react";
import { SPEED_LABELS, SPEEDS } from "@/components/SkyPlayer";
import { mjdLabel } from "@/lib/sky";
import { formatDuration, makeScale, timeTicks } from "@/lib/workstation/timeline";
import { cn } from "@/lib/utils";
import { usePB, useWS } from "./context";
import { Empty, IconBtn, Select } from "./ui";

const DETECTOR_COLOURS = ["#f59e0b", "#60a5fa", "#22c55e", "#f472b6", "#e6e8ee", "#a78bfa"];
const LABEL_W = 116;

export function Timeline() {
  const ws = useWS();
  const pb = usePB();
  const bundle = ws.bundle;
  const scaleMode = ws.prefs.timelineScale;
  const mjds = useMemo(() => ws.frames.map((f) => f.mjd), [ws.frames]);
  const scale = useMemo(() => makeScale(mjds, scaleMode), [mjds, scaleMode]);
  const lanes = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);

  if (!bundle || !ws.frames.length) {
    return (
      <div className="flex h-full flex-col bg-ws-panel">
        <Header />
        <Empty>No time series loaded. Open a field to see its visits on a time axis.</Empty>
      </div>
    );
  }

  const cov = bundle.coverage;
  const fracAt = (clientX: number) => {
    const r = lanes.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };
  const seekToVisit = (visit: number, mjd: number) => {
    const k = ws.frames.findIndex((f) => f.visit === visit);
    pb.seek(k >= 0 ? k : scale.nearest(scale.fracOfMjd(mjd)));
  };

  const cur = pb.frame;
  const playX = scale.frac(pb.i) * 100;
  const ticks = scaleMode === "time" ? timeTicks(scale.t0, scale.t1, 10) : [];
  const sel = ws.layer(ws.selected);
  const temporal = sel?.node.temporal ?? "none";
  const epochs = bundle.frames.epochs;

  return (
    <div className="flex h-full flex-col bg-ws-panel">
      <Header>
        <div className="flex items-center gap-0.5">
          <IconBtn icon={ChevronFirst} label="First frame" shortcut="Home" onClick={() => pb.seek(0)} />
          <IconBtn icon={StepBack} label="Previous frame" shortcut="←" onClick={() => pb.step(-1)} />
          <IconBtn icon={pb.playing ? Pause : Play} label={pb.playing ? "Pause" : "Play"} shortcut="Space"
            onClick={pb.toggle} active={pb.playing} />
          <IconBtn icon={StepForward} label="Next frame" shortcut="→" onClick={() => pb.step(1)} />
          <IconBtn icon={ChevronLast} label="Last frame" shortcut="End" onClick={() => pb.seek(pb.n - 1)} />
          <IconBtn icon={Repeat} label={pb.loop ? "Looping (click to stop at the end)" : "Not looping"} shortcut="L"
            active={pb.loop} onClick={() => pb.setLoop(!pb.loop)} />
        </div>
        <Select label="Playback speed" value={pb.speedIdx}
          options={SPEED_LABELS.map((l, k) => ({ value: k, label: `${l} · ${(1000 / SPEEDS[k]).toFixed(1)} fps` }))}
          onChange={(v) => pb.setSpeedIdx(v)} />
        <span className="mono text-[11px] text-ws-fg">{pb.i + 1}<span className="text-ws-dim">/{pb.n}</span></span>
        {cur ? (
          <span className="mono truncate text-[11px] text-ws-fg" title="Time of the current frame">
            {mjdLabel(cur.mjd)} <span className="text-ws-muted">MJD {cur.mjd.toFixed(3)}</span>
            <span className="text-ws-dim"> · t₀+{formatDuration(cur.mjd - cov.mjd_min)}</span>
          </span>
        ) : null}
        <span className="ml-auto mono text-[10.5px] text-ws-muted" title="First to last exposure in this view">
          span {formatDuration(cov.baseline_days)}
        </span>
        <div className="flex overflow-hidden rounded-[3px] border border-ws-line" role="radiogroup" aria-label="Timeline scale">
          {(["time", "index"] as const).map((m) => (
            <button key={m} role="radio" aria-checked={scaleMode === m} onClick={() => ws.setPrefs({ timelineScale: m })}
              title={m === "time" ? "Frames at their real dates: the survey cadence is visible" : "Evenly spaced: tells apart frames taken minutes apart"}
              className={cn("px-2 py-0.5 text-[10.5px]", scaleMode === m ? "bg-ws-selbg text-ws-fg" : "text-ws-muted hover:text-ws-fg")}>
              {m === "time" ? "Time" : "Frames"}
            </button>
          ))}
        </div>
      </Header>

      <div className="ws-scroll relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="relative flex">
          <div className="shrink-0 border-r border-ws-edge bg-ws-panel" style={{ width: LABEL_W }}>
            <LaneLabel h={18} muted>{scaleMode === "time" ? "Date" : "Frame"}</LaneLabel>
            <LaneLabel h={22}>Frames <span className="text-ws-dim">· {ws.mode}</span></LaneLabel>
            <LaneLabel h={22}>Visits <span className="text-ws-dim">· {bundle.visits.length}</span></LaneLabel>
            <LaneLabel h={26}>Exposures <span className="text-ws-dim">· {epochs.length}</span></LaneLabel>
            <LaneLabel h={22} title={sel ? `Temporal availability of ${sel.name}` : undefined}>
              <span className="truncate">{sel ? sel.name : "Selected layer"}</span>
            </LaneLabel>
          </div>

          <div ref={lanes} className="relative min-w-0 flex-1 cursor-pointer select-none"
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).dataset.seek) return;
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              scrubbing.current = true;
              pb.seek(scale.nearest(fracAt(e.clientX)));
            }}
            onPointerMove={(e) => { if (scrubbing.current) pb.seek(scale.nearest(fracAt(e.clientX))); }}
            onPointerUp={() => { scrubbing.current = false; }}>
            {/* ruler */}
            <div className="relative h-[18px] border-b border-ws-edge bg-ws-raised/50">
              {scaleMode === "time" ? ticks.map((t) => (
                <div key={t.mjd} className="absolute top-0 h-full" style={{ left: `${scale.fracOfMjd(t.mjd) * 100}%` }}>
                  <div className={cn("h-full w-px", t.major ? "bg-ws-muted" : "bg-ws-line")} />
                  <span className={cn("absolute left-1 top-0.5 whitespace-nowrap text-[9.5px]", t.major ? "text-ws-fg" : "text-ws-muted")}>{t.label}</span>
                </div>
              )) : ws.frames.map((_, k) => (k % Math.max(1, Math.ceil(ws.frames.length / 12)) === 0 ? (
                <div key={k} className="absolute top-0 h-full" style={{ left: `${scale.frac(k) * 100}%` }}>
                  <div className="h-full w-px bg-ws-line" />
                  <span className="mono absolute left-1 top-0.5 text-[9.5px] text-ws-muted">{k + 1}</span>
                </div>
              ) : null))}
            </div>

            {/* frames in the current mode */}
            <Lane h={22}>
              {ws.frames.map((f, k) => (
                <div key={f.id} title={`${k + 1}: ${f.title} — ${f.subtitle}`}
                  className={cn("absolute top-1/2 h-3 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-[1px]",
                    k === pb.i ? "bg-ws-sel" : "bg-ws-muted/70")}
                  style={{ left: `${scale.frac(k) * 100}%` }} />
              ))}
            </Lane>

            {/* visits as spans */}
            <Lane h={22}>
              {bundle.visits.map((v, vi) => {
                const a = scale.fracOfMjd(v.mjd_start), b = scale.fracOfMjd(v.mjd_end);
                const active = cur?.visit === v.visit;
                // Label only visits with room before the next one; the rest keep their tooltip.
                const next = bundle.visits[vi + 1];
                const roomy = !next || scale.fracOfMjd(next.mjd_start) - b > 0.07;
                return (
                  <button key={v.visit} type="button" data-seek="1" onClick={() => seekToVisit(v.visit, v.mjd_start)}
                    title={`Visit ${v.visit} · ${v.label} · ${v.n_exposures} exposures available · ${mjdLabel(v.mjd_start)}`}
                    className={cn("absolute top-1 h-[14px] rounded-[2px] border text-[9px] leading-[12px]",
                      active ? "border-ws-sel bg-ws-selbg text-ws-fg" : "border-ws-line bg-ws-raised text-ws-muted hover:border-ws-muted")}
                    style={{ left: `calc(${Math.min(a, b) * 100}% - 3px)`, width: `max(7px, calc(${Math.abs(b - a) * 100}% + 6px))` }}>
                    {roomy || active ? (
                      <span className={cn("pointer-events-none absolute left-full top-0 ml-0.5 whitespace-nowrap px-0.5",
                        active && "z-10 rounded-[2px] bg-ws-panel text-ws-fg")}>{v.label}</span>
                    ) : null}
                  </button>
                );
              })}
            </Lane>

            {/* every exposure: colour = detector, height = good-pixel fraction */}
            <Lane h={26}>
              {epochs.map((e, k) => (
                <button key={e.id} type="button" data-seek="1"
                  onClick={() => (ws.mode === "epochs" ? pb.seek(k) : seekToVisit(e.visit, e.mjd))}
                  title={`${e.obs_id} · D${e.detector} · ${e.wave_um.toFixed(2)} µm · ${(100 * e.good_fraction).toFixed(0)}% good · ${mjdLabel(e.mjd)}`}
                  className="absolute bottom-1 w-[3px] -translate-x-1/2 rounded-t-[1px] opacity-85 hover:opacity-100"
                  style={{
                    left: `${scale.fracOfMjd(e.mjd) * 100}%`,
                    height: `${Math.max(3, 18 * e.good_fraction)}px`,
                    background: DETECTOR_COLOURS[(e.detector - 1 + DETECTOR_COLOURS.length) % DETECTOR_COLOURS.length],
                    outline: ws.mode === "epochs" && k === pb.i ? "1px solid #fff" : undefined,
                  }} />
              ))}
            </Lane>

            {/* selected layer: when does it exist? */}
            <Lane h={22}>
              {temporal === "per-frame" ? ws.frames.map((f, k) => (
                <div key={f.id} className="absolute top-1/2 h-2 w-[3px] -translate-x-1/2 -translate-y-1/2 bg-ws-sel/70"
                  style={{ left: `${scale.frac(k) * 100}%` }} />
              )) : temporal === "all-exposures" ? (
                <div className="absolute top-1/2 h-2 -translate-y-1/2 rounded-[2px] bg-ws-sel/40"
                  style={{ left: `${scale.fracOfMjd(cov.mjd_min) * 100}%`, width: `${(scale.fracOfMjd(cov.mjd_max) - scale.fracOfMjd(cov.mjd_min)) * 100}%` }}>
                  <span className="absolute left-1 top-[-1px] whitespace-nowrap text-[9px] leading-[10px] text-ws-fg">built from every exposure in the span</span>
                </div>
              ) : temporal === "epochs-only" ? (ws.mode === "epochs" ? epochs.map((e) => (
                <div key={e.id} className="absolute top-1/2 h-2 w-[3px] -translate-x-1/2 -translate-y-1/2 bg-ws-sel/70"
                  style={{ left: `${scale.fracOfMjd(e.mjd) * 100}%` }} />
              )) : <span className="absolute left-2 top-1 text-[10px] text-ws-dim">single exposures only — switch to Every frame (4)</span>)
                : <span className="absolute left-2 top-1 text-[10px] text-ws-dim">
                    {temporal === "static" ? "not time-resolved: one catalogue epoch" : "not time-dependent"}
                  </span>}
            </Lane>

            {/* playhead */}
            <div className="pointer-events-none absolute inset-y-0 w-px bg-ws-sel" style={{ left: `${playX}%` }}>
              <div className="absolute -left-[4px] top-0 h-0 w-0 border-x-[4.5px] border-t-[6px] border-x-transparent border-t-ws-sel" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Header({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-ws-edge bg-ws-raised px-2">
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ws-muted">Timeline</span>
      {children}
    </div>
  );
}

function LaneLabel({ children, h, muted, title }: { children: React.ReactNode; h: number; muted?: boolean; title?: string }) {
  return (
    <div title={title} style={{ height: h }}
      className={cn("flex items-center gap-1 overflow-hidden border-b border-ws-edge px-2 text-[10.5px]", muted ? "text-ws-dim" : "text-ws-muted")}>
      {children}
    </div>
  );
}

function Lane({ children, h }: { children: React.ReactNode; h: number }) {
  return <div className="relative border-b border-ws-edge" style={{ height: h }}>{children}</div>;
}
