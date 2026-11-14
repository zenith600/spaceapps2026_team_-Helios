"use client";
import { Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SourceTag } from "@/components/Tags";
import { AladinPanel } from "@/components/AladinPanel";
import { FrameMode, MODES, SkyPlayer } from "@/components/SkyPlayer";
import { SkySpectrum } from "@/components/SkySpectrum";
import { TargetGallery } from "@/components/TargetGallery";
import { VisitCompare } from "@/components/VisitCompare";
import { Workstation } from "@/components/workstation/Workstation";
import {
  type ChangeReport, type SkyBundle,
  formatDec, formatRa, getChangeMap, mjdLabel,
} from "@/lib/sky";
import { ZOOMS, useSkySession } from "@/lib/useSkySession";
import { cn } from "@/lib/utils";

/** The workstation needs a desktop-sized window; below this the Simple view is used. */
const WORKSTATION_MIN_WIDTH = 1024;
const WIDE_QUERY = `(min-width: ${WORKSTATION_MIN_WIDTH}px)`;

function subscribeWide(cb: () => void) {
  const mq = window.matchMedia(WIDE_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/**
 * Which interface to show. `?ui=simple` forces the original single-page viewer and
 * `?ui=pro` forces the workstation; otherwise the window width decides. Both read and
 * write the same URL parameters, so a link works in either.
 */
function SkyRoute() {
  const params = useSearchParams();
  const wide = useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE_QUERY).matches, () => null);
  const ui = params.get("ui");
  if (ui === "simple") return <SkyViewer />;
  if (ui === "pro") return <Workstation />;
  if (wide === null) return <LoadingBlock label="Loading the viewer…" />;
  return wide ? <Workstation /> : <SkyViewer />;
}

const EXAMPLES = [
  { label: "Barnard's Star", q: "Barnard's Star" },
  { label: "08 55 10.831 −07 14 42.53", q: "08 55 10.831 -07 14 42.53" },
  { label: "133.795 −7.245", q: "133.795 -7.245" },
];

export default function SkyPage() {
  return (
    <Suspense fallback={<LoadingBlock label="Loading the viewer…" />}>
      <SkyRoute />
    </Suspense>
  );
}

function LoadingBlock({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-accent" />
      <p className="text-sm text-muted">{label}</p>
    </div>
  );
}

function SkyViewer() {
  const {
    qParam, raParam, decParam, fov, modeParam, setUrl, show, clear, query, setQuery,
    index, target, bundle, status, busy, error, setError, job, epochs, fresh, overlay, explain, build,
  } = useSkySession();

  const [pixel, setPixel] = useState<{ x: number; y: number } | null>(null);
  const [radius, setRadius] = useState(1);
  const [showFlags, setShowFlags] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [activeLayers, setActiveLayers] = useState<string[]>([]);
  const [change, setChange] = useState<ChangeReport | null>(null);
  const [changeBusy, setChangeBusy] = useState(false);
  const [showChange, setShowChange] = useState(false);

  // A new position clears the picked pixel; a new bundle clears what was computed on the old one.
  useEffect(() => { setPixel(null); }, [qParam, raParam, decParam, fov]);
  useEffect(() => { setChange(null); setShowChange(false); if (bundle) setActiveLayers([]); }, [bundle]);

  const findChanges = async () => {
    if (!bundle || changeBusy) return;
    if (change) { setShowChange((v) => !v); return; }
    setChangeBusy(true);
    try {
      const c = await getChangeMap(bundle);
      setChange(c); setShowChange(true);
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally { setChangeBusy(false); }
  };

  const entry = index.find((t) => t.name === target?.name);
  const lookFor = target?.look_for || entry?.look_for || "";
  const cov = bundle?.coverage;
  const years = cov ? (cov.baseline_days / 365.25).toFixed(1) : null;

  // =======================================================================
  // Landing: no target chosen
  // =======================================================================
  if (!qParam && !raParam) {
    return (
      <div className="flex flex-col gap-8">
        <section className="flex flex-col items-center gap-3 pt-4 text-center">
          <h1 className="max-w-2xl text-2xl font-bold tracking-tight sm:text-3xl">
            Watch any patch of sky <span className="text-accent">change over time</span>
          </h1>
          <p className="max-w-xl text-sm text-muted">
            NASA&apos;s SPHEREx telescope photographs the whole sky every six months. Pick a target below,
            or type any position, and we&apos;ll play back every visit as a short film — so anything that
            moves or flickers stands out.
          </p>
        </section>

        <SearchBar query={query} setQuery={setQuery} onSubmit={show} error={error} />
        <div className="-mt-4 flex justify-center"><WorkstationLink onOpen={() => setUrl({ ui: undefined })} /></div>

        <section>
          <h2 className="mb-1 text-sm font-semibold">Start with one of these</h2>
          <p className="mb-3 text-xs text-muted">
            Already built from real NASA images — they open instantly.
          </p>
          <TargetGallery targets={index} onPick={(t) => show(t.name)} />
        </section>
      </div>
    );
  }

  // =======================================================================
  // A target is selected
  // =======================================================================
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <button onClick={clear} className="text-xs text-muted hover:text-fg">
          ← all targets
        </button>
        <WorkstationLink onOpen={() => setUrl({ ui: undefined })} />
      </div>

      <SearchBar query={query} setQuery={setQuery} onSubmit={show} error={error} compact />

      {target ? (
        <header className="flex flex-col gap-2 border-b border-line pb-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-xl font-bold">{target.name}</h1>
            {(target.kind || entry?.kind) ? (
              <Badge>{target.kind || entry?.kind}</Badge>
            ) : null}
            {bundle ? (
              <span className="text-xs text-muted">
                {cov!.n_visits} visits over {years} years
              </span>
            ) : null}
          </div>
          {lookFor ? (
            <p className="max-w-3xl text-sm">
              <span className="font-semibold text-accent">What to look for: </span>
              <span className="text-fg">{lookFor}</span>
            </p>
          ) : explain ? (
            // No hand-written guidance for this position, so describe it from its own
            // measurements. Always labelled, because it is written by a machine.
            <div className="max-w-3xl">
              <p className="text-sm">
                <span className="font-semibold text-accent">About this field: </span>
                <span className="text-fg">{explain.text}</span>
              </p>
              <p className="mt-0.5 text-[10px] text-muted">
                {explain.generator.startsWith("llm:")
                  ? `Written automatically by ${explain.generator.slice(4)} from measured survey statistics.`
                  : "Generated from measured survey statistics."}{" "}
                {explain.disclaimer}
              </p>
            </div>
          ) : null}
          <details className="text-xs text-muted">
            <summary className="cursor-pointer select-none hover:text-fg">Exact position</summary>
            <p className="mono mt-1">
              RA {formatRa(target.ra_deg)} · Dec {formatDec(target.dec_deg)}
              <span className="ml-2 opacity-70">({target.ra_deg.toFixed(5)}, {target.dec_deg.toFixed(5)})</span>
              <span className="ml-2 opacity-70">
                · {target.resolver === "builtin" ? "from our catalogue"
                  : target.resolver === "coords" ? "the coordinates you typed" : "resolved by CDS"}
              </span>
            </p>
          </details>
        </header>
      ) : null}

      {busy ? <LoadingBlock label={status ?? "Loading…"} /> : null}

      {!busy && !bundle && status === "not-prebuilt" ? (
        <Card><CardContent className="py-5 text-sm">
          <p className="mb-2">This view hasn&apos;t been prepared yet.</p>
          <p className="text-xs text-muted">
            This copy of the app serves ready-made views only. The targets on the front page work right
            away; fetching a brand-new position from NASA needs the live service running.
          </p>
          <Button size="sm" className="mt-3" onClick={clear}>Back to the targets</Button>
        </CardContent></Card>
      ) : null}

      {!busy && !bundle && status === "no-coverage" ? (
        <Card><CardContent className="py-5 text-sm">
          <p className="mb-1">SPHEREx hasn&apos;t photographed this spot yet.</p>
          <p className="text-xs text-muted">
            It maps the whole sky every six months, so this position should appear in a future release.
            Try a wider view, or pick a different target.
          </p>
          <Button size="sm" className="mt-3" onClick={clear}>Back to the targets</Button>
        </CardContent></Card>
      ) : null}

      {!busy && !bundle && (status === "not-built" || job) ? (
        <Card><CardContent className="flex flex-col gap-3 py-5 text-sm">
          {job && job.state !== "done" ? (
            <>
              <p>Fetching images from NASA…</p>
              <div className="h-2 w-full overflow-hidden rounded-full bg-panel">
                <div className="h-full bg-accent transition-all"
                  style={{ width: `${Math.max(4, Math.round(100 * job.progress))}%` }} />
              </div>
              <p className="text-xs text-muted">
                {job.n_total ? `${job.n_done} of ${job.n_total} images` : "starting up"} · this usually
                takes a minute or two, and is instant next time.
              </p>
            </>
          ) : (
            <>
              <p className="font-semibold">Ready to build this view</p>
              {epochs && epochs.n_exposures > 0 ? (
                <>
                  <p className="text-xs text-muted">
                    NASA has <span className="mono text-fg">{epochs.n_exposures}</span> images of this
                    spot, taken on <span className="mono text-fg">{epochs.n_visits}</span> separate
                    visits spanning{" "}
                    <span className="mono text-fg">{((epochs.baseline_days ?? 0) / 365.25).toFixed(1)}</span> years.
                  </p>
                  {epochs.estimate ? (
                    <p className="text-xs text-muted">
                      We&apos;ll download {epochs.estimate.n_frames} of them
                      (~{epochs.estimate.download_mb} MB, about {epochs.estimate.seconds} seconds).
                    </p>
                  ) : null}
                </>
              ) : null}
              <div><Button size="sm" onClick={() => build()}>Build it</Button></div>
            </>
          )}
        </CardContent></Card>
      ) : null}

      {/* =================== the viewer =================== */}
      {bundle && cov ? (
        <>
          {fresh?.stale ? (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-xs">
              <span className="text-accent">
                NASA has released {fresh.new_exposures > 0 ? `${fresh.new_exposures} new images` : "new data"}
                {fresh.new_collections.length ? ` (${fresh.new_collections.join(", ")})` : ""} of this spot
                since this view was made.
              </span>
              <Button size="sm" onClick={() => build(true)}>Update it</Button>
            </div>
          ) : null}

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
            <section className="flex flex-col gap-3">
              <ModeTabs bundle={bundle} mode={modeParam} onPick={(m) => setUrl({ mode: m })} />

              <SkyPlayer bundle={bundle} mode={modeParam} marker={pixel} onPickPixel={setPixel}
                showFlags={showFlags} onToggleFlags={setShowFlags} hasPicked={pixel !== null}
                catalogOverlay={overlay} activeLayers={activeLayers}
                changePeaks={showChange ? change?.peaks ?? null : null} />

              <ZoomRow fov={fov} onPick={(f) => setUrl({ fov: f })} />

              {/* Catalogue overlays: which dots are already known? */}
              {overlay?.layers.length ? (
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="text-muted">Mark known sources:</span>
                  {overlay.layers.map((l) => (
                    <button key={l.id} disabled={l.n === 0} title={`${l.note} (${l.n} in this field)`}
                      onClick={() => setActiveLayers((a) =>
                        a.includes(l.id) ? a.filter((x) => x !== l.id) : [...a, l.id])}
                      className={cn("flex items-center gap-1 rounded-full border px-2.5 py-0.5 disabled:opacity-30",
                        activeLayers.includes(l.id) ? "border-accent/60 bg-accent/10 text-fg" : "border-line text-muted hover:text-fg")}>
                      <span className="inline-block h-2 w-2 rounded-full border"
                        style={{ borderColor: l.colour, background: activeLayers.includes(l.id) ? l.colour : "transparent" }} />
                      {l.name} <span className="mono opacity-60">{l.n}</span>
                    </button>
                  ))}
                  {activeLayers.length ? (
                    <span className="text-muted/80">· a dot with no ring is not in these catalogues</span>
                  ) : null}
                </div>
              ) : null}

              {/* Find what changed */}
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <Button size="sm" variant={showChange ? "default" : "outline"} onClick={findChanges}
                  disabled={changeBusy}>
                  {changeBusy ? "Scanning…" : showChange ? "Hide what changed" : "Find what changed"}
                </Button>
                {change && showChange ? (
                  <span className="text-muted">
                    <span className="mono text-sim">{change.peaks.length}</span> spots that vary far more
                    than a typical pixel in this field{change.peaks[0] ? ` (strongest ${change.peaks[0].z}× the usual spread)` : ""}.
                    Click one below.
                  </span>
                ) : (
                  <span className="text-muted">Scores every pixel against “nothing happened here”.</span>
                )}
              </div>
              {change && showChange && change.peaks.length ? (
                <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-panel p-2">
                  <div className="flex flex-wrap gap-1.5">
                    {change.peaks.map((p, k) => (
                      <button key={k} onClick={() => setPixel({ x: p.x, y: p.y })}
                        className={cn("rounded border px-2 py-0.5 text-[10px] mono",
                          pixel?.x === p.x && pixel?.y === p.y
                            ? "border-accent/60 bg-accent/10 text-accent" : "border-line text-muted hover:text-fg")}>
                        ({p.x},{p.y}) z {p.z}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-muted">{change.caveat}</p>
                </div>
              ) : null}

              {showFlags && modeParam === "epochs" ? (
                <div className="flex flex-wrap items-center gap-3 rounded border border-line bg-panel px-2 py-1.5 text-[10px]">
                  <span className="text-muted">Coloured pixels are flagged by NASA:</span>
                  {bundle.flag_legend.map((l) => (
                    <span key={l.id} className="flex items-center gap-1 text-muted">
                      <span className="inline-block h-2 w-2 rounded-sm" style={{ background: l.colour }} />
                      {l.id.replace("_", " ")}
                    </span>
                  ))}
                </div>
              ) : null}
            </section>

            <section className="flex flex-col gap-4">
              <Card>
                <CardHeader><CardTitle>Colours of a single point</CardTitle></CardHeader>
                <CardContent>
                  <SkySpectrum bundle={bundle} pixel={pixel} radius={radius} onRadius={setRadius}
                    onJump={setPixel} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle>This view at a glance</CardTitle></CardHeader>
                <CardContent>
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <Figure value={String(cov.n_visits)} label="visits" />
                    <Figure value={`${years}`} label="years covered" accent />
                    <Figure value={`${cov.n_bands}`} label={`of ${cov.bands_total} colours`} />
                  </div>
                  <p className="mt-3 text-xs text-muted">
                    {cov.n_used} images taken between {mjdLabel(cov.mjd_min)} and {mjdLabel(cov.mjd_max)},
                    in infrared light from {cov.wave_min_um.toFixed(2)} to {cov.wave_max_um.toFixed(2)} µm —
                    wavelengths your eye cannot see.
                  </p>
                  <button onClick={() => setShowDetails((v) => !v)}
                    className="mt-3 text-xs text-muted underline-offset-2 hover:text-fg hover:underline">
                    {showDetails ? "Hide technical details" : "Technical details"}
                  </button>
                  {showDetails ? (
                    <div className="mt-2 flex flex-col gap-2">
                      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
                        <Stat k="images used" v={`${cov.n_used} of ${cov.n_exposures_available}`} />
                        <Stat k="time baseline" v={`${Math.round(cov.baseline_days)} days`} />
                        <Stat k="detectors" v={cov.detectors.join(", ")} />
                        <Stat k="pixel scale" v={`${bundle.pixel_arcsec}″`} />
                        <Stat k="field of view" v={`${bundle.fov_deg}°`} />
                        <Stat k="image size" v={`${bundle.npix}×${bundle.npix}`} />
                      </dl>
                      <ul className="list-disc space-y-1 pl-4 text-[11px] text-muted">
                        {bundle.limits.map((l, k) => <li key={k}>{l}</li>)}
                      </ul>
                      <code className="block overflow-x-auto rounded bg-panel px-2 py-1 text-[10px] mono text-muted">
                        /sky?ra={bundle.ra_deg.toFixed(5)}&amp;dec={bundle.dec_deg.toFixed(5)}&amp;fov={bundle.fov_deg}&amp;mode={modeParam}
                      </code>
                      <p className="text-[10px] text-muted">
                        Every control is in the address bar, so you can bookmark or share exactly what you see.
                      </p>
                    </div>
                  ) : null}
                  <div className="mt-3"><SourceTag source={bundle.source} /></div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle>Compare any two dates</CardTitle></CardHeader>
                <CardContent><VisitCompare bundle={bundle} /></CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle>Where this is on the sky</CardTitle></CardHeader>
                <CardContent>
                  <AladinPanel ra={bundle.ra_deg} dec={bundle.dec_deg} fovDeg={bundle.fov_deg}
                    name={target?.name ?? "this field"} />
                </CardContent>
              </Card>
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Desktop only: the workstation needs the room. */
function WorkstationLink({ onOpen }: { onOpen: () => void }) {
  return (
    <button onClick={onOpen}
      className="hidden rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:border-accent/60 hover:text-fg lg:inline">
      Open in the analysis workstation →
    </button>
  );
}

function SearchBar({ query, setQuery, onSubmit, error, compact }: {
  query: string; setQuery: (v: string) => void; onSubmit: (q: string) => void;
  error: string | null; compact?: boolean;
}) {
  return (
    <div className={cn("flex flex-col gap-2", !compact && "mx-auto w-full max-w-2xl")}>
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(query.trim()); }}
        className="flex flex-col gap-2 sm:flex-row">
        <input
          value={query} onChange={(e) => setQuery(e.target.value)}
          aria-label="Object name or sky coordinates"
          // The long placeholder is truncated on a phone, so keep the essential half first.
          placeholder="A name like Barnard's Star, or coordinates"
          className={cn("w-full min-w-0 rounded-lg border border-line bg-panel px-4 outline-none placeholder:text-muted/70 focus:border-accent/60",
            compact ? "h-10 text-sm" : "h-12 text-base")}
        />
        <Button type="submit" size={compact ? "default" : "lg"} className="shrink-0">Show me</Button>
      </form>
      {!compact ? (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
          <span>Try:</span>
          {EXAMPLES.map((ex) => (
            <button key={ex.q} onClick={() => { setQuery(ex.q); onSubmit(ex.q); }}
              className="rounded-full border border-line px-2 py-0.5 mono hover:border-accent/60 hover:text-fg">
              {ex.label}
            </button>
          ))}
        </div>
      ) : null}
      {error ? (
        <p className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
      ) : null}
    </div>
  );
}

function ModeTabs({ bundle, mode, onPick }: { bundle: SkyBundle; mode: FrameMode; onPick: (m: FrameMode) => void }) {
  const count = (id: FrameMode) =>
    id === "difference" ? bundle.difference.length
      : id === "visits" ? bundle.frames.visits.length
      : id === "detectors" ? bundle.frames.detectors.length
      : bundle.frames.epochs.length;
  const active = MODES.find((m) => m.id === mode) ?? MODES[0];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5" role="tablist">
        {MODES.map((m) => {
          const n = count(m.id);
          return (
            <button key={m.id} role="tab" aria-selected={mode === m.id} disabled={n === 0}
              onClick={() => onPick(m.id)} title={m.hint}
              className={cn("rounded-lg border px-3 py-1.5 text-xs transition-colors disabled:opacity-30",
                mode === m.id ? "border-accent/60 bg-accent/10 text-accent" : "border-line text-muted hover:text-fg")}>
              {m.label}
              <span className="ml-1.5 opacity-60 mono">{n}</span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted">{active.hint}</p>
    </div>
  );
}

function ZoomRow({ fov, onPick }: { fov: number; onPick: (f: number) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="text-muted">Zoom:</span>
      {ZOOMS.map((z) => (
        <button key={z.fov} onClick={() => onPick(z.fov)} title={`${z.fov}° across`}
          className={cn("rounded-full border px-2.5 py-0.5",
            Math.abs(z.fov - fov) < 1e-6 ? "border-accent/60 bg-accent/10 text-accent" : "border-line text-muted hover:text-fg")}>
          {z.label}
        </button>
      ))}
      <span className="text-muted/70">· a wider view may need rebuilding</span>
    </div>
  );
}

function Figure({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-2 py-3">
      <div className={cn("mono text-2xl font-bold", accent ? "text-accent" : "text-fg")}>{value}</div>
      <div className="mt-0.5 text-[10px] leading-tight text-muted">{label}</div>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (<><dt className="text-muted">{k}</dt><dd className="mono">{v}</dd></>);
}
