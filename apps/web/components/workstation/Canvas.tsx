"use client";
// The scientific canvas. The image itself is drawn by FrameStack -- the same renderer the
// Simple view uses (every frame mounted, toggled by opacity). Zoom changes the size of the
// image box rather than CSS-scaling it, so overlay marks stay a constant size on screen and
// pixels stay crisp ([image-rendering:pixelated]).
import { useEffect, useMemo, useRef, useState } from "react";
import { FrameStack, fracToPixel, type StackImage } from "@/components/SkyPlayer";
import { decode, peekCube, pixelToSky, skyFileUrl } from "@/lib/sky";
import { cubePlanesForFrame } from "@/lib/workstation/histogram";
import { adjustmentFilter } from "@/lib/workstation/layers";
import { formatArcsec, measure } from "@/lib/workstation/measure";
import { type Pixel, setCursor, useCursor, usePB, useView, useWS } from "./context";

type Drag =
  | { kind: "pan"; x0: number; y0: number; panX0: number; panY0: number; moved: boolean; probe: boolean }
  | { kind: "measure"; a: Pixel };

export function Canvas() {
  const ws = useWS();
  const pb = usePB();
  const { view, setView, viewport, setViewport, zoomBy, fit } = useView();
  const bundle = ws.bundle!;
  const npix = bundle.npix;
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [liveRuler, setLiveRuler] = useState<{ a: Pixel; b: Pixel } | null>(null);
  const [grabbing, setGrabbing] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setViewport({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [setViewport]);

  const W = npix * view.scale;
  const left = viewport.w / 2 + view.panX - W / 2;
  const top = viewport.h / 2 + view.panY - W / 2;

  // Screen point -> data coordinates. `xf/yf` are continuous (pixel centres at integers,
  // y up); `px` is the clicked pixel exactly as SkyPlayer computes it.
  const toData = (clientX: number, clientY: number) => {
    const r = box.current!.getBoundingClientRect();
    const mx = clientX - r.left, my = clientY - r.top;
    const fx = (mx - left) / W, fy = (my - top) / W;
    const inside = fx >= 0 && fx < 1 && fy >= 0 && fy < 1;
    return { mx, my, fx, fy, inside, xf: fx * npix - 0.5, yf: (1 - fy) * npix - 0.5, px: fracToPixel(fx, fy, npix) };
  };

  // Wheel zoom must be able to preventDefault, so it is bound non-passively.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  // Value under the cursor: exact only for single exposures, where one cube plane is the frame.
  const cubeFluxAt = (x: number, y: number): number | null => {
    const cube = bundle.cube_u16;
    const frame = pb.frame;
    if (ws.mode !== "epochs" || !cube || !frame) return null;
    const data = peekCube(bundle.slug);
    if (!data) return null;
    const [i] = cubePlanesForFrame(cube, frame, "epochs");
    if (i === undefined) return null;
    const [, n, ny, nx] = cube.shape;
    const off = y * nx + x, plane = ny * nx;
    const fc = data[i * plane + off], vc = data[(n + i) * plane + off];
    if (fc === cube.nodata_code || vc === cube.nodata_code) return null;
    const cf = cube.codec.find((c) => c.plane === "flux" && c.i === i);
    return cf ? decode(cf, fc) : null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const d = toData(e.clientX, e.clientY);
    if (e.button === 1 || (e.button === 0 && ws.tool === "hand")) {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      drag.current = { kind: "pan", x0: e.clientX, y0: e.clientY, panX0: view.panX, panY0: view.panY, moved: false, probe: false };
      setGrabbing(true);
      return;
    }
    if (e.button !== 0) return;
    if (ws.tool === "zoom") { zoomBy(e.altKey ? 0.5 : 2, { x: d.mx, y: d.my }); return; }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (ws.tool === "measure") {
      if (!d.inside) return;
      const a = { x: d.xf, y: d.yf };
      drag.current = { kind: "measure", a };
      setLiveRuler({ a, b: a });
      return;
    }
    // Probe: a click picks; a drag pans, so the default tool can still move around.
    drag.current = { kind: "pan", x0: e.clientX, y0: e.clientY, panX0: view.panX, panY0: view.panY, moved: false, probe: true };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = toData(e.clientX, e.clientY);
    setCursor(d.inside ? (() => {
      const sky = pixelToSky(bundle, d.px.x, d.px.y);
      return { x: d.px.x, y: d.px.y, ra: sky.ra_deg, dec: sky.dec_deg, flux: cubeFluxAt(d.px.x, d.px.y), inside: true };
    })() : null);
    const g = drag.current;
    if (!g) return;
    if (g.kind === "pan") {
      const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
      if (!g.moved && Math.hypot(dx, dy) < 4) return;
      if (!g.moved) { g.moved = true; setGrabbing(true); }
      setView((v) => ({ ...v, panX: g.panX0 + dx, panY: g.panY0 + dy, fitted: false }));
    } else {
      const clamp = (v: number) => Math.max(-0.5, Math.min(npix - 0.5, v));
      setLiveRuler({ a: g.a, b: { x: clamp(d.xf), y: clamp(d.yf) } });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = drag.current;
    drag.current = null;
    setGrabbing(false);
    if (!g) return;
    if (g.kind === "pan") {
      if (g.probe && !g.moved) {
        const d = toData(e.clientX, e.clientY);
        if (d.inside) ws.pick(d.px);
      }
      return;
    }
    const r = liveRuler;
    setLiveRuler(null);
    if (r && Math.hypot(r.b.x - r.a.x, r.b.y - r.a.y) > 0.3) ws.setRuler(r);
  };

  // ---- what to draw, from the resolved layers -----------------------------------
  const L = ws.layer;
  const framesL = L("frames");
  const images: StackImage[] = useMemo(() => (["stack", "static"] as const).flatMap((id) => {
    const l = L(id);
    if (!l?.shown) return [];
    const png = id === "stack" ? bundle.stack.png : bundle.static.png;
    return [{ key: id, src: skyFileUrl(bundle.slug, png), opacity: l.opacity, blend: l.config.blend, z: l.z }];
  }), [L, bundle]);
  const flagsL = L("flags");
  const catalogs = useMemo(() => (ws.session.overlay?.layers ?? []).flatMap((c) => {
    const l = L(`cat:${c.id}`);
    // l.opacity already includes the layer's 0.85 default and any group opacity.
    return l?.shown ? [{ layer: c, opacity: l.opacity, z: l.z }] : [];
  }), [L, ws.session.overlay]);
  const changeL = L("change");
  const probeL = L("probe");
  const measureL = L("measure");
  const ruler = liveRuler ?? (measureL?.shown ? ws.doc.ruler : null);

  const cursorStyle = grabbing ? "grabbing" : ws.tool === "hand" ? "grab" : ws.tool === "zoom" ? "zoom-in" : "crosshair";

  return (
    <div ref={box} className="relative min-h-0 flex-1 select-none overflow-hidden bg-ws-canvas"
      style={{ cursor: cursorStyle }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onPointerLeave={() => { if (!drag.current) setCursor(null); }}
      onDoubleClick={() => { if (ws.tool === "hand") fit(); }}
      onAuxClick={(e) => e.preventDefault()}>
      {viewport.w > 0 ? (
        <div className="absolute bg-black shadow-[0_0_0_1px_var(--color-ws-line),0_8px_32px_rgba(0,0,0,0.6)]"
          style={{ left, top, width: W, height: W }}>
          <FrameStack bundle={bundle} frames={ws.frames} index={pb.i}
            frameStyle={{ opacity: framesL?.opacity, filter: framesL ? adjustmentFilter(framesL.config) : undefined,
              z: framesL?.z, hidden: !framesL?.shown }}
            images={images}
            flagSrc={flagsL?.shown && pb.frame?.flagPng ? skyFileUrl(bundle.slug, pb.frame.flagPng) : null}
            flagStyle={{ opacity: flagsL?.opacity, z: flagsL?.z }}
            catalogs={catalogs}
            changePeaks={changeL?.shown ? ws.change.report?.peaks ?? null : null}
            changeStyle={{ opacity: changeL?.opacity, z: changeL?.z }}
            marker={probeL?.shown ? ws.doc.pixel : null}
            markerStyle={{ z: probeL?.z, opacity: probeL?.opacity }}
            aperture={ws.doc.radius}
            onFrameLoad={ws.onFrameLoad} />
          <VectorOverlay npix={npix} scale={view.scale} grid={ws.prefs.grid} ruler={ruler}
            rulerZ={measureL?.z ?? 50} rulerOpacity={measureL?.opacity ?? 1} />
        </div>
      ) : null}

      {ruler ? <RulerLabel ruler={ruler} left={left} top={top} W={W} /> : null}
      {ws.prefs.crosshair ? <Crosshair left={left} top={top} W={W} npix={npix} /> : null}

      {/* Frame identity, top-left, as in the Simple view. */}
      {pb.frame ? (
        <div className="pointer-events-none absolute left-2 top-2 max-w-[60%] rounded-[3px] bg-black/70 px-2 py-1 backdrop-blur-sm">
          <div className="mono text-[11px] text-ws-fg">{pb.frame.title}</div>
          <div className="truncate text-[10px] text-ws-muted">{pb.frame.subtitle}</div>
        </div>
      ) : null}

      {ws.prefs.compass ? <Compass east={(bundle.wcs?.cdelt?.[0] ?? -1) < 0 ? "left" : "right"} /> : null}
      <ScaleBar pixelArcsec={bundle.pixel_arcsec} scale={view.scale} />

      {ws.prefs.hints && !ws.doc.pixel && ws.tool === "probe" ? (
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-accent/90 px-3 py-1 text-[11px] font-medium text-black">
          Click any pixel for its spectrum · drag to pan · scroll to zoom
        </div>
      ) : null}
    </div>
  );
}

/** Grid and measurement line in data units: one SVG unit is one image pixel. */
function VectorOverlay({ npix, scale, grid, ruler, rulerZ, rulerOpacity }: {
  npix: number; scale: number; grid: boolean; ruler: { a: Pixel; b: Pixel } | null; rulerZ: number; rulerOpacity: number;
}) {
  const sx = (x: number) => x + 0.5;
  const sy = (y: number) => npix - y - 0.5;
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${npix} ${npix}`} preserveAspectRatio="none"
      style={{ zIndex: Math.max(rulerZ, 60) }}>
      {grid && scale >= 5 ? (
        <g stroke="rgba(255,255,255,0.10)" strokeWidth={1} vectorEffect="non-scaling-stroke">
          {Array.from({ length: npix - 1 }, (_, k) => (
            <g key={k}>
              <line x1={k + 1} y1={0} x2={k + 1} y2={npix} vectorEffect="non-scaling-stroke" />
              <line x1={0} y1={k + 1} x2={npix} y2={k + 1} vectorEffect="non-scaling-stroke" />
            </g>
          ))}
        </g>
      ) : null}
      {ruler ? (
        <g opacity={rulerOpacity}>
          <line x1={sx(ruler.a.x)} y1={sy(ruler.a.y)} x2={sx(ruler.b.x)} y2={sy(ruler.b.y)}
            stroke="#000" strokeWidth={4} vectorEffect="non-scaling-stroke" opacity={0.6} />
          <line x1={sx(ruler.a.x)} y1={sy(ruler.a.y)} x2={sx(ruler.b.x)} y2={sy(ruler.b.y)}
            stroke="#fbbf24" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          {[ruler.a, ruler.b].map((p, k) => (
            <circle key={k} cx={sx(p.x)} cy={sy(p.y)} r={Math.max(0.25, 3 / scale)} fill="#fbbf24" />
          ))}
        </g>
      ) : null}
    </svg>
  );
}

function RulerLabel({ ruler, left, top, W }: { ruler: { a: Pixel; b: Pixel }; left: number; top: number; W: number }) {
  const ws = useWS();
  const b = ws.bundle!;
  const m = measure(b, ruler.a, ruler.b);
  const n = b.npix;
  const x = left + ((ruler.a.x + ruler.b.x) / 2 + 0.5) / n * W;
  const y = top + (n - (ruler.a.y + ruler.b.y) / 2 - 0.5) / n * W;
  return (
    <div className="pointer-events-none absolute z-[70] -translate-x-1/2 translate-y-2 whitespace-nowrap rounded-[3px] border border-ws-warn/40 bg-black/80 px-1.5 py-0.5 mono text-[10.5px] text-ws-warn"
      style={{ left: x, top: y }}>
      {formatArcsec(m.arcsec)} · {m.pixels.toFixed(2)} px · PA {m.pa_deg.toFixed(1)}°
    </div>
  );
}

function Crosshair({ left, top, W, npix }: { left: number; top: number; W: number; npix: number }) {
  const c = useCursor();
  if (!c) return null;
  const x = left + ((c.x + 0.5) / npix) * W;
  const y = top + ((npix - c.y - 0.5) / npix) * W;
  return (
    <div className="pointer-events-none absolute inset-0 z-[65]">
      <div className="absolute inset-y-0 w-px bg-cyan-300/45" style={{ left: x }} />
      <div className="absolute inset-x-0 h-px bg-cyan-300/45" style={{ top: y }} />
      <div className="absolute border border-cyan-300/80"
        style={{ left: x - W / npix / 2, top: y - W / npix / 2, width: W / npix, height: W / npix }} />
    </div>
  );
}

function Compass({ east }: { east: "left" | "right" }) {
  return (
    <svg className="pointer-events-none absolute right-3 top-3" width="44" height="44" viewBox="0 0 44 44" aria-label="North up, east left">
      <g stroke="#d4d5da" strokeWidth="1.25" fill="none" opacity="0.85">
        <path d="M30 30 V8" /><path d="M27 11 L30 7 L33 11" />
        <path d={east === "left" ? "M30 30 H8" : "M14 30 H36"} />
      </g>
      <text x="30" y="6" textAnchor="middle" fontSize="8" fill="#d4d5da" dy="-0.5" className="mono">N</text>
      <text x={east === "left" ? 4 : 40} y="33" textAnchor="middle" fontSize="8" fill="#d4d5da" className="mono">E</text>
    </svg>
  );
}

/** A bar of a round angular length, sized to sit between 60 and 160 screen pixels. */
function ScaleBar({ pixelArcsec, scale }: { pixelArcsec: number; scale: number }) {
  const choices = [5, 10, 15, 30, 60, 120, 300, 600, 1200];
  const len = choices.find((s) => (s / pixelArcsec) * scale >= 60) ?? choices[choices.length - 1];
  const px = (len / pixelArcsec) * scale;
  if (!Number.isFinite(px) || px > 400) return null;
  return (
    <div className="pointer-events-none absolute bottom-3 right-3 flex flex-col items-end gap-0.5">
      <span className="mono text-[10px] text-ws-fg/90">{len >= 60 ? `${len / 60}′` : `${len}″`}</span>
      <div className="h-1.5 border-x border-b border-ws-fg/80" style={{ width: px }} />
    </div>
  );
}
