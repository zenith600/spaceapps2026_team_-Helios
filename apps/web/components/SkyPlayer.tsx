"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  type DetectorFrame, type EpochFrame, type SkyBundle, type VisitFrame,
  mjdLabel, skyFileUrl,
} from "@/lib/sky";

export type FrameMode = "visits" | "detectors" | "epochs" | "difference";

/** The common shape the player needs, whichever mode is showing. */
type PlayFrame = {
  id: string; png: string; flagPng?: string; mjd: number;
  title: string; subtitle: string; detail: string;
};

const SPEEDS = [1200, 700, 400, 200, 100];

function toPlayFrames(bundle: SkyBundle, mode: FrameMode): PlayFrame[] {
  const band = (w: number, bw: number) => `${w.toFixed(2)} µm ±${(bw / 2).toFixed(3)}`;
  if (mode === "epochs") {
    return bundle.frames.epochs.map((f: EpochFrame) => ({
      id: f.id, png: f.png, flagPng: f.flag_png, mjd: f.mjd,
      title: mjdLabel(f.mjd),
      subtitle: `${band(f.wave_um, f.bandwidth_um)} · detector ${f.detector}`,
      detail: `${f.obs_id} · visit ${f.visit} · ${(100 * f.good_fraction).toFixed(0)}% good pixels · PSF ${f.psf_fwhm_arcsec}″`,
    }));
  }
  if (mode === "detectors") {
    return bundle.frames.detectors.map((f: DetectorFrame) => ({
      id: f.id, png: f.png, mjd: f.mjd,
      title: `${mjdLabel(f.mjd)} · D${f.detector}`,
      subtitle: `${f.wave_um.toFixed(2)} µm (${f.wave_min_um.toFixed(2)}–${f.wave_max_um.toFixed(2)})`,
      detail: `visit ${f.visit} · ${f.n} exposure${f.n === 1 ? "" : "s"} coadded`,
    }));
  }
  if (mode === "difference") {
    return bundle.difference.map((f) => ({
      id: f.id, png: f.png, mjd: f.mjd,
      title: mjdLabel(f.mjd),
      subtitle: f.label,
      detail: "grey = unchanged, white = brighter now, black = fainter now",
    }));
  }
  return bundle.frames.visits.map((f: VisitFrame) => ({
    id: f.id, png: f.png, mjd: f.mjd,
    title: mjdLabel(f.mjd),
    subtitle: `visit ${f.visit} · ${f.n} exposures · ${f.n_bands} band${f.n_bands === 1 ? "" : "s"}`,
    detail: `${f.label} · detectors ${f.detectors.join(", ")}`,
  }));
}

export function SkyPlayer({
  bundle, mode, onPickPixel, marker, showFlags, onToggleFlags,
}: {
  bundle: SkyBundle;
  mode: FrameMode;
  onPickPixel?: (p: { x: number; y: number }) => void;
  marker?: { x: number; y: number } | null;
  showFlags: boolean;
  onToggleFlags: (v: boolean) => void;
}) {
  const frames = useMemo(() => toPlayFrames(bundle, mode), [bundle, mode]);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speedIdx, setSpeedIdx] = useState(2);
  const [overlay, setOverlay] = useState<"none" | "stack" | "static">("none");
  const boxRef = useRef<HTMLDivElement>(null);

  const n = frames.length;
  useEffect(() => { setI(0); }, [mode, bundle.slug]);

  useEffect(() => {
    if (!playing || n < 2) return;
    const id = setInterval(() => setI((k) => (k + 1) % n), SPEEDS[speedIdx]);
    return () => clearInterval(id);
  }, [playing, n, speedIdx]);

  const step = useCallback((d: number) => {
    setPlaying(false);
    setI((k) => (k + d + n) % n);
  }, [n]);

  // Keyboard: space to play/pause, arrows to step. Scoped to the viewer, not the page.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " ") { e.preventDefault(); setPlaying((p) => !p); }
      else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [step]);

  const cur = frames[Math.min(i, Math.max(n - 1, 0))];
  const npix = bundle.npix;

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onPickPixel) return;
    const r = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    // The PNG is written top-down from a bottom-up array, so y flips back here.
    // Both are clamped: a click exactly on the top or right edge gives fy = 0 or
    // fx = 1, and floor() of that lands one past the last index.
    const clamp = (v: number) => Math.max(0, Math.min(npix - 1, Math.floor(v)));
    onPickPixel({ x: clamp(fx * npix), y: clamp((1 - fy) * npix) });
  };

  if (n === 0) {
    return <p className="rounded border border-line bg-panel p-4 text-xs text-muted">
      No frames in this mode. {mode === "difference" ? "Difference frames need at least two visits." : ""}
    </p>;
  }

  return (
    <div ref={boxRef} tabIndex={0} className="flex flex-col gap-2 outline-none focus:ring-1 focus:ring-accent/40 rounded">
      <div className="relative mx-auto w-full max-w-[520px]">
        <div
          onClick={handleClick}
          className={cn("relative aspect-square w-full overflow-hidden rounded border border-line bg-black",
            onPickPixel && "cursor-crosshair")}
        >
          {/* Every frame is kept mounted and toggled with opacity: swapping src makes the
              browser re-decode each time, which stutters exactly when the blink matters. */}
          {frames.map((f, k) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={f.id} src={skyFileUrl(bundle.slug, f.png)} alt={f.title}
              className={cn("absolute inset-0 h-full w-full object-contain [image-rendering:pixelated]",
                k === i ? "opacity-100" : "opacity-0")} draggable={false} />
          ))}
          {overlay !== "none" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={skyFileUrl(bundle.slug, overlay === "stack" ? bundle.stack.png : bundle.static.png)}
              alt={overlay} className="absolute inset-0 h-full w-full object-contain opacity-55 mix-blend-screen [image-rendering:pixelated]" />
          ) : null}
          {showFlags && cur.flagPng ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={skyFileUrl(bundle.slug, cur.flagPng)} alt="contamination flags"
              className="absolute inset-0 h-full w-full object-contain [image-rendering:pixelated]" />
          ) : null}
          {marker ? (
            <div className="pointer-events-none absolute border border-accent"
              style={{
                left: `${(marker.x / npix) * 100}%`,
                top: `${((npix - 1 - marker.y) / npix) * 100}%`,
                width: `${100 / npix}%`, height: `${100 / npix}%`,
              }} />
          ) : null}
          <div className="pointer-events-none absolute left-2 top-2 rounded bg-bg/70 px-2 py-1 text-[11px] mono">
            {cur.title}
          </div>
          <div className="pointer-events-none absolute bottom-2 right-2 rounded bg-bg/70 px-2 py-1 text-[10px] text-muted mono">
            {bundle.fov_deg}° · {npix}×{npix} px
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setPlaying((p) => !p)} className="min-w-[72px]">
          {playing ? "pause" : "play"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => step(-1)}>◀</Button>
        <Button size="sm" variant="ghost" onClick={() => step(1)}>▶</Button>
        <input type="range" min={0} max={n - 1} value={i} aria-label="frame"
          onChange={(e) => { setPlaying(false); setI(Number(e.target.value)); }}
          className="h-1 flex-1 min-w-[120px] accent-[var(--color-accent)]" />
        <span className="text-[11px] text-muted mono">{i + 1}/{n}</span>
        <select value={speedIdx} onChange={(e) => setSpeedIdx(Number(e.target.value))}
          aria-label="speed" className="rounded border border-line bg-panel px-2 py-1 text-[11px] mono">
          {SPEEDS.map((ms, k) => <option key={ms} value={k}>{(1000 / ms).toFixed(1)} fps</option>)}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
        <span className="text-fg mono">{cur.subtitle}</span>
        <span className="text-muted">{cur.detail}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-muted">overlay</span>
        {(["none", "stack", "static"] as const).map((o) => (
          <button key={o} onClick={() => setOverlay(o)}
            className={cn("rounded border border-line px-2 py-0.5 mono hover:text-fg",
              overlay === o ? "bg-panel text-accent" : "text-muted")}>
            {o === "none" ? "off" : o === "stack" ? `all ${bundle.stack.n} coadded` : "static sky"}
          </button>
        ))}
        {mode === "epochs" ? (
          <label className="ml-2 flex items-center gap-1 text-muted">
            <input type="checkbox" checked={showFlags} onChange={(e) => onToggleFlags(e.target.checked)} />
            contamination flags
          </label>
        ) : null}
        <span className="ml-auto text-muted">space = play/pause · ← → = step</span>
      </div>
    </div>
  );
}
