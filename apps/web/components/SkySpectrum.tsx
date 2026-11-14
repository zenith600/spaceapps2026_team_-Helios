"use client";
import { useEffect, useState } from "react";
import { Plot, darkLayout } from "@/components/Plot";
import { SourceTag } from "@/components/Tags";
import { type SkyBundle, type Spectrum, formatDec, formatRa, getSpectrum, mjdLabel } from "@/lib/sky";

const DETECTOR_COLOURS = ["#f59e0b", "#60a5fa", "#22c55e", "#f472b6", "#e6e8ee", "#a78bfa"];

/**
 * Flux against wavelength at one clicked pixel, assembled at click time from the
 * per-exposure cube. SPHEREx's filter gives each exposure of the same sky position a
 * different band, so a stack of exposures *is* a spectrum -- that is what makes this
 * possible without a dedicated spectral extraction.
 */
export function SkySpectrum({ bundle, pixel, radius, onRadius }: {
  bundle: SkyBundle;
  pixel: { x: number; y: number } | null;
  radius: number;
  onRadius: (r: number) => void;
}) {
  const [spec, setSpec] = useState<Spectrum | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [colourBy, setColourBy] = useState<"detector" | "visit">("detector");

  useEffect(() => {
    if (!pixel) { setSpec(null); setError(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getSpectrum(bundle, pixel.x, pixel.y, radius)
      .then((s) => { if (!cancelled) setSpec(s); })
      .catch((e) => { if (!cancelled) { setSpec(null); setError(String(e.message || e)); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [bundle, pixel, radius]);

  if (!pixel) {
    return (
      <div className="rounded border border-line bg-panel p-4 text-xs text-muted">
        <p className="mb-1 text-fg">Click any pixel in the image for its spectrum.</p>
        <p>
          Each SPHEREx exposure measures one wavelength at a given pixel, set by where that pixel
          falls on the linear variable filter. Stack the exposures of one position and you get a
          spectrum, built here in your browser the moment you click.
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
          <label className="flex items-center gap-1 text-muted">
            box
            <select value={radius} onChange={(e) => onRadius(Number(e.target.value))}
              className="rounded border border-line bg-panel px-1 py-0.5 mono">
              {[0, 1, 2, 3].map((r) => <option key={r} value={r}>{2 * r + 1}×{2 * r + 1}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1 text-muted">
            colour
            <select value={colourBy} onChange={(e) => setColourBy(e.target.value as "detector" | "visit")}
              className="rounded border border-line bg-panel px-1 py-0.5 mono">
              <option value="detector">detector</option>
              <option value="visit">visit</option>
            </select>
          </label>
        </div>
      </div>

      {error ? <p className="rounded border border-danger/40 bg-danger/10 p-2 text-[11px] text-danger">{error}</p> : null}
      {loading && !spec ? <p className="text-xs text-muted">building spectrum…</p> : null}

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
                  name: colourBy === "detector" ? `D${g}` : `visit ${g}`,
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
            <span className="mono text-accent">{spec.n_bands} of {spec.bands_total} bands measured here</span>
            <span className="text-muted mono">{spec.n_points} exposures · {(2 * radius + 1) ** 2}-pixel box</span>
            <SourceTag source={spec.source} />
          </div>
          <p className="text-[10px] text-muted">{spec.note}</p>
        </>
      ) : null}

      {spec && spec.points.length === 0 ? (
        <p className="text-xs text-muted">No good pixels at this position in any exposure — it is probably outside the
          overlap of the frames, or entirely flagged.</p>
      ) : null}
    </div>
  );
}
