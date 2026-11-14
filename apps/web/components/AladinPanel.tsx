"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * "Where is this on the sky?" — CDS's Aladin Lite, which the brief recommends by name.
 *
 * Four things broke this panel, and none was the code that draws it (the fourth, a
 * usage-logging ping on by default, is described where `log: false` is set below):
 *
 * 1. The library used to be fetched from
 *    https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.js, a path CDS has
 *    retired (404). It is now bundled from npm (aladin-lite, pinned) and loaded on click.
 *
 * 2. The imagery. Asking for a survey by ID ("P/DSS2/color") makes Aladin resolve it
 *    through CDS's MocServer to https://alasky.cds.unistra.fr/..., and on 2026-11-14 every
 *    CDS survey there returned 404 — DSS, 2MASS, AllWISE, Pan-STARRS alike — while the
 *    alaskybis mirror timed out. The survey records list official mirrors, and one is IRSA
 *    (irsa.ipac.caltech.edu): the same NASA archive every SPHEREx image here already comes
 *    from, already allowlisted, and serving tiles. So surveys are named by their IRSA URL,
 *    which also stops Aladin from consulting CDS at all to find them.
 *
 * 3. Startup. Aladin preloads a built-in list of default surveys by asking CDS's MocServer
 *    about each one, regardless of which survey was requested. Those servers were failing,
 *    so the panel died with "Failed to fetch" before showing anything. It is now handed
 *    its survey list explicitly (the three IRSA URLs), so it never contacts CDS to start.
 *
 * Aladin reports survey failures from inside its own promise chains, not through anything
 * this component can `catch`, so they surfaced as a page-wide runtime error. They are now
 * intercepted while the panel is mounted and shown in the panel instead.
 */
type AladinView = { setBaseImageLayer?: (url: string) => void; setImageSurvey?: (url: string) => void };
type AladinLib = { init: Promise<void>; aladin: (el: HTMLElement, opts: object) => AladinView };

const IRSA_HIPS = "https://irsa.ipac.caltech.edu/data/hips/CDS";

/** Verified serving tiles from IRSA on 2026-11-14. Near-infrared first: closest to SPHEREx. */
export const SURVEYS = [
  { id: "2mass", label: "Near-infrared", detail: "2MASS, 1.2–2.2 µm — the closest match to what SPHEREx sees",
    url: `${IRSA_HIPS}/2MASS/Color` },
  { id: "wise", label: "Mid-infrared", detail: "AllWISE, 3.4–22 µm — dust and cold objects glow here",
    url: `${IRSA_HIPS}/AllWISE/RGB-W4-W2-W1` },
  { id: "dss", label: "Visible", detail: "DSS2 — roughly what a telescope eyepiece would show",
    url: `${IRSA_HIPS}/DSS2/color` },
] as const;

let loader: Promise<AladinLib> | null = null;

function loadAladin(): Promise<AladinLib> {
  if (!loader) {
    // Dynamic import: the module touches `document` at import time, so it must never be
    // evaluated during server rendering.
    loader = import("aladin-lite").then(async (m) => {
      const A = (m.default ?? m) as unknown as AladinLib;
      await A.init;
      return A;
    });
    loader.catch(() => { loader = null; });      // allow a retry after a failure
  }
  return loader;
}

const isAladinError = (msg: string) => /HiPS|aladin|alasky|Failed to fetch|survey/i.test(msg);

/** Say what actually went wrong, instead of blaming the network for everything. */
function explain(e: unknown): string {
  const msg = String((e as Error)?.message ?? (e as { reason?: unknown })?.reason ?? e);
  if (/webgl2/i.test(msg)) return "your browser does not support WebGL2, which the atlas needs";
  if (/Loading chunk|dynamically imported module/i.test(msg)) {
    return "the atlas code failed to load — try reloading the page";
  }
  if (/HiPS|survey|Failed to fetch/i.test(msg)) return "the sky imagery server did not respond";
  return msg;
}

export function AladinPanel({ ra, dec, fovDeg, name }: {
  ra: number; dec: number; fovDeg: number; name: string;
}) {
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [message, setMessage] = useState("");
  const [survey, setSurvey] = useState<(typeof SURVEYS)[number]>(SURVEYS[0]);
  const box = useRef<HTMLDivElement>(null);
  const view = useRef<AladinView | null>(null);

  // Catch Aladin's own async failures while mounted, so they land here, not on the page.
  useEffect(() => {
    if (state === "idle") return;
    const onRejection = (ev: PromiseRejectionEvent) => {
      const msg = String(ev.reason?.message ?? ev.reason ?? "");
      if (!isAladinError(msg)) return;
      ev.preventDefault();
      setMessage(explain(ev.reason));
      setState("error");
    };
    const onError = (ev: ErrorEvent) => {
      if (!isAladinError(String(ev.message ?? ""))) return;
      ev.preventDefault();
      setMessage(explain(ev.error ?? ev.message));
      setState("error");
    };
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
    };
  }, [state]);

  useEffect(() => {
    if (state !== "loading" || !box.current) return;
    let cancelled = false;
    loadAladin()
      .then((A) => {
        if (cancelled || !box.current) return;
        box.current.innerHTML = "";
        try {
          view.current = A.aladin(box.current, {
            survey: survey.url,
            // Without this Aladin preloads its built-in default survey list at startup, and
            // resolves each entry through CDS's MocServer (alaskybis/alasky.unistra.fr) --
            // servers that were refusing or timing out, which surfaced as "Failed to fetch"
            // even though the survey we actually asked for, on IRSA, was fine. Plain URL
            // strings are used directly, so nothing here needs CDS to look anything up.
            hipsList: SURVEYS.map((s) => s.url),
            // On by default: a startup ping to alasky.unistra.fr/cgi/AladinLiteLogger/log.py
            // carrying window.location.href and document.referrer. That host was refusing
            // connections -- this was the "Failed to fetch" -- and the page URL contains the
            // coordinates or object the visitor searched for. A public tool should not send
            // its users' searches to a third party, so it is off.
            log: false,
            showSettingsControl: false,
            showSimbadPointerControl: false,
            fov: Math.max(fovDeg * 6, 0.3),
            // Fixed-point, never exponent form: Aladin sends any target containing a letter
            // to CDS's name resolver, and String(1e-7) is "1e-7".
            target: `${ra.toFixed(6)} ${dec.toFixed(6)}`,
            cooFrame: "ICRS",
            showReticle: true,
            showZoomControl: true,
            showFullscreenControl: false,
            showLayersControl: false,
            showGotoControl: false,
            showShareControl: false,
          });
          setState("ready");
        } catch (e) {
          setMessage(explain(e));
          setState("error");
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setMessage(explain(e));
        setState("error");
      });
    return () => { cancelled = true; };
    // The survey is switched in place below once the view exists; it is not a dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, ra, dec, fovDeg]);

  const pick = (s: (typeof SURVEYS)[number]) => {
    setSurvey(s);
    const v = view.current;
    if (state !== "ready" || !v) return;
    try {
      if (v.setBaseImageLayer) v.setBaseImageLayer(s.url);
      else v.setImageSurvey?.(s.url);
    } catch (e) {
      setMessage(explain(e));
      setState("error");
    }
  };

  if (state === "idle") {
    return (
      <div className="rounded-lg border border-dashed border-line bg-panel p-3 text-xs">
        <p className="mb-2 text-muted">
          See where {name} sits on the sky, with an atlas you can pan and zoom — in infrared, or
          in visible light for comparison.
        </p>
        <Button size="sm" variant="outline" onClick={() => setState("loading")}>
          Show sky context
        </Button>
        <p className="mt-1.5 text-[10px] text-muted/80">
          Aladin Lite by CDS Strasbourg, with sky imagery from NASA/IPAC IRSA. Loads only when you ask.
        </p>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="rounded-lg border border-line bg-panel p-3 text-xs">
        <p className="text-muted">Sky atlas unavailable: {message}. Everything else still works.</p>
        <Button size="sm" variant="ghost" className="mt-2" onClick={() => { view.current = null; setState("loading"); }}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5 text-[11px]">
        {SURVEYS.map((s) => (
          <button key={s.id} onClick={() => pick(s)} title={s.detail}
            className={cn("rounded-full border px-2.5 py-0.5",
              survey.id === s.id ? "border-accent/60 bg-accent/10 text-accent" : "border-line text-muted hover:text-fg")}>
            {s.label}
          </button>
        ))}
      </div>
      <div ref={box} className="h-[300px] w-full overflow-hidden rounded-lg border border-line bg-black" />
      {state === "loading" ? <p className="text-[11px] text-muted">Loading the sky atlas…</p> : null}
      <p className="text-[10px] text-muted">
        {survey.detail}. Aladin Lite · CDS; imagery via NASA/IPAC IRSA. The time-lapse above is SPHEREx.
      </p>
    </div>
  );
}
