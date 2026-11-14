"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * "Where is this on the sky?" — CDS's Aladin Lite, which the brief recommends by name.
 *
 * Loaded only when the user asks for it, for two reasons. It pulls a script and sky
 * imagery from CDS servers, which have been intermittently unreachable all week; and
 * nobody should pay for a third-party atlas on a page they came to for the time-lapse.
 * If CDS is down the panel says so and the rest of the viewer is untouched.
 */
const ALADIN_JS = "https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.js";

declare global {
  interface Window { A?: { init: Promise<void>; aladin: (el: HTMLElement, opts: object) => unknown } }
}

let loader: Promise<void> | null = null;

function loadAladin(timeoutMs = 15000): Promise<void> {
  if (window.A?.init) return window.A.init;
  if (loader) return loader;
  loader = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
    const s = document.createElement("script");
    s.src = ALADIN_JS;
    s.async = true;
    s.onload = () => {
      clearTimeout(timer);
      if (window.A?.init) window.A.init.then(() => resolve()).catch(reject);
      else reject(new Error("script loaded but Aladin did not initialise"));
    };
    s.onerror = () => { clearTimeout(timer); reject(new Error("could not reach CDS")); };
    document.head.appendChild(s);
  });
  return loader;
}

export function AladinPanel({ ra, dec, fovDeg, name }: {
  ra: number; dec: number; fovDeg: number; name: string;
}) {
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [message, setMessage] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state !== "loading" || !box.current) return;
    let cancelled = false;
    loadAladin()
      .then(() => {
        if (cancelled || !box.current) return;
        window.A!.aladin(box.current, {
          survey: "P/DSS2/color",
          fov: Math.max(fovDeg * 6, 0.3),
          target: `${ra} ${dec}`,
          cooFrame: "ICRS",
          showReticle: true,
          showZoomControl: true,
          showFullscreenControl: false,
          showLayersControl: true,
          showGotoControl: false,
          showShareControl: false,
        });
        setState("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        setMessage(String(e.message || e));
        setState("error");
      });
    return () => { cancelled = true; };
  }, [state, ra, dec, fovDeg]);

  if (state === "idle") {
    return (
      <div className="rounded-lg border border-dashed border-line bg-panel p-3 text-xs">
        <p className="mb-2 text-muted">
          See where {name} sits among the constellations, in visible light, with a sky atlas you
          can pan and zoom.
        </p>
        <Button size="sm" variant="outline" onClick={() => setState("loading")}>
          Show sky context
        </Button>
        <p className="mt-1.5 text-[10px] text-muted/80">
          Loads Aladin Lite from CDS Strasbourg — a few hundred KB, only when you ask.
        </p>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="rounded-lg border border-line bg-panel p-3 text-xs">
        <p className="text-muted">Sky atlas unavailable ({message}). Everything else still works.</p>
        <Button size="sm" variant="ghost" className="mt-2" onClick={() => { loader = null; setState("loading"); }}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div ref={box} className="h-[300px] w-full overflow-hidden rounded-lg border border-line bg-black" />
      {state === "loading" ? <p className="text-[11px] text-muted">Loading the sky atlas…</p> : null}
      <p className="text-[10px] text-muted">
        Aladin Lite · CDS, Strasbourg. Visible-light imagery for context; the time-lapse above is
        SPHEREx infrared.
      </p>
    </div>
  );
}
