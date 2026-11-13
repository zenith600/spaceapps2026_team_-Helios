"use client";
import { useEffect, useState } from "react";
import { fileUrl } from "@/lib/api";
import type { Stamps } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { SimTag, SourceTag } from "@/components/Tags";

/** Cycles through single-epoch stamps (blink), with the stack beside it. */
export function BlinkViewer({ stamps, isSimulated, source, onClick, compact = false }: {
  stamps: Stamps; isSimulated: boolean; source?: string; compact?: boolean;
  onClick?: (xy: { x: number; y: number }) => void;
}) {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(true);
  const n = stamps.singles.length;
  useEffect(() => {
    if (!playing || n === 0) return;
    const id = setInterval(() => setI((k) => (k + 1) % n), 350);
    return () => clearInterval(id);
  }, [playing, n]);

  const handle = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!onClick) return;
    const r = e.currentTarget.getBoundingClientRect();
    onClick({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
  };
  const size = compact ? "h-40 w-40 sm:h-48 sm:w-48" : "h-56 w-56 sm:h-64 sm:w-64";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-start gap-4">
        <figure className="flex flex-col gap-1">
          {n > 0 ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={fileUrl(stamps.singles[i])} alt={`single epoch ${i + 1}`} onClick={handle}
              className={`${size} rounded border border-line bg-black object-contain [image-rendering:pixelated] ${onClick ? "cursor-crosshair" : ""}`} />
          ) : <div className={`${size} rounded border border-line bg-black`} />}
          <figcaption className="flex items-center justify-between text-[11px] text-muted mono">
            <span>single frame {n ? i + 1 : 0}/{n}</span>
            <Button size="sm" variant="ghost" onClick={() => setPlaying((p) => !p)}>{playing ? "pause" : "blink"}</Button>
          </figcaption>
        </figure>
        <figure className="flex flex-col gap-1">
          {stamps.stack ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={fileUrl(stamps.stack)} alt="shift-and-stack" onClick={handle}
              className={`${size} rounded border border-accent/60 bg-black object-contain [image-rendering:pixelated] ${onClick ? "cursor-crosshair" : ""}`} />
          ) : <div className={`${size} rounded border border-line bg-black`} />}
          <figcaption className="text-[11px] text-accent mono">shift-and-stack (best trial motion)</figcaption>
        </figure>
        {!compact && stamps.static ? (
          <figure className="flex flex-col gap-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={fileUrl(stamps.static)} alt="static sky" className={`${size} rounded border border-line bg-black object-contain [image-rendering:pixelated]`} />
            <figcaption className="text-[11px] text-muted mono">static sky (median of epochs)</figcaption>
          </figure>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SimTag show={isSimulated} text="Simulated injection" />
        <SourceTag source={source} />
      </div>
    </div>
  );
}
