"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  type DetectorFrame, type EpochFrame, type SkyBundle, type VisitFrame,
  mjdLabel, skyFileUrl,
} from "@/lib/sky";

export type FrameMode = "visits" | "detectors" | "epochs" | "difference";

/**
 * Plain-language names, technical meaning in the hint. "Per-detector coadd" is precise and
 * useless to someone meeting SPHEREx for the first time; "Deeper" plus a sentence is both.
 */
export const MODES: { id: FrameMode; label: string; hint: string }[] = [
  { id: "visits", label: "Time-lapse",
    hint: "One picture per visit, months apart. This is where movement shows up — watch for anything that shifts while the background stays put." },
  { id: "detectors", label: "Deeper",
    hint: "Pictures of the same colour added together, so faint things come out of the noise." },
  { id: "epochs", label: "Every frame",
    hint: "Each raw exposure as it came down, with its own colour and NASA's quality flags." },
  { id: "difference", label: "What changed",
    hint: "Each visit with the first one subtracted. Anything unchanged cancels to grey; white got brighter, black got fainter." },
];

/** The common shape the player needs, whichever mode is showing. */
type PlayFrame = {
  id: string; png: string; flagPng?: string; mjd: number;
  title: string; subtitle: string; detail: string;
};

const SPEEDS = [1200, 700, 400, 200, 100];
const SPEED_LABELS = ["slowest", "slow", "normal", "fast", "fastest"];

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
  bundle, mode, onPickPixel, marker, showFlags, onToggleFlags, hasPicked,
}: {
  bundle: SkyBundle;
  mode: FrameMode;
  onPickPixel?: (p: { x: number; y: number }) => void;
  marker?: { x: number; y: number } | null;
  showFlags: boolean;
  onToggleFlags: (v: boolean) => void;
  hasPicked?: boolean;
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
      Nothing to show in this view.{mode === "difference" ? " Comparing visits needs at least two of them." : ""}
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
          <div className="pointer-events-none absolute left-2 top-2 rounded bg-bg/80 px-2 py-1 text-[11px] mono">
            {cur.title}
          </div>
          <div className="pointer-events-none absolute bottom-2 right-2 rounded bg-bg/70 px-2 py-1 text-[10px] text-muted mono">
            {bundle.fov_deg}° across
          </div>
          {/* The spectrum is the best thing in here and nothing hinted at it. Say so until used. */}
          {onPickPixel && !hasPicked ? (
            <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-accent/90 px-2 py-1 text-[10px] font-medium text-black">
              Click anywhere for that point&apos;s colours
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setPlaying((p) => !p)} className="min-w-[84px]">
          {playing ? "❚❚ Pause" : "▶ Play"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => step(-1)} aria-label="previous frame">◀</Button>
        <Button size="sm" variant="outline" onClick={() => step(1)} aria-label="next frame">▶</Button>
        <input type="range" min={0} max={Math.max(n - 1, 0)} value={i} aria-label="frame"
          onChange={(e) => { setPlaying(false); setI(Number(e.target.value)); }}
          className="h-1.5 flex-1 min-w-[120px] accent-[var(--color-accent)]" />
        <span className="text-[11px] text-muted mono">{i + 1}/{n}</span>
        <label className="flex items-center gap-1 text-[11px] text-muted">
          speed
          <select value={speedIdx} onChange={(e) => setSpeedIdx(Number(e.target.value))}
            aria-label="playback speed" className="rounded border border-line bg-panel px-1.5 py-1 text-[11px]">
            {SPEED_LABELS.map((lbl, k) => <option key={lbl} value={k}>{lbl}</option>)}
          </select>
        </label>
      </div>

      <div className="rounded border border-line bg-panel px-2 py-1.5 text-[11px]">
        <span className="font-medium text-fg">{cur.subtitle}</span>
        <span className="ml-2 text-muted">{cur.detail}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-muted">Compare with:</span>
        {([["none", "nothing"], ["stack", "everything added up"], ["static", "the unchanging sky"]] as const).map(([o, lbl]) => (
          <button key={o} onClick={() => setOverlay(o)}
            title={o === "stack" ? `All ${bundle.stack.n} images combined, laid over the current frame`
              : o === "static" ? "What stays put across every visit — anything that moves is missing from it"
              : "Show the frame on its own"}
            className={cn("rounded-full border px-2.5 py-0.5",
              overlay === o ? "border-accent/60 bg-accent/10 text-accent" : "border-line text-muted hover:text-fg")}>
            {lbl}
          </button>
        ))}
        {mode === "epochs" ? (
          <label className="ml-1 flex cursor-pointer items-center gap-1 text-muted hover:text-fg">
            <input type="checkbox" checked={showFlags} onChange={(e) => onToggleFlags(e.target.checked)} />
            show NASA&apos;s quality flags
          </label>
        ) : null}
        <span className="ml-auto text-muted/70">space = play/pause · ← → = step</span>
      </div>
    </div>
  );
}
