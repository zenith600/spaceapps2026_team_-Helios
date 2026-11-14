"use client";
import { useEffect, useMemo, useState } from "react";
import { ChartColumn } from "lucide-react";
import { getCube, peekCube, skyFileUrl } from "@/lib/sky";
import { cubePlanesForFrame, fluxValues, histogram, robustStats, type Stats } from "@/lib/workstation/histogram";
import { usePB, useWS } from "../context";
import { Check, Empty, KV, Section, Select } from "../ui";

const BINS = 64;

/** Results per frame, so scrubbing back and forth does not recompute. */
const memo = new Map<string, { values: Float64Array; stats: Stats | null; planes: number }>();
function remember(k: string, v: { values: Float64Array; stats: Stats | null; planes: number }) {
  memo.set(k, v);
  if (memo.size > 120) memo.delete(memo.keys().next().value as string);
  return v;
}

export function HistogramPanel() {
  const ws = useWS();
  const pb = usePB();
  const b = ws.bundle;
  const hasCube = Boolean(b?.cube_u16) && ws.mode !== "difference";
  const [source, setSource] = useState<"flux" | "display">("flux");
  const [log, setLog] = useState(true);
  const [cubeReady, setCubeReady] = useState(false);
  const [cubeError, setCubeError] = useState<string | null>(null);
  const useFlux = source === "flux" && hasCube;

  useEffect(() => {
    if (!b || !useFlux) return;
    if (peekCube(b.slug)) { setCubeReady(true); return; }
    let cancelled = false;
    setCubeReady(false); setCubeError(null);
    getCube(b).then(() => { if (!cancelled) setCubeReady(true); })
      .catch((e) => { if (!cancelled) setCubeError(String((e as Error).message || e)); });
    return () => { cancelled = true; };
  }, [b, useFlux]);

  const frame = pb.frame;
  const flux = useMemo(() => {
    if (!b || !frame || !useFlux || !cubeReady || !b.cube_u16) return null;
    const k = `${b.slug}@${b.generated_at}|${ws.mode}|${frame.id}`;
    const hit = memo.get(k);
    if (hit) return hit;
    const data = peekCube(b.slug);
    if (!data) return null;
    const planes = cubePlanesForFrame(b.cube_u16, frame, ws.mode);
    const values = fluxValues(b.cube_u16, data, planes);
    return remember(k, { values, stats: robustStats(values), planes: planes.length });
  }, [b, frame, ws.mode, useFlux, cubeReady]);

  const display = useDisplayHistogram(!useFlux && b && frame ? skyFileUrl(b.slug, frame.png) : null);

  if (!b || !frame) return <Empty icon={ChartColumn}>Open a field to see pixel statistics.</Empty>;

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-ws-edge px-2 py-1.5">
        <Select label="Histogram source" value={useFlux ? "flux" : "display"} className="flex-1"
          options={[
            ...(hasCube ? [{ value: "flux" as const, label: "Calibrated flux (MJy/sr)" }] : []),
            { value: "display" as const, label: "Display values (8-bit)" },
          ]}
          onChange={setSource} />
        <Check label="log" checked={log} onChange={setLog} />
      </div>

      {useFlux ? (
        cubeError ? <p className="px-2 py-3 text-[11px] text-ws-err">Cube unavailable: {cubeError}</p>
          : !flux ? <p className="px-2 py-3 text-[11px] text-ws-muted">Loading the pixel cube…</p>
          : flux.stats ? (
            <>
              <FluxChart values={flux.values} stats={flux.stats} log={log} vmin={b.scale.vmin} vmax={b.scale.vmax} />
              <Section title={`Frame ${pb.i + 1} · ${flux.planes} exposure${flux.planes === 1 ? "" : "s"} pooled`}>
                <KV k="pixels" v={flux.stats.n.toLocaleString()} />
                <KV k="median" v={`${flux.stats.median.toFixed(4)} MJy/sr`} />
                <KV k="σ (MAD)" v={flux.stats.sigmaMad.toFixed(4)} />
                <KV k="mean" v={flux.stats.mean.toFixed(4)} />
                <KV k="1% / 99%" v={`${flux.stats.p01.toFixed(4)} / ${flux.stats.p99.toFixed(4)}`} />
                <KV k="min / max" v={`${flux.stats.min.toFixed(4)} / ${flux.stats.max.toFixed(4)}`} />
                <KV k="display stretch" v={`${b.scale.mode} ${b.scale.vmin.toFixed(3)}–${b.scale.vmax.toFixed(3)}`} />
                <p className="pt-1 text-[10.5px] leading-snug text-ws-dim">
                  {ws.mode === "epochs" ? "One exposure, one wavelength." : "Pooled across the exposures this frame combines — each at its own wavelength, so this mixes colours."}
                  {" "}Usable pixels only (flagged and empty ones excluded). The dashed lines are the stretch the frames were rendered with.
                </p>
              </Section>
            </>
          ) : <p className="px-2 py-3 text-[11px] text-ws-muted">No usable pixels in this frame.</p>
      ) : display ? (
        <>
          <DisplayChart h={display} log={log} />
          <Section title="Display values">
            <p className="text-[10.5px] leading-snug text-ws-dim">
              The rendered 8-bit PNG after the {b.scale.mode} stretch, not calibrated flux.
              {ws.mode === "difference" ? " Difference frames: 128 is unchanged." : ""}
              {!hasCube ? " This view has no pixel cube in the browser, so calibrated values are not available here." : ""}
            </p>
          </Section>
        </>
      ) : <p className="px-2 py-3 text-[11px] text-ws-muted">Reading the frame…</p>}
    </div>
  );
}

function FluxChart({ values, stats, log, vmin, vmax }: { values: Float64Array; stats: Stats; log: boolean; vmin: number; vmax: number }) {
  const lo = Math.min(stats.p01, vmin), hi = Math.max(stats.p99, vmax);
  const h = histogram(values, BINS, lo, hi);
  const x = (v: number) => ((v - lo) / (hi - lo || 1)) * 100;
  return (
    <Chart counts={h.counts} log={log}
      marks={[{ x: x(vmin), label: "vmin" }, { x: x(vmax), label: "vmax" }, { x: x(stats.median), label: "median", solid: true }]}
      axis={[lo.toFixed(3), hi.toFixed(3)]} unit="MJy/sr" note={h.under || h.over ? `${h.under} below · ${h.over} above range` : undefined} />
  );
}

type DisplayHist = { r: number[]; g: number[]; b: number[]; grey: boolean };

function DisplayChart({ h, log }: { h: DisplayHist; log: boolean }) {
  const fold = (c: number[]) => Array.from({ length: BINS }, (_, k) => c.slice(k * 4, k * 4 + 4).reduce((a, v) => a + v, 0));
  return h.grey
    ? <Chart counts={fold(h.r)} log={log} axis={["0", "255"]} unit="display level" />
    : <Chart counts={fold(h.r)} extra={[{ counts: fold(h.g), colour: "#4ade80" }, { counts: fold(h.b), colour: "#60a5fa" }]}
        colour="#f87171" log={log} axis={["0", "255"]} unit="display level (R G B)" />;
}

function Chart({ counts, log, marks = [], axis, unit, note, extra = [], colour = "#9ca3af" }: {
  counts: number[]; log: boolean; marks?: { x: number; label: string; solid?: boolean }[]; axis: [string, string];
  unit: string; note?: string; extra?: { counts: number[]; colour: string }[]; colour?: string;
}) {
  const f = (v: number) => (log ? Math.log10(1 + v) : v);
  const all = [counts, ...extra.map((e) => e.counts)];
  const max = Math.max(1e-9, ...all.flat().map(f));
  const W = 100, H = 60, bw = W / counts.length;
  const path = (c: number[]) => c.map((v, k) => `${k === 0 ? "M" : "L"}${(k + 0.5) * bw},${H - (f(v) / max) * H}`).join(" ");
  return (
    <div className="px-2 pb-1 pt-2">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[110px] w-full rounded-[2px] bg-ws-bg" role="img" aria-label="Histogram">
        {extra.length ? (
          <>
            <path d={path(counts)} fill="none" stroke={colour} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            {extra.map((e, k) => <path key={k} d={path(e.counts)} fill="none" stroke={e.colour} strokeWidth={1} vectorEffect="non-scaling-stroke" />)}
          </>
        ) : counts.map((v, k) => (
          <rect key={k} x={k * bw} width={bw * 0.92} y={H - (f(v) / max) * H} height={(f(v) / max) * H} fill={colour} opacity={0.85} />
        ))}
        {marks.map((m) => (
          <line key={m.label} x1={m.x} x2={m.x} y1={0} y2={H} stroke={m.solid ? "#fbbf24" : "#3b82f6"} strokeWidth={1}
            strokeDasharray={m.solid ? undefined : "3 2"} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <div className="mono flex justify-between pt-0.5 text-[9.5px] text-ws-dim">
        <span>{axis[0]}</span><span className="text-ws-muted">{unit}{log ? " · log count" : ""}</span><span>{axis[1]}</span>
      </div>
      {marks.length ? (
        <div className="flex gap-3 pt-0.5 text-[9.5px] text-ws-dim">
          <span><span className="text-ws-sel">┆</span> stretch vmin / vmax</span><span><span className="text-ws-warn">│</span> median</span>
        </div>
      ) : null}
      {note ? <div className="pt-0.5 text-[9.5px] text-ws-dim">{note}</div> : null}
    </div>
  );
}

/** Read the rendered PNG back through a canvas (same image the canvas shows, so usually from cache). */
function useDisplayHistogram(url: string | null): DisplayHist | null {
  const [h, setH] = useState<DisplayHist | null>(null);
  useEffect(() => {
    if (!url) { setH(null); return; }
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      try {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const r = new Array(256).fill(0), g = new Array(256).fill(0), bl = new Array(256).fill(0);
        let grey = true;
        for (let k = 0; k < d.length; k += 4) {
          r[d[k]]++; g[d[k + 1]]++; bl[d[k + 2]]++;
          if (grey && (d[k] !== d[k + 1] || d[k] !== d[k + 2])) grey = false;
        }
        setH({ r, g, b: bl, grey });
      } catch { setH(null); }
    };
    img.src = url;
    return () => { cancelled = true; };
  }, [url]);
  return h;
}
