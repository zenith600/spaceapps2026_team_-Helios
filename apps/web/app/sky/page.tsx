"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SourceTag } from "@/components/Tags";
import { FrameMode, MODES, SkyPlayer } from "@/components/SkyPlayer";
import { SkySpectrum } from "@/components/SkySpectrum";
import { TargetGallery } from "@/components/TargetGallery";
import { DEMO } from "@/lib/api";
import {
  DEFAULT_FOV, FOV_MAX, FOV_MIN, type Epochs, type Freshness, type Job, type SkyBundle,
  type SkyIndexEntry, type SkyTarget, formatDec, formatRa, getEpochs, getFreshness, getSkyBundle,
  getSkyIndex, getSkyJob, mjdLabel, resolveTarget, skySlug, startSkyJob,
} from "@/lib/sky";
import { cn } from "@/lib/utils";

/** Zoom levels in plain words. Degrees stay visible, but nobody has to think in them. */
const ZOOMS: { fov: number; label: string; hint: string }[] = [
  { fov: 0.05, label: "Close in", hint: "3 arcmin" },
  { fov: 0.1, label: "Normal", hint: "6 arcmin" },
  { fov: 0.2, label: "Wide", hint: "12 arcmin" },
  { fov: 0.35, label: "Wider", hint: "21 arcmin" },
  { fov: 0.5, label: "Widest", hint: "30 arcmin" },
];

const EXAMPLES = [
  { label: "Barnard's Star", q: "Barnard's Star" },
  { label: "08 55 10.831 −07 14 42.53", q: "08 55 10.831 -07 14 42.53" },
  { label: "133.795 −7.245", q: "133.795 -7.245" },
];

export default function SkyPage() {
  return (
    <Suspense fallback={<LoadingBlock label="Loading the viewer…" />}>
      <SkyViewer />
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
  const router = useRouter();
  const params = useSearchParams();

  const qParam = params.get("q") || params.get("target") || "";
  const raParam = params.get("ra");
  const decParam = params.get("dec");
  const fovParam = Number(params.get("fov") || DEFAULT_FOV);
  const modeParam = (params.get("mode") || "visits") as FrameMode;
  const fov = Number.isFinite(fovParam) ? Math.min(FOV_MAX, Math.max(FOV_MIN, fovParam)) : DEFAULT_FOV;

  const [query, setQuery] = useState(qParam || (raParam && decParam ? `${raParam} ${decParam}` : ""));
  const [index, setIndex] = useState<SkyIndexEntry[]>([]);
  const [target, setTarget] = useState<SkyTarget | null>(null);
  const [bundle, setBundle] = useState<SkyBundle | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [epochs, setEpochs] = useState<Epochs | null>(null);
  const [fresh, setFresh] = useState<Freshness | null>(null);
  const [pixel, setPixel] = useState<{ x: number; y: number } | null>(null);
  const [radius, setRadius] = useState(1);
  const [showFlags, setShowFlags] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => { getSkyIndex().then((j) => setIndex(j.targets)); }, []);

  const setUrl = useCallback((next: Record<string, string | number | undefined>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined || v === "") sp.delete(k); else sp.set(k, String(v));
    }
    router.replace(`/sky?${sp.toString()}`, { scroll: false });
  }, [params, router]);

  const show = (q: string) => { setQuery(q); setUrl({ q, ra: undefined, dec: undefined }); };
  const clear = () => { setQuery(""); router.replace("/sky", { scroll: false }); };

  // ---- load whatever the URL asks for ------------------------------------
  useEffect(() => {
    let cancelled = false;
    const q = qParam || (raParam && decParam ? `${raParam} ${decParam}` : "");
    if (!q) { setBundle(null); setTarget(null); setStatus(null); setBusy(false); return; }

    (async () => {
      setError(null); setBusy(true); setStatus("Finding that position…");
      setPixel(null); setFresh(null); setEpochs(null); setJob(null);
      try {
        const t = await resolveTarget(q);
        if (cancelled) return;
        setTarget(t);
        setStatus("Loading images…");
        try {
          const b = await getSkyBundle(skySlug(t.ra_deg, t.dec_deg, fov));
          if (cancelled) return;
          setBundle(b); setStatus(null); setBusy(false);
        } catch {
          if (cancelled) return;
          setBundle(null);
          if (DEMO) { setStatus("not-prebuilt"); setBusy(false); return; }
          setStatus("Asking NASA what it has here…");
          try {
            const e = await getEpochs(t.ra_deg, t.dec_deg, fov);
            if (!cancelled) { setEpochs(e); setStatus(e.n_exposures === 0 ? "no-coverage" : "not-built"); }
          } catch {
            if (!cancelled) setStatus("not-built");
          }
          if (!cancelled) setBusy(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(String((e as Error).message || e));
          setBundle(null); setTarget(null); setStatus(null); setBusy(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [qParam, raParam, decParam, fov]);

  // ---- live refresh ------------------------------------------------------
  useEffect(() => {
    if (!bundle || DEMO) return;
    let cancelled = false;
    const check = () => getFreshness(bundle.slug).then((f) => { if (!cancelled) setFresh(f); }).catch(() => {});
    check();
    const id = setInterval(check, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [bundle]);

  // ---- live build job ----------------------------------------------------
  useEffect(() => {
    if (!job?.job_id || job.state === "done" || job.state === "error") return;
    const id = setInterval(async () => {
      try {
        const j = await getSkyJob(job.job_id!);
        setJob(j);
        if (j.state === "done") { setBundle(await getSkyBundle(j.slug)); setStatus(null); }
        else if (j.state === "error") { setError(j.error || "build failed"); }
      } catch { /* keep polling */ }
    }, 1500);
    return () => clearInterval(id);
  }, [job]);

  const build = async (force = false) => {
    if (!target) return;
    setError(null);
    try {
      const j = await startSkyJob(target.ra_deg, target.dec_deg, fov, { label: target.name });
      setJob(j);
      if (j.state === "done" && !force) { setBundle(await getSkyBundle(j.slug)); setStatus(null); }
    } catch (e) { setError(String((e as Error).message || e)); }
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
      <button onClick={clear} className="self-start text-xs text-muted hover:text-fg">
        ← all targets
      </button>

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
                showFlags={showFlags} onToggleFlags={setShowFlags} hasPicked={pixel !== null} />

              <ZoomRow fov={fov} onPick={(f) => setUrl({ fov: f })} />

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
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function SearchBar({ query, setQuery, onSubmit, error, compact }: {
  query: string; setQuery: (v: string) => void; onSubmit: (q: string) => void;
  error: string | null; compact?: boolean;
}) {
  return (
    <div className={cn("flex flex-col gap-2", !compact && "mx-auto w-full max-w-2xl")}>
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(query.trim()); }} className="flex gap-2">
        <input
          value={query} onChange={(e) => setQuery(e.target.value)}
          aria-label="Object name or sky coordinates"
          placeholder="Type a name, like Barnard's Star — or coordinates"
          className={cn("w-full rounded-lg border border-line bg-panel px-4 outline-none placeholder:text-muted/70 focus:border-accent/60",
            compact ? "h-10 text-sm" : "h-12 text-base")}
        />
        <Button type="submit" size={compact ? "default" : "lg"}>Show me</Button>
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
