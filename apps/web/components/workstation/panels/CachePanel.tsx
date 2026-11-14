"use client";
// Cache and performance, read from where the state actually lives. Nothing here is a
// second cache: it inspects the cube cache in lib/sky.ts, the derived-result cache, the
// browser's own resource timing, and (with an API) the server's job and disk state.
import { useEffect, useState, useSyncExternalStore } from "react";
import { RefreshCw, Trash } from "lucide-react";
import { DEMO } from "@/lib/api";
import {
  type FreshnessAll, type ServerCache, type ServerJob,
  cubeCacheEntries, evictCube, getServerCache, getSkyFreshnessAll, getSkyJobs,
} from "@/lib/sky";
import { cn } from "@/lib/utils";
import { derivedCache } from "@/lib/workstation/derived";
import { formatBytes, readHeap, readResources, summarizeResources } from "@/lib/workstation/perf";
import { useWS } from "../context";
import { IconBtn, KV, Section, StateChip, TextBtn } from "../ui";

function useTick(ms: number) {
  const [t, setT] = useState(0);
  useEffect(() => { const id = setInterval(() => setT((x) => x + 1), ms); return () => clearInterval(id); }, [ms]);
  return t;
}

export function CachePanel() {
  const ws = useWS();
  const tick = useTick(1500);
  void tick;
  const b = ws.bundle;
  const cubes = cubeCacheEntries();
  const derivedVersion = useSyncExternalStore(
    (fn) => derivedCache.subscribe(fn), () => `${derivedCache.hits}/${derivedCache.misses}/${derivedCache.entries().length}/${derivedCache.evictions}`, () => "");
  void derivedVersion;
  const derived = derivedCache.entries();
  const heap = readHeap();
  const resources = b ? summarizeResources(readResources(), (u) => u.includes(`/${b.slug}/`)) : [];

  return (
    <div>
      <Section title="Pixel cube · memory">
        {cubes.length ? cubes.map((c) => (
          <div key={c.slug} className="flex items-center gap-1.5 py-0.5 text-[11px]">
            <StateChip state={c.state === "ready" ? "cached" : c.state === "loading" ? "loading" : "failed"} compact />
            <span className={cn("mono min-w-0 flex-1 truncate text-[10.5px]", c.slug === b?.slug ? "text-ws-fg" : "text-ws-muted")} title={c.url}>{c.slug}</span>
            <span className="mono text-[10.5px] text-ws-muted">{c.state === "ready" ? formatBytes(c.bytes) : c.state}</span>
            {c.load_ms !== null ? <span className="mono w-12 text-right text-[10px] text-ws-dim">{c.load_ms} ms</span> : null}
            <IconBtn icon={Trash} size={12} tone="danger" disabled={c.state === "loading"}
              label="Evict from memory. Safe: it is re-fetched (usually from the HTTP cache) the next time a spectrum needs it."
              onClick={() => evictCube(c.slug)} />
          </div>
        )) : <p className="text-[11px] text-ws-muted">Nothing loaded. The cube is fetched on the first spectrum, histogram or change scan.</p>}
        <p className="pt-1 text-[10.5px] leading-snug text-ws-dim">
          uint16 flux + variance per exposure, decoded in the browser{DEMO ? "" : " (the API reads its own float cube for spectra)"}. Kept per field until evicted or the page reloads.
        </p>
      </Section>

      <Section title={`Derived results · ${derived.length}`}
        right={derived.length ? <button type="button" onClick={() => derivedCache.clear()} className="text-[10px] text-ws-muted hover:text-ws-err">clear all</button> : null}>
        <div className="flex gap-3 pb-1 text-[10.5px] text-ws-muted">
          <span>hits <span className="mono text-ws-fg">{derivedCache.hits}</span></span>
          <span>misses <span className="mono text-ws-fg">{derivedCache.misses}</span></span>
          <span>evicted <span className="mono text-ws-fg">{derivedCache.evictions}</span></span>
          <span>limit <span className="mono text-ws-fg">{derivedCache.limit}</span></span>
        </div>
        {derived.length ? derived.map((e) => (
          <div key={e.id} className="flex items-start gap-1.5 border-t border-ws-line/50 py-1 text-[10.5px]">
            <div className="min-w-0 flex-1">
              <div className="text-ws-fg">{e.key.op} <span className="mono text-ws-dim">@{e.key.version}</span>
                {e.key.dataset.startsWith(`${b?.slug}@`) ? <span className="ml-1 text-ws-sel">this field</span> : null}</div>
              <div className="mono truncate text-[10px] text-ws-muted" title={e.id}>
                {Object.entries(e.key.params).map(([k, v]) => `${k}=${v}`).join(" ")}
              </div>
              <div className="mono text-[10px] text-ws-dim">{formatBytes(e.bytes)} · {e.computeMs} ms · {e.hits} hit{e.hits === 1 ? "" : "s"}</div>
            </div>
            <IconBtn icon={Trash} size={12} tone="danger" label="Discard this result (it is recomputed on demand)" onClick={() => derivedCache.delete(e.id)} />
          </div>
        )) : <p className="text-[11px] text-ws-muted">None yet. Change detection results land here, keyed by field, version and parameters.</p>}
      </Section>

      <Section title="This view · loading">
        {b ? (
          <>
            <KV k="frames decoded" v={`${ws.loaded.count} / ${ws.loaded.total} (${ws.mode})`} />
            {resources.length ? resources.map((g) => (
              <KV key={g.kind} k={g.kind}
                v={`${g.count} files · ${formatBytes(g.decodedBytes)} · ${g.fromCache} cached · ${g.network} network${g.unknown ? ` · ${g.unknown} unreported` : ""}`} />
            )) : <p className="text-[11px] text-ws-muted">No resource timing recorded yet.</p>}
            <p className="pt-1 text-[10.5px] leading-snug text-ws-dim">
              From the browser&apos;s resource timing: a file with no bytes on the wire came from the HTTP cache. Every frame of the
              current mode is requested up front so playback never waits on the network.
              {!DEMO ? " Cross-origin API files report sizes only if the server sends Timing-Allow-Origin." : ""}
            </p>
          </>
        ) : <p className="text-[11px] text-ws-muted">No field open.</p>}
      </Section>

      <Section title="Memory & GPU">
        {heap ? (
          <>
            <KV k="JS heap used" v={`${formatBytes(heap.used)} of ${formatBytes(heap.total)}`} />
            <KV k="heap limit" v={formatBytes(heap.limit)} />
            <div className="my-1 h-1.5 overflow-hidden rounded bg-ws-raised">
              <div className="h-full bg-ws-sel" style={{ width: `${Math.min(100, (100 * heap.used) / heap.limit)}%` }} />
            </div>
          </>
        ) : <KV k="JS heap" v="not exposed by this browser" mono={false} />}
        <KV k="GPU" v="not used by this view" mono={false}
          title="Frames are composited by the browser's image pipeline; there is no WebGL renderer here to report on." />
        <p className="pt-0.5 text-[10.5px] leading-snug text-ws-dim">
          Frames are drawn as images by the browser compositor, not a WebGL renderer, so there is no GPU cache to report.
          The Sky Context atlas (Aladin Lite) uses WebGL2 once opened.
        </p>
      </Section>

      {DEMO ? (
        <Section title="Server">
          <p className="text-[11px] text-ws-muted">No server: this deployment serves ready-made files only, so there are no jobs, queues or server caches.</p>
        </Section>
      ) : <ServerSection />}
    </div>
  );
}

function ServerSection() {
  const ws = useWS();
  const [cache, setCache] = useState<ServerCache | null>(null);
  const [jobs, setJobs] = useState<ServerJob[] | null>(null);
  const [fresh, setFresh] = useState<FreshnessAll | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [n, setN] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      Promise.allSettled([getServerCache(), getSkyJobs(), getSkyFreshnessAll()]).then(([c, j, f]) => {
        if (cancelled) return;
        if (c.status === "fulfilled") setCache(c.value);
        if (j.status === "fulfilled") setJobs(j.value.jobs);
        if (f.status === "fulfilled") setFresh(f.value);
        const bad = [c, j, f].filter((r) => r.status === "rejected") as PromiseRejectedResult[];
        setErr(bad.length ? String(bad[0].reason?.message ?? bad[0].reason) : null);
      });
    };
    load();
    const id = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [n]);

  const active = (jobs ?? []).filter((j) => j.state === "queued" || j.state === "running");
  return (
    <>
      <Section title={`Server jobs · ${active.length} active`} right={<IconBtn icon={RefreshCw} size={11} label="Refresh now" onClick={() => setN((x) => x + 1)} />}>
        {err ? <p className="pb-1 text-[10.5px] text-ws-err">Server: {err}</p> : null}
        {jobs?.length ? jobs.slice().reverse().slice(0, 12).map((j) => (
          <div key={j.job_id ?? j.slug} className="border-t border-ws-line/50 py-1 text-[10.5px]">
            <div className="flex items-center gap-1.5">
              <StateChip state={j.state === "queued" ? "queued" : j.state === "running" ? "processing" : j.state === "error" ? "failed" : "completed"} />
              <span className={cn("mono min-w-0 flex-1 truncate", j.slug === ws.bundle?.slug ? "text-ws-fg" : "text-ws-muted")}>{j.slug}</span>
              {j.n_total ? <span className="mono text-ws-muted">{j.n_done}/{j.n_total}</span> : null}
            </div>
            {j.state === "running" ? <div className="mt-0.5 h-1 overflow-hidden rounded bg-ws-raised"><div className="h-full bg-ws-warn" style={{ width: `${Math.round(100 * j.progress)}%` }} /></div> : null}
            {j.error ? <div className="text-ws-err">{j.error}</div> : null}
          </div>
        )) : <p className="text-[11px] text-ws-muted">{jobs ? "No builds since the server started." : "…"}</p>}
        <p className="pt-1 text-[10.5px] text-ws-dim">
          {cache ? `Up to ${cache.memory.max_active_jobs} builds run at once. ` : ""}Cancelling a build is not supported by the API.
        </p>
      </Section>

      <Section title={`Server disk cache${cache ? ` · ${formatBytes(cache.total_bytes)}` : ""}`}>
        {cache ? (
          <>
            {cache.sections.map((s) => (
              <KV key={s.name} k={s.name} v={`${s.files} files · ${formatBytes(s.bytes)}`} title={s.newest ? `newest ${s.newest}` : undefined} />
            ))}
            <div className="mt-1 border-t border-ws-line/50 pt-1 text-[10.5px] text-ws-muted">{cache.bundles.length} built views</div>
            {cache.bundles.slice(0, 20).map((v) => (
              <KV key={v.slug} k={<span className={v.slug === ws.bundle?.slug ? "text-ws-fg" : ""}>{v.slug}</span>}
                v={`${v.location} · ${formatBytes(v.bytes)}${v.has_cube ? " · cube" : ""}`} />
            ))}
            <p className="pt-1 text-[10.5px] leading-snug text-ws-dim">{cache.controls.note}</p>
            <div className="pt-1"><TextBtn disabled title={cache.controls.note}>Clear server cache</TextBtn></div>
          </>
        ) : <p className="text-[11px] text-ws-muted">{err ? "Not available from this server." : "…"}</p>}
      </Section>

      <Section title="Release refresher">
        {fresh ? (
          <>
            <KV k="interval" v={`${fresh.refresher.interval_minutes} min`} />
            <KV k="last sweep" v={fresh.refresher.last_sweep ?? "not yet"} />
            <KV k="auto rebuild" v={fresh.refresher.auto_rebuild ? "on" : "off"} />
            {fresh.refresher.last_error ? <KV k="last error" v={fresh.refresher.last_error} /> : null}
            <KV k="stale views" v={Object.values(fresh.bundles).filter((x) => x?.stale).length} />
          </>
        ) : <p className="text-[11px] text-ws-muted">…</p>}
      </Section>
    </>
  );
}
