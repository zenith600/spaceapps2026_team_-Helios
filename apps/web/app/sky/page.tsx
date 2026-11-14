"use client";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SourceTag } from "@/components/Tags";
import { FrameMode, SkyPlayer } from "@/components/SkyPlayer";
import { SkySpectrum } from "@/components/SkySpectrum";
import { DEMO } from "@/lib/api";
import {
  DEFAULT_FOV, FOV_MAX, FOV_MIN, type Freshness, type Job, type SkyBundle, type SkyIndexEntry, type SkyTarget,
  formatDec, formatRa, getFreshness, getSkyBundle, getSkyIndex, getSkyJob, mjdLabel, resolveTarget,
  skySlug, startSkyJob,
} from "@/lib/sky";
import { cn } from "@/lib/utils";

const FOV_CHOICES = [0.05, 0.1, 0.2, 0.3, 0.5];
const MODES: { id: FrameMode; label: string; hint: string }[] = [
  { id: "visits", label: "visits", hint: "One coadded frame per visit. Visits are months apart — this is where motion shows." },
  { id: "detectors", label: "detectors", hint: "Each detector coadded separately: deeper images at a near-constant wavelength." },
  { id: "epochs", label: "exposures", hint: "Every exposure as it came down, with its own wavelength and contamination flags." },
  { id: "difference", label: "difference", hint: "Each visit minus the first. What did not change cancels out." },
];

export default function SkyPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
      <SkyViewer />
    </Suspense>
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
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [fresh, setFresh] = useState<Freshness | null>(null);
  const [pixel, setPixel] = useState<{ x: number; y: number } | null>(null);
  const [radius, setRadius] = useState(1);
  const [showFlags, setShowFlags] = useState(false);

  useEffect(() => { getSkyIndex().then((j) => setIndex(j.targets)); }, []);

  const setUrl = useCallback((next: Record<string, string | number | undefined>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined || v === "") sp.delete(k); else sp.set(k, String(v));
    }
    router.replace(`/sky?${sp.toString()}`, { scroll: false });
  }, [params, router]);

  // ---- load whatever the URL asks for ------------------------------------
  useEffect(() => {
    let cancelled = false;
    const q = qParam || (raParam && decParam ? `${raParam} ${decParam}` : "");
    if (!q) { setBundle(null); setTarget(null); setStatus(null); return; }

    (async () => {
      setError(null); setStatus("resolving…"); setPixel(null); setFresh(null);
      try {
        const t = await resolveTarget(q);
        if (cancelled) return;
        setTarget(t);
        const slug = skySlug(t.ra_deg, t.dec_deg, fov);
        setStatus("loading view…");
        try {
          const b = await getSkyBundle(slug);
          if (cancelled) return;
          setBundle(b); setStatus(null);
        } catch {
          if (cancelled) return;
          setBundle(null);
          setStatus(DEMO
            ? "not pre-built"
            : "no view built for this position and field of view yet");
        }
      } catch (e) {
        if (!cancelled) { setError(String((e as Error).message || e)); setBundle(null); setTarget(null); setStatus(null); }
      }
    })();
    return () => { cancelled = true; };
  }, [qParam, raParam, decParam, fov]);

  // ---- live refresh: has new SPHEREx data landed since this was built? ----
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
        if (j.state === "done") {
          const b = await getSkyBundle(j.slug);
          setBundle(b); setStatus(null);
        } else if (j.state === "error") {
          setError(j.error || "build failed");
        }
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
      if (j.state === "done" && !force) {
        setBundle(await getSkyBundle(j.slug));
        setStatus(null);
      }
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setUrl({ q: query.trim(), ra: undefined, dec: undefined });
  };

  const cov = bundle?.coverage;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-bold">Sky Viewer</h1>
        <p className="max-w-3xl text-xs text-muted">
          Type a position or an object name and watch that patch of sky across every SPHEREx visit.
          Things that move, or vary, stand out against everything that does not.
        </p>
      </header>

      {/* ---- search ---- */}
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[260px] flex-1 flex-col gap-1">
          <span className="text-[11px] text-muted">Right Ascension and declination, or a name</span>
          <input
            value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="08 55 10.831 -07 14 42.53   ·   133.795 -7.245   ·   Barnard's Star"
            className="w-full rounded border border-line bg-panel px-3 py-2 text-sm mono outline-none focus:border-accent/60"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">field of view</span>
          <select value={fov} onChange={(e) => setUrl({ fov: e.target.value })}
            className="rounded border border-line bg-panel px-2 py-2 text-sm mono">
            {FOV_CHOICES.map((f) => <option key={f} value={f}>{f}° ({Math.round((f * 3600) / 6.15)} px)</option>)}
          </select>
        </label>
        <Button type="submit">show me</Button>
      </form>

      {/* ---- quick picks ---- */}
      {index.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-muted">ready to view:</span>
          {index.map((t) => (
            <button key={t.slug} onClick={() => { setQuery(t.name); setUrl({ q: t.name, ra: undefined, dec: undefined }); }}
              className={cn("rounded border border-line px-2 py-1 hover:text-fg",
                target?.name === t.name ? "bg-panel text-accent" : "text-muted")}
              title={`${t.n_frames} frames · ${t.n_visits} visits · ${Math.round(t.baseline_days)} day baseline`}>
              {t.name}
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <p className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>
      ) : null}

      {/* ---- target header ---- */}
      {target ? (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line pb-2">
          <h2 className="text-lg font-semibold">{target.name}</h2>
          <span className="mono text-xs text-muted">
            RA {formatRa(target.ra_deg)} · Dec {formatDec(target.dec_deg)}
            <span className="ml-2 opacity-70">({target.ra_deg.toFixed(5)}, {target.dec_deg.toFixed(5)})</span>
          </span>
          <Badge>{target.resolver === "builtin" ? "built-in catalogue" : target.resolver === "coords" ? "typed coordinates" : "CDS Sesame"}</Badge>
          {target.note ? <p className="w-full text-xs text-muted">{target.note}</p> : null}
        </div>
      ) : null}

      {/* ---- not built yet ---- */}
      {!bundle && status ? (
        <Card>
          <CardContent className="flex flex-col gap-3 py-4 text-xs">
            <p className="text-muted">{status}</p>
            {job && job.state !== "done" ? (
              <div className="flex flex-col gap-1">
                <div className="h-1.5 w-full overflow-hidden rounded bg-panel">
                  <div className="h-full bg-accent transition-all" style={{ width: `${Math.round(100 * job.progress)}%` }} />
                </div>
                <span className="mono text-[11px] text-muted">
                  {job.state} · {job.n_done}/{job.n_total || "?"} · {job.message}
                </span>
                <p className="text-[11px] text-muted">
                  Each SPHEREx cutout is about 4 MB and takes roughly 12 seconds from IRSA, six at a time.
                </p>
              </div>
            ) : DEMO ? (
              <p>
                This deployment serves pre-built views only. The five challenge test targets above are ready;
                any other coordinate needs the API running (<span className="mono">NEXT_PUBLIC_DEMO_MODE=0</span>),
                which fetches it live from IRSA.
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => build()}>build it from IRSA</Button>
                <span className="text-muted">downloads the exposures covering this position — a minute or two</span>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* ---- the viewer ---- */}
      {bundle && cov ? (
        <>
          {fresh?.stale ? (
            <div className="flex flex-wrap items-center gap-3 rounded border border-accent/40 bg-accent/10 px-3 py-2 text-xs">
              <span className="text-accent">
                {fresh.new_exposures > 0 ? `${fresh.new_exposures} new exposures` : "new data"}
                {fresh.new_collections.length ? ` and a new release (${fresh.new_collections.join(", ")})` : ""}
                {" "}since this view was built.
              </span>
              <Button size="sm" onClick={() => build(true)}>rebuild</Button>
              <span className="text-muted mono">built {bundle.generated_at.slice(0, 10)}</span>
            </div>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-1">
                {MODES.map((m) => {
                  const n = m.id === "difference" ? bundle.difference.length
                    : m.id === "visits" ? bundle.frames.visits.length
                    : m.id === "detectors" ? bundle.frames.detectors.length
                    : bundle.frames.epochs.length;
                  return (
                    <button key={m.id} disabled={n === 0} onClick={() => setUrl({ mode: m.id })}
                      title={m.hint}
                      className={cn("rounded border border-line px-2.5 py-1 text-[11px] mono disabled:opacity-30",
                        modeParam === m.id ? "bg-panel text-accent" : "text-muted hover:text-fg")}>
                      {m.label} <span className="opacity-60">{n}</span>
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted">{MODES.find((m) => m.id === modeParam)?.hint}</p>

              <SkyPlayer bundle={bundle} mode={modeParam} marker={pixel} onPickPixel={setPixel}
                showFlags={showFlags} onToggleFlags={setShowFlags} />

              {showFlags && modeParam === "epochs" ? (
                <div className="flex flex-wrap items-center gap-3 text-[10px]">
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
                <CardHeader><CardTitle>Spectrum on the fly</CardTitle></CardHeader>
                <CardContent>
                  <SkySpectrum bundle={bundle} pixel={pixel} radius={radius} onRadius={setRadius} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle>What you are looking at</CardTitle></CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
                    <Stat k="exposures used" v={`${cov.n_used} of ${cov.n_exposures_available}`} />
                    <Stat k="visits" v={String(cov.n_visits)} />
                    <Stat k="time baseline" v={`${Math.round(cov.baseline_days)} days`} accent />
                    <Stat k="first" v={mjdLabel(cov.mjd_min)} />
                    <Stat k="last" v={mjdLabel(cov.mjd_max)} />
                    <Stat k="bands measured" v={`${cov.n_bands} of ${cov.bands_total}`} accent />
                    <Stat k="wavelengths" v={`${cov.wave_min_um.toFixed(2)}–${cov.wave_max_um.toFixed(2)} µm`} />
                    <Stat k="detectors" v={cov.detectors.join(", ")} />
                    <Stat k="pixel scale" v={`${bundle.pixel_arcsec}″`} />
                  </dl>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px]">
                    <SourceTag source={bundle.source} />
                    <span className="text-muted mono">
                      {bundle.search.collections_searched.join(", ")} · built {bundle.generated_at.slice(0, 10)}
                    </span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle>Honest limits</CardTitle></CardHeader>
                <CardContent>
                  <ul className="list-disc space-y-1 pl-4 text-[11px] text-muted">
                    {bundle.limits.map((l, k) => <li key={k}>{l}</li>)}
                  </ul>
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle>Link to this view</CardTitle></CardHeader>
                <CardContent>
                  <code className="block overflow-x-auto rounded bg-panel px-2 py-1 text-[10px] mono text-muted">
                    /sky?ra={bundle.ra_deg.toFixed(5)}&amp;dec={bundle.dec_deg.toFixed(5)}&amp;fov={bundle.fov_deg}&amp;mode={modeParam}
                  </code>
                  <p className="mt-1 text-[10px] text-muted">
                    Every control is in the URL, so any view can be bookmarked, shared or embedded in another page.
                  </p>
                </CardContent>
              </Card>
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Stat({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (<><dt className="text-muted">{k}</dt><dd className={cn("mono", accent && "text-accent")}>{v}</dd></>);
}
