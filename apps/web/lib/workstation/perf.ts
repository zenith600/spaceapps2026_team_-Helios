// What the browser itself reports about loading and memory. Read-only: the HTTP cache is
// the browser's, and nothing here can or does manage it.

export type ResourceLike = {
  name: string; transferSize: number; encodedBodySize: number; decodedBodySize: number; duration: number;
};

export type ResourceKind = "frames" | "composites" | "cube" | "metadata" | "other";

export type ResourceGroup = {
  kind: ResourceKind; count: number; decodedBytes: number; transferredBytes: number;
  fromCache: number; network: number; unknown: number; totalMs: number;
};

export function classifyResource(url: string): ResourceKind {
  const path = url.split("?")[0];
  if (/\/(frames|visits|detectors|diff|colour|flags)\/[^/]+\.png$/.test(path)) return "frames";
  if (/\/(stack|static|colour)\.png$/.test(path)) return "composites";
  if (/cube\.(u16|npz)$/.test(path)) return "cube";
  if (/\.json$/.test(path) || /\/sky\/(bundle|overlay|explain|change|spectrum|classify)\//.test(path)) return "metadata";
  return "other";
}

/**
 * Group resource-timing entries for one bundle. An entry with a body but no bytes on the
 * wire came from the HTTP cache. Cross-origin responses without Timing-Allow-Origin report
 * zero for everything, so those are counted as unknown rather than guessed.
 */
export function summarizeResources(entries: ResourceLike[], match: (url: string) => boolean): ResourceGroup[] {
  const groups = new Map<ResourceKind, ResourceGroup>();
  for (const e of entries) {
    if (!match(e.name)) continue;
    const kind = classifyResource(e.name);
    const g = groups.get(kind) ?? { kind, count: 0, decodedBytes: 0, transferredBytes: 0, fromCache: 0, network: 0, unknown: 0, totalMs: 0 };
    g.count++;
    g.decodedBytes += e.decodedBodySize;
    g.transferredBytes += e.transferSize;
    g.totalMs += e.duration;
    if (e.decodedBodySize === 0 && e.transferSize === 0) g.unknown++;
    else if (e.transferSize === 0) g.fromCache++;
    else g.network++;
    groups.set(kind, g);
  }
  const order: ResourceKind[] = ["frames", "composites", "cube", "metadata", "other"];
  return order.map((k) => groups.get(k)).filter((g): g is ResourceGroup => Boolean(g));
}

/** How the browser last fetched one URL, from its resource-timing record. */
export function resourceStatus(url: string, entries: ResourceLike[] = readResources()):
  { state: "not-requested" | "network" | "cache" | "opaque"; bytes: number } {
  const abs = typeof location !== "undefined" ? new URL(url, location.href).href : url;
  let e: ResourceLike | undefined;
  for (let k = entries.length - 1; k >= 0; k--) if (entries[k].name === abs) { e = entries[k]; break; }
  if (!e) return { state: "not-requested", bytes: 0 };
  if (e.decodedBodySize === 0 && e.transferSize === 0) return { state: "opaque", bytes: 0 };
  return { state: e.transferSize === 0 ? "cache" : "network", bytes: e.decodedBodySize };
}

export function readResources(): ResourceLike[] {
  if (typeof performance === "undefined" || !performance.getEntriesByType) return [];
  return performance.getEntriesByType("resource") as unknown as ResourceLike[];
}

/** Chromium-only, and coarse by design; null where the browser does not expose it. */
export function readHeap(): { used: number; total: number; limit: number } | null {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  return m ? { used: m.usedJSHeapSize, total: m.totalJSHeapSize, limit: m.jsHeapSizeLimit } : null;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}
