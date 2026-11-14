"use client";
import { useEffect, useState } from "react";
import { Plot, darkLayout } from "@/components/Plot";
import { Button } from "@/components/ui/button";
import { SourceTag } from "@/components/Tags";
import {
  type Classification, type SkyBundle, type Spectrum,
  formatDec, formatRa, getClassification, getSpectrum, mjdLabel,
} from "@/lib/sky";
import { cn } from "@/lib/utils";

const DETECTOR_COLOURS = ["#f59e0b", "#60a5fa", "#22c55e", "#f472b6", "#e6e8ee", "#a78bfa"];

/**
 * Flux against wavelength at one clicked pixel, assembled at click time from the
 * per-exposure cube. SPHEREx's filter gives each exposure of the same sky position a
 * different band, so a stack of exposures *is* a spectrum -- that is what makes this
 * possible without a dedicated spectral extraction.
 */
export function SkySpectrum({ bundle, pixel, radius, onRadius, onJump }: {
  bundle: SkyBundle;
  pixel: { x: number; y: number } | null;
  radius: number;
  onRadius: (r: number) => void;
  onJump?: (p: { x: number; y: number }) => void;
}) {
  const [spec, setSpec] = useState<Spectrum | null>(null);
  const [cls, setCls] = useState<Classification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [colourBy, setColourBy] = useState<"detector" | "visit">("detector");

  useEffect(() => {
    if (!pixel) { setSpec(null); setCls(null); setError(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getSpectrum(bundle, pixel.x, pixel.y, radius)
      .then((s) => { if (!cancelled) setSpec(s); })
      .catch((e) => { if (!cancelled) { setSpec(null); setError(String(e.message || e)); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    getClassification(bundle, pixel.x, pixel.y, radius)
      .then((c) => { if (!cancelled) setCls(c); })
      .catch(() => { if (!cancelled) setCls(null); });
    return () => { cancelled = true; };
  }, [bundle, pixel, radius]);

  if (!pixel) {
    return (
      <div className="rounded-lg border border-dashed border-line bg-panel p-4 text-xs text-muted">
        <p className="mb-1.5 text-sm font-medium text-fg">Click anywhere on the image →</p>
        <p className="mb-2">
          You&apos;ll get a <strong className="text-fg">spectrum</strong> for that exact spot: how bright
          it is at each infrared colour. That is how astronomers tell what something is made of — water,
          methane and carbon dioxide each absorb their own colours.
        </p>
        <p className="text-muted/80">
          SPHEREx measures one colour per pixel per shot, so every exposure of this patch contributes a
          different point. We assemble them the moment you click.
        </p>
      </div>
    );
  }

  const groups = spec ? Array.from(new Set(spec.points.map((p) => (colourBy === "detector" ? p.detector : p.visit)))).sort((a, b) => a - b) : [];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <span className="mono">
          pixel ({pixel.x}, {pixel.y})
          {spec ? <> · {formatRa(spec.ra_deg)} {formatDec(spec.dec_deg)}</> : null}
        </span>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-muted" title="Average over a larger area for less noise">
            area
            <select value={radius} onChange={(e) => onRadius(Number(e.target.value))}
              className="rounded border border-line bg-panel px-1 py-0.5">
              {[0, 1, 2, 3].map((r) => (
                <option key={r} value={r}>{["1 pixel", "3×3", "5×5", "7×7"][r]}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1 text-muted" title="How the points are grouped by colour">
            group by
            <select value={colourBy} onChange={(e) => setColourBy(e.target.value as "detector" | "visit")}
              className="rounded border border-line bg-panel px-1 py-0.5">
              <option value="detector">camera</option>
              <option value="visit">visit</option>
            </select>
          </label>
        </div>
      </div>

      {error ? <p className="rounded border border-danger/40 bg-danger/10 p-2 text-[11px] text-danger">{error}</p> : null}
      {loading && !spec ? <p className="text-xs text-muted">building spectrum…</p> : null}

      {/* A saturated core is a real instrumental limit, not a broken panel. Say so. */}
      {spec?.quality?.reason ? (
        <div className={cn("flex flex-col gap-2 rounded border p-2 text-[11px]",
          spec.quality.saturated ? "border-accent/40 bg-accent/10" : "border-line bg-panel")}>
          <p className={spec.quality.saturated ? "text-accent" : "text-muted"}>{spec.quality.reason}</p>
          <div className="flex flex-wrap items-center gap-2 text-muted">
            <span className="mono">{spec.quality.n_usable} of {spec.quality.n_exposures} exposures usable here</span>
            {spec.quality.flags.length ? (
              <span className="mono">· flagged: {spec.quality.flags.map((f) => f.replace("_", " ")).join(", ")}</span>
            ) : null}
          </div>
          {spec.quality.nearest_usable && onJump ? (
            <div>
              <Button size="sm" variant="outline"
                onClick={() => onJump({ x: spec.quality.nearest_usable!.x, y: spec.quality.nearest_usable!.y })}>
                jump {spec.quality.nearest_usable.distance_arcsec}″ to the nearest usable pixel
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {spec && spec.points.length > 0 ? (
        <>
          <div className="h-60">
            <Plot
              data={groups.map((g, k) => {
                const pts = spec.points.filter((p) => (colourBy === "detector" ? p.detector : p.visit) === g);
                return {
                  x: pts.map((p) => p.wave_um),
                  y: pts.map((p) => p.flux_mjysr),
                  error_y: { type: "data", array: pts.map((p) => p.flux_err_mjysr), visible: true, color: "#8b91a3", thickness: 1 },
                  error_x: { type: "data", array: pts.map((p) => p.bandwidth_um / 2), visible: true, color: "#8b91a3", thickness: 1 },
                  mode: "markers", type: "scatter",
                  name: colourBy === "detector" ? `camera ${g}` : `visit ${g}`,
                  marker: { color: DETECTOR_COLOURS[k % DETECTOR_COLOURS.length], size: 7 },
                  text: pts.map((p) => `${p.obs_id}<br>${mjdLabel(p.mjd)}<br>D${p.detector} · visit ${p.visit}`),
                  hovertemplate: "%{x:.3f} µm<br>%{y:.4f} MJy/sr<br>%{text}<extra></extra>",
                };
              })}
              layout={{
                ...darkLayout,
                showlegend: true,
                legend: { orientation: "h", y: 1.15, font: { size: 10, color: "#8b91a3" } },
                xaxis: { ...darkLayout.xaxis, title: { text: "wavelength (µm)" } },
                yaxis: { ...darkLayout.yaxis, title: { text: "surface brightness (MJy/sr)" } },
              }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
            <span className="text-accent">
              <span className="mono">{spec.n_bands}</span> of SPHEREx&apos;s {spec.bands_total} colours measured here
            </span>
            <span className="text-muted">from <span className="mono">{spec.n_points}</span> separate exposures</span>
            <SourceTag source={spec.source} />
          </div>
          {/* What does that shape look like? Templates, not a trained model. */}
          {cls?.available ? (
            <div className="rounded-lg border border-line bg-panel p-2.5">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-xs text-muted">Shape looks</span>
                <span className="text-sm font-semibold text-accent">{cls.label}</span>
                {!cls.confident ? (
                  <span className="text-[10px] text-muted">(close call — other shapes fit nearly as well)</span>
                ) : null}
              </div>
              <p className="mt-1 text-[11px] text-muted">{cls.meaning}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted">
                {cls.temperature?.temperature_k ? (
                  <span>colour temperature <span className="mono text-fg">{cls.temperature.temperature_k} K</span></span>
                ) : null}
                {cls.methane_score != null ? (
                  <span>methane score <span className="mono text-fg">{cls.methane_score.toFixed(2)}</span></span>
                ) : null}
              </div>
              <details className="mt-1.5 text-[10px] text-muted">
                <summary className="cursor-pointer select-none hover:text-fg">How this is worked out</summary>
                <p className="mt-1">{cls.method}</p>
                <p className="mt-1">
                  {cls.ranking?.map((r) => `${r.label}: χ²/dof ${r.chi2_per_dof}`).join(" · ")}
                </p>
                <p className="mt-1 text-accent/80">{cls.caveat}</p>
              </details>
            </div>
          ) : cls && !cls.available ? (
            <p className="text-[11px] text-muted">Shape not classified: {cls.reason}</p>
          ) : null}

          <p className="text-[10px] text-muted">{spec.note}</p>
        </>
      ) : null}

    </div>
  );
}
