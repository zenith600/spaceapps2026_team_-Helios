// A small memo for analysis results computed in the browser (today: change detection).
//
// Identity is everything the result depends on -- the dataset and the exact build of it,
// the operation and its implementation version, and every parameter -- so changing one
// parameter makes a new entry and leaves every other result valid. Nothing is ever
// "invalidated" by hand; a stale key simply stops being asked for and ages out.
//
// It holds derived results only. Source observations are never stored here, so clearing
// it can only cost a recomputation.

export type DerivedKey = {
  /** Bundle slug plus its build time: a rebuilt bundle is a different input. */
  dataset: string;
  op: string;
  version: string;
  params: Record<string, number | string | boolean>;
};

export function keyOf(k: DerivedKey): string {
  const p = Object.keys(k.params).sort().map((name) => `${name}=${k.params[name]}`).join("&");
  return `${k.dataset}|${k.op}@${k.version}|${p}`;
}

export type DerivedEntry = {
  id: string; key: DerivedKey; bytes: number; created: number; lastUsed: number; hits: number; computeMs: number;
};

export class DerivedCache<V = unknown> {
  private map = new Map<string, { entry: DerivedEntry; value: V }>();
  private listeners = new Set<() => void>();
  hits = 0;
  misses = 0;
  evictions = 0;

  constructor(public limit = 24) {}

  get(k: DerivedKey): V | undefined {
    const id = keyOf(k);
    const hit = this.map.get(id);
    if (!hit) { this.misses++; this.emit(); return undefined; }
    this.hits++;
    hit.entry.hits++;
    hit.entry.lastUsed = Date.now();
    // Map iteration order is insertion order; re-insert to mark as most recently used.
    this.map.delete(id);
    this.map.set(id, hit);
    this.emit();
    return hit.value;
  }

  peek(k: DerivedKey): V | undefined {
    return this.map.get(keyOf(k))?.value;
  }

  set(k: DerivedKey, value: V, computeMs: number): void {
    const id = keyOf(k);
    let bytes = 0;
    try { bytes = JSON.stringify(value).length; } catch { /* not serialisable: size unknown */ }
    const now = Date.now();
    this.map.delete(id);
    this.map.set(id, { value, entry: { id, key: k, bytes, created: now, lastUsed: now, hits: 0, computeMs } });
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
      this.evictions++;
    }
    this.emit();
  }

  delete(id: string): boolean {
    const ok = this.map.delete(id);
    if (ok) this.emit();
    return ok;
  }

  /** Remove every entry matching `pred`; returns how many went. */
  clear(pred: (e: DerivedEntry) => boolean = () => true): number {
    let n = 0;
    for (const [id, { entry }] of this.map) if (pred(entry)) { this.map.delete(id); n++; }
    if (n) this.emit();
    return n;
  }

  entries(): DerivedEntry[] {
    return Array.from(this.map.values()).map((v) => ({ ...v.entry })).reverse();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit() { for (const fn of this.listeners) fn(); }
}

/** Bumped whenever the change-map implementation changes, so old results are not reused. */
export const CHANGE_OP = { op: "change_map", version: "ts-1" } as const;

/**
 * Identity of a change-detection result. In the browser it depends on the parameters; the
 * API route takes none, so there the key records the server's own defaults instead.
 */
export function changeKey(bundle: { slug: string; generated_at: string },
                          params: { deg: number; floor: number; threshold: number }, inBrowser: boolean): DerivedKey {
  return {
    dataset: `${bundle.slug}@${bundle.generated_at}`, op: CHANGE_OP.op,
    version: inBrowser ? CHANGE_OP.version : "api",
    params: inBrowser ? { deg: params.deg, floor: params.floor, threshold: params.threshold } : { server_defaults: true },
  };
}

export const derivedCache = new DerivedCache(24);
