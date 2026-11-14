"use client";
import { useEffect, useState } from "react";
import { type SkyBundle, differenceImage, mjdLabel, skyFileUrl } from "@/lib/sky";
import { cn } from "@/lib/utils";

/**
 * Subtract any visit from any other.
 *
 * The time-lapse answers "did something move?"; this answers "what exactly is different
 * between these two dates?". Everything unchanged cancels to flat grey, so a faint mover
 * that is lost among brighter neighbours in the raw frames becomes a black/white pair.
 *
 * Pairs are made on demand rather than precomputed: 31 visits would be 961 images.
 */
export function VisitCompare({ bundle }: { bundle: SkyBundle }) {
  const visits = bundle.frames.visits;
  const [a, setA] = useState(visits[0]?.visit ?? 0);
  const [b, setB] = useState(visits[visits.length - 1]?.visit ?? 0);
  const [src, setSrc] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visits.length < 2 || a === b) { setSrc(null); return; }
    let cancelled = false;
    setBusy(true); setError(null);
    differenceImage(bundle, a, b)
      .then((url) => { if (!cancelled) setSrc(url); })
      .catch((e) => { if (!cancelled) { setSrc(null); setError(String(e.message || e)); } })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [bundle, a, b, visits.length]);

  if (visits.length < 2) {
    return <p className="text-xs text-muted">Comparing visits needs at least two of them.</p>;
  }

  const label = (v: number) => {
    const f = visits.find((x) => x.visit === v);
    return f ? `${mjdLabel(f.mjd)} (visit ${v})` : `visit ${v}`;
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted">
        Pick two dates and we&apos;ll subtract one from the other. Anything that stayed the same
        cancels to flat grey; what is left is what changed.
      </p>

      <div className="flex flex-wrap items-end gap-2 text-[11px]">
        <label className="flex flex-col gap-0.5">
          <span className="text-muted">from</span>
          <select value={a} onChange={(e) => setA(Number(e.target.value))}
            className="rounded border border-line bg-panel px-2 py-1">
            {visits.map((v) => <option key={v.visit} value={v.visit}>{label(v.visit)}</option>)}
          </select>
        </label>
        <span className="pb-1.5 text-muted">→</span>
        <label className="flex flex-col gap-0.5">
          <span className="text-muted">to</span>
          <select value={b} onChange={(e) => setB(Number(e.target.value))}
            className="rounded border border-line bg-panel px-2 py-1">
            {visits.map((v) => <option key={v.visit} value={v.visit}>{label(v.visit)}</option>)}
          </select>
        </label>
        <button onClick={() => { const t = a; setA(b); setB(t); }}
          className="rounded-full border border-line px-2.5 py-1 text-muted hover:text-fg">
          swap
        </button>
      </div>

      <div className="relative mx-auto aspect-square w-full max-w-[320px] overflow-hidden rounded border border-line bg-black">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={`difference between visit ${a} and ${b}`}
            className="h-full w-full object-contain [image-rendering:pixelated]" />
        ) : (
          <div className="flex h-full items-center justify-center text-[11px] text-muted">
            {a === b ? "pick two different dates" : busy ? "working…" : error ?? ""}
          </div>
        )}
      </div>

      <div className="flex items-center justify-center gap-3 text-[10px] text-muted">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm border border-line bg-black" /> fainter
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm border border-line" style={{ background: "#808080" }} /> unchanged
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-sm border border-line bg-white" /> brighter
        </span>
      </div>

      <div className="flex items-center justify-center gap-2">
        {[a, b].map((v, k) => {
          const f = visits.find((x) => x.visit === v);
          return f ? (
            <figure key={k} className="flex flex-col items-center gap-0.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={skyFileUrl(bundle.slug, f.png)} alt={label(v)}
                className={cn("h-16 w-16 rounded border bg-black object-contain [image-rendering:pixelated]",
                  k === 0 ? "border-line" : "border-accent/60")} />
              <figcaption className="text-[9px] text-muted">{mjdLabel(f.mjd)}</figcaption>
            </figure>
          ) : null;
        })}
      </div>
    </div>
  );
}
