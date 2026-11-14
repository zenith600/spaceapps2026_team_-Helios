"use client";
/**
 * Is the live API actually there?
 *
 * The build flag (NEXT_PUBLIC_DEMO_MODE) only says what the site was built *for*. A build
 * configured for the API can still be cut off from it (server down, proxy broken), and then
 * claiming "live NASA access" would be false. So the claim is only made after GET /health
 * answers {ok: true}. One probe per page load, shared by every caller; a failed probe is
 * forgotten so the next mount tries again.
 *
 * Limit: /health proves the API is reachable, not that SKY_ALLOW_LIVE is on. Exposing that
 * would need an API change.
 */
import { useEffect, useState } from "react";
import { API_URL, DEMO } from "./api";

export type LiveApiState = "demo" | "checking" | "live" | "unreachable";

export const LIVE_API_LABEL: Record<LiveApiState, string> = {
  demo: "ready-made views",
  checking: "checking live service…",
  live: "live NASA access",
  unreachable: "live service unreachable",
};

const PROBE_TIMEOUT_MS = 6000;
let probe: Promise<boolean> | null = null;

export function probeLiveApi(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!probe) {
    probe = (async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
      try {
        const r = await fetchImpl(`${API_URL}/health`, { signal: ctl.signal, cache: "no-store" });
        if (!r.ok) return false;
        const body = (await r.json()) as { ok?: unknown };
        return body?.ok === true;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    })().then((ok) => {
      if (!ok) probe = null;   // let a later mount retry
      return ok;
    });
  }
  return probe;
}

/** For tests. */
export function resetLiveApiProbe(): void {
  probe = null;
}

export function useLiveApi(): LiveApiState {
  const [state, setState] = useState<LiveApiState>(DEMO ? "demo" : "checking");
  useEffect(() => {
    if (DEMO) return;
    let alive = true;
    probeLiveApi().then((ok) => { if (alive) setState(ok ? "live" : "unreachable"); });
    return () => { alive = false; };
  }, []);
  return state;
}
