"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MotionTrack } from "@/components/MotionTrack";
import {
  type DetectorFrame, type EpochFrame, type Motion, type Overlay, type SkyBundle, type VisitFrame,
  catalogAt, mjdLabel, skyFileUrl,
} from "@/lib/sky";

export type FrameMode = "visits" | "colour" | "detectors" | "epochs" | "difference";

/**
 * Plain-language names, technical meaning in the hint. "Per-detector coadd" is precise and
 * useless to someone meeting SPHEREx for the first time; "Deeper" plus a sentence is both.
 */
export const MODES: { id: FrameMode; label: string; hint: string }[] = [
  { id: "visits", label: "Time-lapse",
    hint: "One picture per visit, months apart. This is where movement shows up — watch for anything that shifts while the background stays put." },
  { id: "colour", label: "In colour",
    hint: "SPHEREx's infrared bands mapped to red, green and blue. Red means brighter at longer wavelengths — cooler or dustier; blue the opposite. These are not visible-light colours." },
  { id: "detectors", label: "Deeper",
    hint: "Pictures of the same colour added together, so faint things come out of the noise." },
  { id: "epochs", label: "Every frame",
    hint: "Each raw exposure as it came down, with its own colour and NASA's quality flags." },
  { id: "difference", label: "What changed",
    hint: "Each visit with the first one subtracted. Anything unchanged cancels to grey; white got brighter, black got fainter." },
];

/**
 * The common shape the player needs, whichever mode is showing. `visit`, `detector` and
 * `obsId` identify which exposures in the pixel cube a frame was made from, where that is
 * defined; they are references, not copies of any data.
 */
export type PlayFrame = {
  id: string; png: string; flagPng?: string; mjd: number;
  title: string; subtitle: string; detail: string;
  visit?: number; detector?: number; obsId?: string;
};

export const SPEEDS = [1200, 700, 400, 200, 100];
export const SPEED_LABELS = ["slowest", "slow", "normal", "fast", "fastest"];

export function toPlayFrames(bundle: SkyBundle, mode: FrameMode): PlayFrame[] {
  const band = (w: number, bw: number) => `${w.toFixed(2)} µm ±${(bw / 2).toFixed(3)}`;
  if (mode === "colour") {
    return (bundle.frames.colour ?? []).map((f) => ({
      id: f.id, png: f.png, mjd: f.mjd, visit: f.visit,
      title: mjdLabel(f.mjd),
      subtitle: "false colour · red = longest wavelengths, blue = shortest",
      detail: `visit ${f.visit} · ${f.n} exposures · ${f.bands.map(([a, b]) => `${a.toFixed(2)}–${b.toFixed(2)}`).join(" | ")} µm`,
    }));
  }
  if (mode === "epochs") {
    return bundle.frames.epochs.map((f: EpochFrame) => ({
      id: f.id, png: f.png, flagPng: f.flag_png, mjd: f.mjd,
      visit: f.visit, detector: f.detector, obsId: f.obs_id,
      title: mjdLabel(f.mjd),
      subtitle: `${band(f.wave_um, f.bandwidth_um)} · detector ${f.detector}`,
      detail: `${f.obs_id} · visit ${f.visit} · ${(100 * f.good_fraction).toFixed(0)}% good pixels · PSF ${f.psf_fwhm_arcsec}″`,
    }));
  }
  if (mode === "detectors") {
    return bundle.frames.detectors.map((f: DetectorFrame) => ({
      id: f.id, png: f.png, mjd: f.mjd, visit: f.visit, detector: f.detector,
      title: `${mjdLabel(f.mjd)} · D${f.detector}`,
      subtitle: `${f.wave_um.toFixed(2)} µm (${f.wave_min_um.toFixed(2)}–${f.wave_max_um.toFixed(2)})`,
      detail: `visit ${f.visit} · ${f.n} exposure${f.n === 1 ? "" : "s"} coadded`,
    }));
  }
  if (mode === "difference") {
    return bundle.difference.map((f) => ({
      id: f.id, png: f.png, mjd: f.mjd, visit: f.visit,
      title: mjdLabel(f.mjd),
      subtitle: `visit ${f.visit} compared with visit ${f.reference_visit}`,
      detail: "grey = unchanged, white = brighter now, black = fainter now",
    }));
  }
  return bundle.frames.visits.map((f: VisitFrame) => ({
    id: f.id, png: f.png, mjd: f.mjd, visit: f.visit,
    title: mjdLabel(f.mjd),
    subtitle: `visit ${f.visit} · ${f.n} exposures · ${f.n_bands} band${f.n_bands === 1 ? "" : "s"}`,
    detail: `${f.label} · detectors ${f.detectors.join(", ")}`,
  }));
}

/**
 * The playback engine: one interval timer advancing a frame index. Shared by SkyPlayer and
 * the workstation timeline so both blink frames exactly the same way. `loop` defaults to
 * the original behaviour (wrap to the first frame); with it off, playback stops on the last.
 */
export function usePlayback(n: number, resetKey: string) {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speedIdx, setSpeedIdx] = useState(2);
  const [loop, setLoop] = useState(true);

  useEffect(() => { setI(0); }, [resetKey]);

  useEffect(() => {
    if (!playing || n < 2) return;
    const id = setInterval(() => setI((k) => (k + 1 < n ? k + 1 : loop ? 0 : k)), SPEEDS[speedIdx]);
    return () => clearInterval(id);
  }, [playing, n, speedIdx, loop]);

  // Without looping, playback stops on the last frame instead of wrapping.
  useEffect(() => {
    if (playing && !loop && n > 1 && i >= n - 1) setPlaying(false);
  }, [playing, loop, i, n]);

  const step = useCallback((d: number) => {
    setPlaying(false);
    setI((k) => (k + d + n) % n);
  }, [n]);

  const seek = useCallback((k: number) => {
    setPlaying(false);
    setI(Math.max(0, Math.min(n - 1, Math.round(k))));
  }, [n]);

  /** Play/pause; pressing play on the last frame with looping off starts from the top. */
  const toggle = useCallback(() => {
    if (!playing && !loop && i >= n - 1) setI(0);
    setPlaying(!playing);
  }, [playing, loop, i, n]);

  // A mode or bundle change can shrink the frame list under the current index.
  const index = Math.min(i, Math.max(n - 1, 0));
  return { i: index, setI, playing, setPlaying, toggle, speedIdx, setSpeedIdx, loop, setLoop, step, seek };
}

/**
 * Click position (fraction of the displayed image, 0..1 from the top-left) to a data
 * pixel. The PNG is written top-down from a bottom-up array, so y flips back here. Both
 * are clamped: a click exactly on the top or right edge gives fy = 0 or fx = 1, and
 * floor() of that lands one past the last index.
 */
export function fracToPixel(fx: number, fy: number, npix: number): { x: number; y: number } {
  const clamp = (v: number) => Math.max(0, Math.min(npix - 1, Math.floor(v)));
  return { x: clamp(fx * npix), y: clamp((1 - fy) * npix) };
}

export type StackImage = { key: string; src: string; opacity: number; blend: React.CSSProperties["mixBlendMode"]; z?: number };

/**
 * The renderer: every frame mounted at once and toggled with opacity, then overlays drawn
 * on top in data-pixel coordinates (percentages of the image box), so they stay aligned at
 * any display size. Fills its positioned parent. Layer order is DOM order unless a `z` is
 * given.
 */
export function FrameStack({
  bundle, frames, index, frameStyle, images, flagSrc, flagStyle, catalogs, changePeaks, changeStyle,
  marker, markerStyle, aperture, onFrameLoad,
}: {
  bundle: SkyBundle;
  frames: PlayFrame[];
  index: number;
  frameStyle?: { opacity?: number; filter?: string; z?: number; hidden?: boolean };
  images?: StackImage[];
  flagSrc?: string | null;
  flagStyle?: { opacity?: number; z?: number };
  catalogs?: { layer: Overlay["layers"][number]; opacity?: number; z?: number }[];
  changePeaks?: { x: number; y: number; chi2_per_dof: number }[] | null;
  changeStyle?: { opacity?: number; z?: number };
  marker?: { x: number; y: number } | null;
  markerStyle?: { z?: number; opacity?: number };
  /** Half-width in pixels of the spectrum aperture around the marker, drawn when > 0. */
  aperture?: number;
  onFrameLoad?: (id: string, src: string) => void;
}) {
  const npix = bundle.npix;
  return (
    <>
      {/* Every frame is kept mounted and toggled with opacity: swapping src makes the
          browser re-decode each time, which stutters exactly when the blink matters. */}
      {frames.map((f, k) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={f.id} src={skyFileUrl(bundle.slug, f.png)} alt={f.title}
          onLoad={onFrameLoad ? () => onFrameLoad(f.id, f.png) : undefined}
          className={cn("absolute inset-0 h-full w-full object-contain [image-rendering:pixelated]",
            k === index && !frameStyle?.hidden ? "opacity-100" : "opacity-0")}
          style={frameStyle && k === index && !frameStyle.hidden
            ? { opacity: frameStyle.opacity, filter: frameStyle.filter, zIndex: frameStyle.z } : undefined}
          draggable={false} />
      ))}
      {images?.map((im) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={im.key} src={im.src} alt={im.key}
          className="absolute inset-0 h-full w-full object-contain [image-rendering:pixelated]"
          style={{ opacity: im.opacity, mixBlendMode: im.blend, zIndex: im.z }} />
      ))}
      {flagSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={flagSrc} alt="contamination flags"
          className="absolute inset-0 h-full w-full object-contain [image-rendering:pixelated]"
          style={flagStyle ? { opacity: flagStyle.opacity, zIndex: flagStyle.z } : undefined} />
      ) : null}
      {/* Catalogued sources from other missions. A dot with no ring is unlisted. */}
      {catalogs?.map(({ layer: l, opacity, z }) => (
        <div key={l.id} className="pointer-events-none absolute inset-0" style={{ zIndex: z }}>
          {l.sources.map((s, k) => (
            <span key={k} className="absolute rounded-full border"
              style={{
                left: `${((s.x + 0.5) / npix) * 100}%`,
                top: `${((npix - 1 - s.y + 0.5) / npix) * 100}%`,
                width: 9, height: 9, marginLeft: -4.5, marginTop: -4.5,
                borderColor: l.colour, opacity: opacity ?? 0.85,
              }} />
          ))}
        </div>
      ))}

      {/* Where the data say something happened. */}
      {changePeaks?.map((p, k) => (
        <span key={k} className="pointer-events-none absolute rounded-sm border-2 border-sim"
          style={{
            left: `${(p.x / npix) * 100}%`,
            top: `${((npix - 1 - p.y) / npix) * 100}%`,
            width: `${(100 / npix) * 1.6}%`, height: `${(100 / npix) * 1.6}%`,
            transform: "translate(-18%, -18%)",
            opacity: changeStyle?.opacity, zIndex: changeStyle?.z,
          }} />
      ))}

      {marker && aperture && aperture > 0 ? (
        <div className="pointer-events-none absolute border border-dashed border-accent/70"
          style={{
            left: `${((marker.x - aperture) / npix) * 100}%`,
            top: `${((npix - 1 - marker.y - aperture) / npix) * 100}%`,
            width: `${((2 * aperture + 1) / npix) * 100}%`, height: `${((2 * aperture + 1) / npix) * 100}%`,
            zIndex: markerStyle?.z, opacity: markerStyle?.opacity,
          }} />
      ) : null}
      {marker ? (
        <div className="pointer-events-none absolute border border-accent"
          style={{
            left: `${(marker.x / npix) * 100}%`,
            top: `${((npix - 1 - marker.y) / npix) * 100}%`,
            width: `${100 / npix}%`, height: `${100 / npix}%`,
            zIndex: markerStyle?.z, opacity: markerStyle?.opacity,
          }} />
      ) : null}
    </>
  );
}

export function SkyPlayer({
  bundle, mode, onPickPixel, marker, showFlags, onToggleFlags, hasPicked,
  catalogOverlay, activeLayers, changePeaks, motion,
}: {
  bundle: SkyBundle;
  mode: FrameMode;
  onPickPixel?: (p: { x: number; y: number }) => void;
  marker?: { x: number; y: number } | null;
  showFlags: boolean;
  onToggleFlags: (v: boolean) => void;
  hasPicked?: boolean;
  /** Named to avoid colliding with the stack/static comparison overlay below. */
  catalogOverlay?: Overlay | null;
  activeLayers?: string[];
  changePeaks?: { x: number; y: number; chi2_per_dof: number }[] | null;
  /** A measured motion to draw as a track; null hides it. */
  motion?: Motion | null;
}) {
  const frames = useMemo(() => toPlayFrames(bundle, mode), [bundle, mode]);
  const [overlay, setOverlay] = useState<"none" | "stack" | "static">("none");
  const boxRef = useRef<HTMLDivElement>(null);

  const n = frames.length;
  const { i, setI, playing, setPlaying, speedIdx, setSpeedIdx, step } = usePlayback(n, `${mode}|${bundle.slug}`);

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
    onPickPixel(fracToPixel((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, npix));
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
          <FrameStack bundle={bundle} frames={frames} index={i}
            images={overlay !== "none" ? [{
              key: overlay, opacity: 0.55, blend: "screen",
              src: skyFileUrl(bundle.slug, overlay === "stack" ? bundle.stack.png : bundle.static.png),
            }] : undefined}
            flagSrc={showFlags && cur.flagPng ? skyFileUrl(bundle.slug, cur.flagPng) : null}
            catalogs={catalogOverlay?.layers.filter((l) => (activeLayers ?? []).includes(l.id)).map((l) => ({ layer: catalogAt(l, cur.mjd) }))}
            changePeaks={changePeaks} marker={marker} />
          {motion ? <MotionTrack motion={motion} npix={npix} mjd={cur.mjd} /> : null}
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
