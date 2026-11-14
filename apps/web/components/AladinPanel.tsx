"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * "Where is this on the sky?" — CDS's Aladin Lite, which the brief recommends by name.
 *
 * The library is bundled from npm (aladin-lite, pinned like every other dependency), not
 * fetched from CDS at runtime. The first version loaded
 * https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.js, and CDS has since
 * retired that whole path (404) — so the panel failed while reporting "could not reach
 * CDS", although CDS itself was up. Bundling removes that dependency; only the sky
 * *imagery* still streams from CDS's HiPS servers.
 *
 * It is still loaded lazily, on click: it is ~2 MB including its WebAssembly core, and
 * nobody should pay for an atlas on a page they came to for the time-lapse.
 */
type AladinLib = { init: Promise<void>; aladin: (el: HTMLElement, opts: object) => unknown };

let loader: Promise<AladinLib> | null = null;

function loadAladin(): Promise<AladinLib> {
  if (!loader) {
    // Dynamic import: the module touches `document` at import time, so it must never be
    // evaluated during server rendering.
    loader = import("aladin-lite").then(async (m) => {
      const A = (m.default ?? m) as AladinLib;
      await A.init;
      return A;
    });
    loader.catch(() => { loader = null; });      // allow a retry after a failure
  }
  return loader;
}

/** Say what actually went wrong, instead of blaming the network for everything. */
function explain(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  if (/webgl2/i.test(msg)) return "your browser does not support WebGL2, which the atlas needs";
  if (/Loading chunk|Failed to fetch dynamically imported module|import/i.test(msg)) {
    return "the atlas code failed to load — try reloading the page";
  }
  return msg;
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
      .then((A) => {
        if (cancelled || !box.current) return;
        A.aladin(box.current, {
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
        setMessage(explain(e));
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
          Aladin Lite by CDS Strasbourg. Loads only when you ask; imagery streams from CDS.
        </p>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="rounded-lg border border-line bg-panel p-3 text-xs">
        <p className="text-muted">Sky atlas unavailable ({message}). Everything else still works.</p>
        <Button size="sm" variant="ghost" className="mt-2" onClick={() => setState("loading")}>
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
