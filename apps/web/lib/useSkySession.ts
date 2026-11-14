"use client";
// Everything /sky loads for a position, in one hook: resolve the target, fetch the bundle
// (or ask what NASA has and offer to build it), poll a live build, poll freshness, and fetch
// the overlay and caption that attach to a loaded bundle.
//
// Moved verbatim out of app/sky/page.tsx so the Simple view and the workstation load data
// through the same code. The URL stays the source of truth for what is shown.
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DEMO } from "@/lib/api";
import {
  DEFAULT_FOV, FOV_MAX, FOV_MIN, type Epochs, type Explanation, type Freshness, type Job, type Overlay,
  type SkyBundle, type SkyIndexEntry, type SkyTarget,
  getEpochs, getExplanation, getFreshness, getOverlay, getSkyBundle, getSkyIndex, getSkyJob,
  resolveTarget, skySlug, startSkyJob,
} from "@/lib/sky";
import type { FrameMode } from "@/components/SkyPlayer";

/** Field-of-view choices in plain words. Degrees stay visible, but nobody has to think in them. */
export const ZOOMS: { fov: number; label: string; hint: string }[] = [
  { fov: 0.05, label: "Close in", hint: "3 arcmin" },
  { fov: 0.1, label: "Normal", hint: "6 arcmin" },
  { fov: 0.2, label: "Wide", hint: "12 arcmin" },
  { fov: 0.35, label: "Wider", hint: "21 arcmin" },
  { fov: 0.5, label: "Widest", hint: "30 arcmin" },
];

export function useSkySession() {
  const router = useRouter();
  const params = useSearchParams();

  const qParam = params.get("q") || params.get("target") || "";
  const raParam = params.get("ra");
  const decParam = params.get("dec");
  const fovParam = Number(params.get("fov") || DEFAULT_FOV);
  const modeParam = (params.get("mode") || "visits") as FrameMode;
  const uiParam = params.get("ui");
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
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [explain, setExplain] = useState<Explanation | null>(null);

  useEffect(() => { getSkyIndex().then((j) => setIndex(j.targets)); }, []);

  const setUrl = useCallback((next: Record<string, string | number | undefined>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined || v === "") sp.delete(k); else sp.set(k, String(v));
    }
    router.replace(`/sky?${sp.toString()}`, { scroll: false });
  }, [params, router]);

  const show = useCallback((q: string) => { setQuery(q); setUrl({ q, ra: undefined, dec: undefined }); }, [setUrl]);
  // Keeps the chosen interface (?ui=) so "all targets" does not switch views under the user.
  const clear = useCallback(() => {
    setQuery("");
    router.replace(uiParam ? `/sky?ui=${encodeURIComponent(uiParam)}` : "/sky", { scroll: false });
  }, [router, uiParam]);

  // ---- load whatever the URL asks for ------------------------------------
  useEffect(() => {
    let cancelled = false;
    const q = qParam || (raParam && decParam ? `${raParam} ${decParam}` : "");
    if (!q) { setBundle(null); setTarget(null); setStatus(null); setBusy(false); return; }

    (async () => {
      setError(null); setBusy(true); setStatus("Finding that position…");
      setFresh(null); setEpochs(null); setJob(null);
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

  // ---- extras that attach to a loaded bundle -----------------------------
  useEffect(() => {
    if (!bundle) { setOverlay(null); setExplain(null); return; }
    let cancelled = false;
    setOverlay(null); setExplain(null);
    getOverlay(bundle).then((o) => { if (!cancelled) setOverlay(o); }).catch(() => {});
    getExplanation(bundle).then((e) => { if (!cancelled) setExplain(e); }).catch(() => {});
    return () => { cancelled = true; };
  }, [bundle]);

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

  const build = useCallback(async (force = false) => {
    if (!target) return;
    setError(null);
    try {
      const j = await startSkyJob(target.ra_deg, target.dec_deg, fov, { label: target.name });
      setJob(j);
      if (j.state === "done" && !force) { setBundle(await getSkyBundle(j.slug)); setStatus(null); }
    } catch (e) { setError(String((e as Error).message || e)); }
  }, [target, fov]);

  const entry = index.find((t) => t.name === target?.name);

  return {
    // what the URL asks for
    qParam, raParam, decParam, fov, modeParam, uiParam, setUrl, show, clear,
    query, setQuery,
    // what was loaded
    index, entry, target, bundle, status, busy, error, setError, job, epochs, fresh, overlay, explain,
    build,
  };
}

export type SkySession = ReturnType<typeof useSkySession>;
