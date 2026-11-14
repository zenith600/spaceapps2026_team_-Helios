"use client";
import { RotateCcw, SlidersHorizontal, Play, LoaderCircle } from "lucide-react";
import { MODES } from "@/components/SkyPlayer";
import { DEMO } from "@/lib/api";
import { CHANGE_DEFAULTS, mjdLabel, pixelToSky, skyFileUrl } from "@/lib/sky";
import { cn } from "@/lib/utils";
import { changeKey, keyOf } from "@/lib/workstation/derived";
import { BLEND_MODES, type ResolvedLayer } from "@/lib/workstation/layers";
import { formatArcsec, measure } from "@/lib/workstation/measure";
import { formatBytes, resourceStatus } from "@/lib/workstation/perf";
import { fmtCoord } from "../chrome";
import { usePB, useWS } from "../context";
import { Check, Empty, KV, Section, Select, Slider, StateChip, TextBtn } from "../ui";

export function PropertiesPanel() {
  const ws = useWS();
  const l = ws.layer(ws.selected);
  if (!ws.bundle || !l) return <Empty icon={SlidersHorizontal}>Select a layer to see its properties.</Empty>;
  const b = ws.bundle;
  const n = l.node;
  const locked = l.config.locked;

  return (
    <div>
      <div className="border-b border-ws-edge px-2 py-2">
        <div className="text-[12.5px] font-medium text-ws-fg">{l.name}</div>
        <div className="text-[10.5px] text-ws-muted">{n.typeLabel}{locked ? " · locked" : ""}{!n.available ? " · not available here" : ""}</div>
        {!n.available && n.unavailableReason ? <p className="mt-1 text-[10.5px] text-ws-warn">{n.unavailableReason}</p> : null}
      </div>

      {n.kind === "frames" ? <FramesProps l={l} /> : null}
      {n.kind === "change" ? <ChangeProps /> : null}
      {n.kind === "catalog" ? <CatalogProps id={n.id} /> : null}
      {n.kind === "flags" ? <FlagsProps /> : null}
      {n.kind === "probe" ? <ProbeProps /> : null}
      {n.kind === "measure" ? <MeasureProps /> : null}

      {n.canOpacity || n.canBlend ? (
        <Section title="Display">
          {n.canOpacity ? (
            <Slider label="Opacity" min={0} max={1} step={0.01} value={l.config.opacity} disabled={locked}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => ws.setLayer(n.id, { opacity: v }, `Opacity ${l.name}`, `opacity-${n.id}`)} />
          ) : null}
          {n.canBlend ? (
            <>
              <div className="flex items-center gap-2 py-0.5 text-[11px]">
                <span className="w-[34%] text-ws-muted">Blend</span>
                <Select label="Blend mode" value={l.config.blend} disabled={locked} className="flex-1"
                  options={BLEND_MODES.map((m) => ({ value: m.id, label: m.label }))}
                  onChange={(v) => ws.setLayer(n.id, { blend: v }, `Blend ${l.name}: ${v}`)} />
              </div>
              <p className="pt-0.5 text-[10.5px] leading-snug text-ws-dim">{BLEND_MODES.find((m) => m.id === l.config.blend)?.note}</p>
            </>
          ) : null}
          {l.depth > 0 && l.opacity !== l.config.opacity ? (
            <KV k="effective" v={`${Math.round(l.opacity * 100)}% (with group)`} />
          ) : null}
        </Section>
      ) : null}

      <Section title="Source & provenance">
        <KV k="dataset" v={b.slug} />
        <KV k="built" v={b.generated_at.replace("T", " ").replace("+00:00", " UTC")} />
        {n.source.files.length ? <KV k="refers to" v={n.source.files.join(", ")} /> : null}
        <KV k="observation time" v={observationTime(l, ws)} mono={false} />
        <KV k="resolution" v={`${b.npix} × ${b.npix} px · ${b.pixel_arcsec}″/px`} />
        <KV k="field" v={`${b.fov_deg}° (${formatArcsec(b.fov_deg * 3600)})`} />
        <KV k="state" v={processingState(l, ws)} mono={false} />
        <KV k="load / cache" v={<CacheStatus l={l} />} mono={false} />
        <p className="pt-1 text-[10.5px] leading-snug text-ws-muted">{n.source.note}</p>
      </Section>
    </div>
  );
}

function observationTime(l: ResolvedLayer, ws: ReturnType<typeof useWS>): string {
  const cov = ws.bundle!.coverage;
  switch (l.node.temporal) {
    case "per-frame": return "changes with the timeline (see Frame)";
    case "all-exposures": return `${mjdLabel(cov.mjd_min)} → ${mjdLabel(cov.mjd_max)}`;
    case "epochs-only": return "the current single exposure";
    case "static": return "catalogue epoch — not this survey's time axis";
    default: return "—";
  }
}

function processingState(l: ResolvedLayer, ws: ReturnType<typeof useWS>): React.ReactNode {
  const k = l.node.kind;
  if (k === "change") {
    const c = ws.change;
    return c.state === "idle" ? "not computed" : c.state === "running" ? <StateChip state="processing" />
      : c.state === "error" ? <span className="text-ws-err">{c.error}</span>
      : c.state === "cancelled" ? <StateChip state="cancelled" /> : <StateChip state={c.fromCache ? "cached" : "completed"} />;
  }
  if (k === "probe" || k === "measure" || k === "group") return "—";
  if (k === "catalog") return "baked with the bundle (overlay.json)";
  return "baked by the build pipeline";
}

function CacheStatus({ l }: { l: ResolvedLayer }) {
  const ws = useWS();
  const pb = usePB();
  const b = ws.bundle!;
  const k = l.node.kind;
  if (k === "frames") return <span>{ws.loaded.count} of {ws.loaded.total} frames decoded by the browser</span>;
  const url = k === "stack" ? skyFileUrl(b.slug, b.stack.png) : k === "static" ? skyFileUrl(b.slug, b.static.png)
    : k === "flags" && pb.frame?.flagPng ? skyFileUrl(b.slug, pb.frame.flagPng) : null;
  if (k === "change") return <span>{ws.change.fromCache ? "served from the derived-result cache" : ws.change.report ? "computed, held in the derived-result cache" : "nothing cached"}</span>;
  if (!url) return <span className="text-ws-dim">—</span>;
  const s = resourceStatus(url);
  return (
    <span>
      {s.state === "not-requested" ? "not loaded yet (loads when shown)"
        : s.state === "cache" ? `from browser cache · ${formatBytes(s.bytes)}`
        : s.state === "network" ? `downloaded · ${formatBytes(s.bytes)}` : "loaded (size not reported cross-origin)"}
    </span>
  );
}

// ---------------------------------------------------------------------------
function FramesProps({ l }: { l: ResolvedLayer }) {
  const ws = useWS();
  const pb = usePB();
  const b = ws.bundle!;
  const f = pb.frame;
  const m = MODES.find((x) => x.id === ws.mode);
  const epoch = ws.mode === "epochs" ? b.frames.epochs[pb.i] : null;
  const locked = l.config.locked;
  const adjusted = l.config.brightness !== 1 || l.config.contrast !== 1 || l.config.invert;
  return (
    <>
      <Section title="Frame">
        {f ? (
          <>
            <KV k="frame" v={`${pb.i + 1} / ${pb.n} · ${f.id}`} />
            <KV k="date" v={`${f.title} · MJD ${f.mjd.toFixed(5)}`} />
            <KV k="what" v={f.subtitle} mono={false} />
            <KV k="detail" v={f.detail} />
            {epoch ? (
              <>
                <KV k="wavelength" v={`${epoch.wave_um.toFixed(4)} µm ± ${(epoch.bandwidth_um / 2).toFixed(4)}`} />
                <KV k="detector" v={`D${epoch.detector} · ${epoch.collection}`} />
                <KV k="good pixels" v={`${(100 * epoch.good_fraction).toFixed(1)}%`} />
                <KV k="PSF FWHM" v={`${epoch.psf_fwhm_arcsec}″`} />
              </>
            ) : null}
          </>
        ) : null}
        <p className="pt-1 text-[10.5px] leading-snug text-ws-muted">{m?.hint}</p>
        {ws.mode === "difference" ? (
          <div className="mt-1.5 flex items-center gap-3 text-[10.5px] text-ws-muted">
            <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 border border-ws-line bg-black" /> fainter</span>
            <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 border border-ws-line" style={{ background: "#808080" }} /> unchanged</span>
            <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 border border-ws-line bg-white" /> brighter</span>
          </div>
        ) : null}
        {ws.mode === "colour" && b.colour?.channels ? (
          <div className="mt-1.5 flex flex-col gap-0.5">
            {b.colour.channels.map((c) => <KV key={c.colour} k={c.colour} v={`${c.range_um} · ${c.role}`} />)}
          </div>
        ) : null}
      </Section>
      <Section title="Adjustments" right={adjusted && !locked ? (
        <button type="button" onClick={() => ws.setLayer("frames", { brightness: 1, contrast: 1, invert: false }, "Reset adjustments")}
          className="flex items-center gap-1 text-[10px] text-ws-muted hover:text-ws-fg" title="Reset adjustments"><RotateCcw size={10} />reset</button>
      ) : null}>
        <Slider label="Brightness" min={0.3} max={3} step={0.05} value={l.config.brightness} disabled={locked}
          format={(v) => v.toFixed(2)} onChange={(v) => ws.setLayer("frames", { brightness: v }, "Brightness", "brightness")} />
        <Slider label="Contrast" min={0.3} max={3} step={0.05} value={l.config.contrast} disabled={locked}
          format={(v) => v.toFixed(2)} onChange={(v) => ws.setLayer("frames", { contrast: v }, "Contrast", "contrast")} />
        <Check label="Invert" checked={l.config.invert} disabled={locked}
          onChange={(v) => ws.setLayer("frames", { invert: v }, v ? "Invert" : "Un-invert")} />
        <p className="pt-1 text-[10.5px] leading-snug text-ws-dim">
          Display only: applied to the rendered frame on screen. Spectra, statistics and change detection always use the
          calibrated cube. The baked stretch is {b.scale.mode}, {b.scale.vmin.toFixed(3)}–{b.scale.vmax.toFixed(3)} {b.scale.unit}.
        </p>
      </Section>
    </>
  );
}

function ChangeProps() {
  const ws = useWS();
  const b = ws.bundle!;
  const c = ws.change;
  const p = ws.doc.change;
  const editable = DEMO && Boolean(b.cube_u16);
  const key = keyOf(changeKey(b, p, DEMO));
  const isDefault = p.deg === CHANGE_DEFAULTS.deg && p.floor === CHANGE_DEFAULTS.floor && p.threshold === CHANGE_DEFAULTS.threshold;
  return (
    <>
      <Section title="Operation">
        <div className="flex items-center gap-2 pb-1">
          <TextBtn primary onClick={ws.runChange} disabled={c.state === "running"}>
            {c.state === "running" ? <LoaderCircle size={11} className="animate-spin" /> : <Play size={11} />}
            {c.state === "ready" ? "Run again" : "Run"}
          </TextBtn>
          <span className="text-[10.5px] text-ws-muted">{DEMO ? "computed in this browser from the cube" : "computed by the API"}</span>
        </div>
        <Select label="Polynomial degree in wavelength" value={p.deg} disabled={!editable}
          options={[1, 2, 3].map((d) => ({ value: d, label: `degree ${d} in wavelength` }))}
          onChange={(v) => ws.setChangeParams({ deg: v })} />
        <Slider label="Error floor" min={0} max={0.2} step={0.01} value={p.floor} disabled={!editable}
          format={(v) => v.toFixed(2)} onChange={(v) => ws.setChangeParams({ floor: v })} />
        <Slider label="Threshold z" min={3} max={10} step={0.5} value={p.threshold} disabled={!editable}
          format={(v) => v.toFixed(1)} onChange={(v) => ws.setChangeParams({ threshold: v })} />
        <div className="flex items-center justify-between pt-0.5">
          <span className="text-[10.5px] text-ws-dim">
            {editable ? "Editing re-runs this step only; earlier results stay cached." : "The API route takes no parameters; server defaults apply."}
          </span>
          {editable && !isDefault ? (
            <button type="button" className="flex items-center gap-1 text-[10px] text-ws-muted hover:text-ws-fg"
              onClick={() => ws.apply((d) => ({ ...d, change: CHANGE_DEFAULTS }), "Reset change-detection parameters")}>
              <RotateCcw size={10} />defaults
            </button>
          ) : null}
        </div>
      </Section>
      {c.report ? (
        <Section title={`Result · ${c.report.peaks.length} peaks`}>
          <KV k="significant px" v={c.report.n_significant_pixels} />
          <KV k="median χ²/dof" v={c.report.median_chi2_per_dof ?? "—"} />
          <KV k="MAD χ²/dof" v={c.report.mad_chi2_per_dof ?? "—"} />
          <KV k="threshold" v={`z > ${c.report.threshold}`} />
          {c.ms !== null ? <KV k="time" v={c.fromCache ? "cache hit" : `${c.ms} ms`} /> : null}
          <div className="mt-1.5 flex flex-wrap gap-1">
            {c.report.peaks.map((pk, k) => (
              <button key={k} type="button" onClick={() => { ws.pick({ x: pk.x, y: pk.y }); ws.setTool("probe"); }}
                title={`χ²/dof ${pk.chi2_per_dof} · ${pk.n_used} exposures — click to probe`}
                className={cn("mono rounded-[2px] border px-1.5 py-px text-[10px]",
                  ws.doc.pixel?.x === pk.x && ws.doc.pixel?.y === pk.y ? "border-ws-sel bg-ws-selbg text-ws-fg" : "border-ws-line text-ws-muted hover:text-ws-fg")}>
                ({pk.x},{pk.y}) z {pk.z}
              </button>
            ))}
          </div>
          <p className="pt-1.5 text-[10.5px] leading-snug text-ws-warn/90">{c.report.caveat}</p>
          <details className="pt-1 text-[10.5px] text-ws-muted">
            <summary className="cursor-pointer select-none hover:text-ws-fg">Method</summary>
            <p className="pt-1 leading-snug">{c.report.method}</p>
          </details>
        </Section>
      ) : c.state === "error" ? (
        <Section title="Result"><p className="text-[11px] text-ws-err">{c.error}</p></Section>
      ) : null}
      <Section title="Cache identity" defaultOpen={false}>
        <p className="mono break-all text-[10px] text-ws-muted">{key}</p>
        <p className="pt-1 text-[10.5px] text-ws-dim">Dataset build, operation version and every parameter. Change one and only this result is recomputed.</p>
      </Section>
    </>
  );
}

function CatalogProps({ id }: { id: string }) {
  const ws = useWS();
  const c = ws.session.overlay?.layers.find((x) => `cat:${x.id}` === id);
  if (!c) return null;
  return (
    <Section title="Catalogue">
      <KV k="survey" v={c.name} mono={false} />
      <KV k="from" v={c.owner} mono={false} />
      <KV k="band" v={c.band ?? "—"} />
      <KV k="sources" v={c.n} />
      <KV k="marker" v={<span className="inline-block h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: c.colour }} />} />
      <p className="pt-1 text-[10.5px] leading-snug text-ws-muted">{c.note}</p>
      <p className="pt-1 text-[10.5px] leading-snug text-ws-dim">A dot with no ring is not in these catalogues — too faint for them, or it has moved.</p>
    </Section>
  );
}

function FlagsProps() {
  const ws = useWS();
  const pb = usePB();
  const b = ws.bundle!;
  const e = ws.mode === "epochs" ? b.frames.epochs[pb.i] : null;
  return (
    <Section title="Quality flags">
      {b.flag_legend.map((l) => (
        <div key={l.id} className="flex items-start gap-1.5 py-0.5 text-[11px]">
          <span className="mt-1 inline-block h-2 w-2 shrink-0 rounded-[1px]" style={{ background: l.colour }} />
          <span className="w-[72px] shrink-0 text-ws-fg">{l.id.replace("_", " ")}</span>
          <span className="mono text-[10px] text-ws-muted">{l.flags.join(" ")}</span>
        </div>
      ))}
      {e ? (
        <div className="mt-1.5 border-t border-ws-line/60 pt-1.5">
          <div className="pb-0.5 text-[10.5px] text-ws-muted">This exposure, fraction of pixels flagged</div>
          {Object.entries(e.flags).sort((a, b2) => b2[1] - a[1]).map(([k, v]) => (
            <KV key={k} k={k} v={`${(100 * v).toFixed(2)}%`} />
          ))}
        </div>
      ) : null}
    </Section>
  );
}

function ProbeProps() {
  const ws = useWS();
  const b = ws.bundle!;
  const p = ws.doc.pixel;
  if (!p) return <Section title="Probe"><p className="text-[11px] text-ws-muted">No pixel picked. Use the spectral probe (I) and click the image.</p></Section>;
  const sky = pixelToSky(b, p.x, p.y);
  const pq = b.pixel_quality;
  const bits = pq ? pq.flag_class[p.y * b.npix + p.x] ?? 0 : 0;
  const flags = pq ? pq.classes.filter((_c, i) => bits & (1 << i)) : [];
  return (
    <Section title="Probe">
      <KV k="pixel" v={`(${p.x}, ${p.y})`} />
      <KV k="sky" v={fmtCoord(sky.ra_deg, sky.dec_deg, ws.prefs.coordFormat)} />
      <KV k="aperture" v={`${2 * ws.doc.radius + 1} × ${2 * ws.doc.radius + 1} px`} />
      <KV k="ever flagged" v={flags.length ? flags.join(", ") : "none"} />
      <div className="pt-1"><TextBtn onClick={() => ws.openPanel("spectrum")}>Open Spectral Data</TextBtn></div>
    </Section>
  );
}

function MeasureProps() {
  const ws = useWS();
  const b = ws.bundle!;
  const r = ws.doc.ruler;
  if (!r) return <Section title="Measurement"><p className="text-[11px] text-ws-muted">Nothing measured. Use Measure (M) and drag across the image.</p></Section>;
  const m = measure(b, r.a, r.b);
  const A = pixelToSky(b, r.a.x, r.a.y), B = pixelToSky(b, r.b.x, r.b.y);
  return (
    <Section title="Measurement">
      <KV k="separation" v={`${formatArcsec(m.arcsec)} (${m.arcsec.toFixed(2)}″)`} />
      <KV k="in pixels" v={`${m.pixels.toFixed(3)} px`} />
      <KV k="position angle" v={`${m.pa_deg.toFixed(2)}° east of north`} />
      <KV k="from" v={fmtCoord(A.ra_deg, A.dec_deg, ws.prefs.coordFormat)} />
      <KV k="to" v={fmtCoord(B.ra_deg, B.dec_deg, ws.prefs.coordFormat)} />
      <p className="pt-1 text-[10.5px] leading-snug text-ws-dim">On the bundle&apos;s tangent plane; PSF FWHM ≈ {b.frames.epochs[0]?.psf_fwhm_arcsec ?? "?"}″, so sub-pixel precision needs a centroid, not a click.</p>
    </Section>
  );
}
