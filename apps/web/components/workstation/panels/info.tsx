"use client";
import { useMemo, useState } from "react";
import { Clock, Columns2, Globe, Info, PanelRight, Search } from "lucide-react";
import { AladinPanel } from "@/components/AladinPanel";
import { SourceTag } from "@/components/Tags";
import { VisitCompare } from "@/components/VisitCompare";
import { type SkyBundle, formatDec, formatRa, mjdLabel, skyFileUrl } from "@/lib/sky";
import { cn } from "@/lib/utils";
import { usePB, useWS } from "../context";
import { Empty, Section } from "../ui";

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------
type Row = { group: string; k: string; v: string };

function metadataRows(b: SkyBundle, frameIdx: number, mode: string): Row[] {
  const rows: Row[] = [];
  const add = (group: string, k: string, v: unknown) => {
    if (v === undefined || v === null || v === "") return;
    rows.push({ group, k, v: Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v) });
  };
  const t = b.target;
  add("Target", "name", t?.name);
  add("Target", "kind", t?.kind);
  add("Target", "RA", `${formatRa(b.ra_deg)}  (${b.ra_deg.toFixed(6)}°)`);
  add("Target", "Dec", `${formatDec(b.dec_deg)}  (${b.dec_deg.toFixed(6)}°)`);
  add("Target", "resolved by", t?.resolver);
  add("Target", "query", t?.query);
  add("Target", "note", t?.note);

  if (mode === "epochs") {
    const e = b.frames.epochs[frameIdx];
    if (e) {
      add("Current exposure", "obs_id", e.obs_id);
      add("Current exposure", "date", `${mjdLabel(e.mjd)} · MJD ${e.mjd.toFixed(6)}`);
      add("Current exposure", "detector", e.detector);
      add("Current exposure", "wavelength µm", `${e.wave_um} ± ${(e.bandwidth_um / 2).toFixed(4)}`);
      add("Current exposure", "collection", e.collection);
      add("Current exposure", "visit", e.visit);
      add("Current exposure", "good pixels", `${(100 * e.good_fraction).toFixed(2)}%`);
      add("Current exposure", "PSF FWHM", `${e.psf_fwhm_arcsec}″`);
      for (const [k, v] of Object.entries(e.flags)) add("Current exposure", `flag ${k}`, `${(100 * v).toFixed(2)}%`);
    }
  }

  add("Instrument & data", "source", b.source);
  add("Instrument & data", "simulated", b.is_simulated === undefined ? undefined : b.is_simulated ? "yes" : "no");
  add("Instrument & data", "image", `${b.npix} × ${b.npix} px`);
  add("Instrument & data", "pixel scale", `${b.pixel_arcsec}″`);
  add("Instrument & data", "field of view", `${b.fov_deg}°`);
  add("Instrument & data", "wavelengths", `${b.coverage.wave_min_um.toFixed(3)}–${b.coverage.wave_max_um.toFixed(3)} µm`);
  add("Instrument & data", "bands measured", `${b.coverage.n_bands} of ${b.coverage.bands_total}`);
  add("Instrument & data", "detectors", b.coverage.detectors);
  add("Instrument & data", "brightness unit", b.scale.unit);

  if (b.wcs) {
    const w = b.wcs;
    add("WCS (reprojected grid)", "CTYPE1", w.ctype[0]); add("WCS (reprojected grid)", "CTYPE2", w.ctype[1]);
    add("WCS (reprojected grid)", "CRVAL1", w.crval[0]); add("WCS (reprojected grid)", "CRVAL2", w.crval[1]);
    add("WCS (reprojected grid)", "CRPIX1", w.crpix[0]); add("WCS (reprojected grid)", "CRPIX2", w.crpix[1]);
    add("WCS (reprojected grid)", "CDELT1", w.cdelt[0]); add("WCS (reprojected grid)", "CDELT2", w.cdelt[1]);
  }

  const c = b.coverage;
  add("Coverage", "exposures available", c.n_exposures_available);
  add("Coverage", "requested / used / skipped", `${c.n_requested} / ${c.n_used} / ${c.n_skipped}`);
  add("Coverage", "visits", c.n_visits);
  add("Coverage", "first", `${mjdLabel(c.mjd_min)} · MJD ${c.mjd_min.toFixed(5)}`);
  add("Coverage", "last", `${mjdLabel(c.mjd_max)} · MJD ${c.mjd_max.toFixed(5)}`);
  add("Coverage", "baseline", `${c.baseline_days.toFixed(2)} d`);
  for (const v of b.visits) add("Visits", `visit ${v.visit} · ${v.label}`, `${v.n_exposures} exposures · ${mjdLabel(v.mjd_start)} → ${mjdLabel(v.mjd_end)}`);

  add("Provenance", "collections searched", b.search.collections_searched);
  add("Provenance", "collections published", b.search.collections_available);
  add("Provenance", "collection source", b.search.collection_source);
  const sx = b.search as SkyBundle["search"] & { searched_at?: string; per_collection?: Record<string, { n: number; latest_mjd: number | null }> };
  add("Provenance", "searched at", sx.searched_at);
  for (const [k, v] of Object.entries(sx.per_collection ?? {})) {
    add("Provenance", k, `${v.n} exposures${v.latest_mjd ? ` · latest ${mjdLabel(v.latest_mjd)}` : ""}`);
  }
  add("Provenance", "built at", b.freshness?.built_at ?? b.generated_at);

  add("Processing history", "schema", b.schema_version);
  add("Processing history", "generated", b.generated_at);
  add("Processing history", "build time", b.elapsed_s !== undefined ? `${b.elapsed_s} s` : undefined);
  add("Processing history", "stretch", `${b.scale.mode} ${b.scale.vmin.toFixed(4)}–${b.scale.vmax.toFixed(4)} ${b.scale.unit} — ${b.scale.note}`);
  add("Processing history", "stack", `${b.stack.n} exposures — ${b.stack.note}`);
  add("Processing history", "static sky", `${b.static.method} — ${b.static.note}`);
  add("Processing history", "difference frames", `${b.difference.length} (each visit − visit ${b.difference[0]?.reference_visit ?? 0})`);
  add("Processing history", "cube", b.cube_u16 ? `${b.cube_u16.shape.join(" × ")} uint16 (${b.cube_u16.planes.join(", ")})` : "not exported");
  add("Processing history", "classifier", b.classify?.note);
  add("Processing history", "pixel quality", b.pixel_quality?.note);
  b.limits.forEach((l, k) => add("Known limits", `${k + 1}`, l));
  return rows;
}

export function MetadataPanel() {
  const ws = useWS();
  const pb = usePB();
  const [q, setQ] = useState("");
  const b = ws.bundle;
  const frameKey = ws.mode === "epochs" ? pb.i : -1;
  const rows = useMemo(() => (b ? metadataRows(b, frameKey, ws.mode) : []), [b, frameKey, ws.mode]);
  if (!b) return <Empty icon={Info}>Open a field to inspect its metadata.</Empty>;
  const needle = q.trim().toLowerCase();
  const shown = needle ? rows.filter((r) => `${r.group} ${r.k} ${r.v}`.toLowerCase().includes(needle)) : rows;
  const groups = Array.from(new Set(shown.map((r) => r.group)));
  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-ws-edge bg-ws-panel px-2 py-1.5">
        <Search size={12} className="text-ws-dim" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter metadata (e.g. CDELT, flag, visit 3)"
          aria-label="Filter metadata"
          className="h-6 min-w-0 flex-1 rounded-[3px] border border-ws-line bg-ws-bg px-1.5 text-[11px] outline-none placeholder:text-ws-dim focus:border-ws-sel" />
        <span className="mono text-[10px] text-ws-dim">{shown.length}</span>
      </div>
      {groups.map((g) => (
        <Section key={g} title={g} defaultOpen={g !== "Visits" && g !== "Known limits" || Boolean(needle)}>
          {shown.filter((r) => r.group === g).map((r, k) => (
            <div key={k} className="flex gap-2 py-px text-[11px]">
              <span className={cn("w-[38%] shrink-0 truncate text-ws-muted", g.startsWith("WCS") && "mono text-[10.5px]")} title={r.k}>{r.k}</span>
              <span className="mono min-w-0 flex-1 select-text break-words text-[10.5px] text-ws-fg">{r.v}</span>
            </div>
          ))}
          {g.startsWith("WCS") ? <p className="pt-1 text-[10px] leading-snug text-ws-dim">The common grid every exposure was reprojected onto — not the original Level 2 FITS headers, which are not shipped with the view.</p> : null}
        </Section>
      ))}
      {!shown.length ? <Empty>Nothing matches “{q}”.</Empty> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
export function HistoryPanel() {
  const ws = useWS();
  const h = ws.history;
  const all = [...h.past, h.present, ...h.future];
  const cur = h.past.length;
  return (
    <div>
      <ol className="py-0.5">
        {all.map((e, k) => (
          <li key={k}>
            <button type="button" onClick={() => ws.jump(k)}
              className={cn("flex w-full items-center gap-2 px-2 py-1 text-left text-[11.5px]",
                k === cur ? "bg-ws-selbg text-ws-fg" : k > cur ? "text-ws-dim hover:bg-ws-raised" : "text-ws-fg hover:bg-ws-raised")}>
              <Clock size={11} className="shrink-0 text-ws-dim" />
              <span className="min-w-0 flex-1 truncate">{e.label}</span>
              {k === cur ? <span className="text-[10px] text-ws-sel">current</span> : null}
            </button>
          </li>
        ))}
      </ol>
      <p className="border-t border-ws-edge px-2 py-1.5 text-[10.5px] leading-snug text-ws-dim">
        Layer settings, probe, aperture, measurement and analysis parameters. The field, mode and field size are in the
        address bar instead, so the browser&apos;s back button and shared links cover those.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
export function TargetsPanel() {
  const ws = useWS();
  const s = ws.session;
  const [q, setQ] = useState("");
  return (
    <div>
      <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) s.show(q.trim()); }}
        className="flex items-center gap-1.5 border-b border-ws-edge px-2 py-1.5">
        <Search size={12} className="text-ws-dim" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or RA Dec, then Enter" aria-label="Open a field"
          className="h-6 min-w-0 flex-1 rounded-[3px] border border-ws-line bg-ws-bg px-1.5 text-[11px] outline-none placeholder:text-ws-dim focus:border-ws-sel" />
      </form>
      <ul>
        {s.index.map((t) => {
          const on = s.target?.name === t.name;
          return (
            <li key={t.slug}>
              <button type="button" onClick={() => s.show(t.name)}
                className={cn("flex w-full gap-2 border-b border-ws-edge/70 px-2 py-1.5 text-left", on ? "bg-ws-selbg" : "hover:bg-ws-raised")}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={skyFileUrl(t.slug, "stack.png")} alt="" className="h-10 w-10 shrink-0 rounded-[2px] bg-black [image-rendering:pixelated]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11.5px] text-ws-fg">{t.name}</div>
                  {t.kind ? <div className="truncate text-[10px] uppercase tracking-wide text-accent/80">{t.kind}</div> : null}
                  <div className="mono text-[10px] text-ws-muted">{t.n_visits} visits · {(t.baseline_days / 365.25).toFixed(1)} yr · {t.n_bands}/{t.bands_total} bands</div>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
      {!s.index.length ? <Empty>No ready-made fields in this deployment.</Empty> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
export function ContextPanel() {
  const ws = useWS();
  const s = ws.session;
  const b = ws.bundle;
  if (!b) return <Empty icon={Globe}>Open a field for its description and sky context.</Empty>;
  const lookFor = s.target?.look_for || s.entry?.look_for || "";
  const e = s.explain;
  return (
    <div>
      <Section title="About this field">
        {lookFor ? (
          <p className="text-[11.5px] leading-snug text-ws-fg"><span className="font-semibold text-accent">What to look for: </span>{lookFor}</p>
        ) : e ? (
          <>
            <p className="text-[11.5px] leading-snug text-ws-fg">{e.text}</p>
            <p className="pt-1 text-[10px] text-ws-dim">
              {e.generator.startsWith("llm:")
                ? `Written automatically by ${e.generator.slice(4)} from measured survey statistics.`
                : "Generated from measured survey statistics."} {e.disclaimer}
            </p>
          </>
        ) : <p className="text-[11px] text-ws-muted">No description for this position.</p>}
        <p className="mono pt-1.5 text-[10.5px] text-ws-muted">
          RA {formatRa(b.ra_deg)} · Dec {formatDec(b.dec_deg)}
          <span className="opacity-70"> ({b.ra_deg.toFixed(5)}, {b.dec_deg.toFixed(5)})</span>
        </p>
        <p className="pt-0.5 text-[10px] text-ws-dim">
          {s.target?.resolver === "builtin" ? "from our catalogue" : s.target?.resolver === "coords" ? "the coordinates you typed" : s.target ? "resolved by CDS" : ""}
        </p>
        <div className="pt-1.5"><SourceTag source={b.source} /></div>
      </Section>
      <Section title="Where this is on the sky">
        <AladinPanel ra={b.ra_deg} dec={b.dec_deg} fovDeg={b.fov_deg} name={s.target?.name ?? "this field"} />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
export function ComparePanel() {
  const ws = useWS();
  if (!ws.bundle) return <Empty icon={Columns2}>Open a field to compare its visits.</Empty>;
  return (
    <div className="px-2 py-2">
      <VisitCompare bundle={ws.bundle} />
      <p className="pt-2 text-[10px] leading-snug text-ws-dim">
        A real subtraction of calibrated surface brightness (inverse-variance coadd per visit), not of the display images.
      </p>
    </div>
  );
}

export function NoPanels() {
  const ws = useWS();
  return (
    <Empty icon={PanelRight}>
      All panels are closed. Reopen them from <button type="button" className="text-ws-sel underline" onClick={() => ws.openPanel("layers")}>Window ▸ Panels</button>.
    </Empty>
  );
}
