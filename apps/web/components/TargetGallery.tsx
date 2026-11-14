"use client";
import { type SkyIndexEntry, skyFileUrl } from "@/lib/sky";

/**
 * The front door. A row of tiny text links told a first-time visitor nothing about what
 * they were choosing between, so each target gets its real stacked image as a thumbnail,
 * a plain-language label for what kind of object it is, and one line on what to watch for.
 */
export function TargetGallery({ targets, onPick }: {
  targets: SkyIndexEntry[];
  onPick: (t: SkyIndexEntry) => void;
}) {
  if (!targets.length) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((k) => (
          <div key={k} className="h-44 animate-pulse rounded-lg border border-line bg-panel" />
        ))}
      </div>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {targets.map((t) => (
        <button key={t.slug} onClick={() => onPick(t)}
          className="group flex gap-3 rounded-lg border border-line bg-panel p-3 text-left transition-colors hover:border-accent/60">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={skyFileUrl(t.slug, "stack.png")} alt=""
            className="h-20 w-20 shrink-0 rounded border border-line bg-black object-cover [image-rendering:pixelated]" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold group-hover:text-accent">{t.name}</div>
            {t.kind ? <div className="text-[10px] uppercase tracking-wide text-accent/80">{t.kind}</div> : null}
            <p className="mt-1 line-clamp-3 text-[11px] leading-snug text-muted">
              {t.look_for || t.note}
            </p>
            <div className="mt-1.5 flex flex-wrap gap-x-3 text-[10px] text-muted mono">
              <span>{t.n_visits} visits</span>
              <span>{(t.baseline_days / 365.25).toFixed(1)} yr</span>
              <span>{t.n_bands}/{t.bands_total} colours</span>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
