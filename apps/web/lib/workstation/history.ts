// Undo/redo over the workstation's document state (layer config, picked pixel, aperture,
// measurement, analysis parameters). Navigation -- which field, which mode -- lives in the
// URL and is deliberately not part of it.

export type Entry<T> = { state: T; label: string };

export type History<T> = {
  past: Entry<T>[];
  present: Entry<T>;
  future: Entry<T>[];
  /** Consecutive commits with the same key inside the window merge into one step. */
  lastKey: string | null;
  lastAt: number;
};

export const HISTORY_LIMIT = 100;
export const COALESCE_MS = 700;

export function initHistory<T>(state: T, label = "Open view"): History<T> {
  return { past: [], present: { state, label }, future: [], lastKey: null, lastAt: 0 };
}

/**
 * Record a new state. Dragging a slider fires dozens of changes; passing the same
 * `coalesceKey` folds them into the step that started the drag, so one undo reverts it.
 */
export function commit<T>(h: History<T>, state: T, label: string,
                          opts: { coalesceKey?: string; now?: number } = {}): History<T> {
  const now = opts.now ?? Date.now();
  const key = opts.coalesceKey ?? null;
  if (key && h.lastKey === key && now - h.lastAt < COALESCE_MS && h.past.length) {
    return { ...h, present: { state, label }, future: [], lastAt: now };
  }
  const past = [...h.past, h.present];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { past, present: { state, label }, future: [], lastKey: key, lastAt: now };
}

export function undo<T>(h: History<T>): History<T> {
  if (!h.past.length) return h;
  const prev = h.past[h.past.length - 1];
  return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future], lastKey: null, lastAt: 0 };
}

export function redo<T>(h: History<T>): History<T> {
  if (!h.future.length) return h;
  const [next, ...rest] = h.future;
  return { past: [...h.past, h.present], present: next, future: rest, lastKey: null, lastAt: 0 };
}

/** Jump to a step in the combined list `[...past, present, ...future]`. */
export function jumpTo<T>(h: History<T>, index: number): History<T> {
  const all = [...h.past, h.present, ...h.future];
  if (index < 0 || index >= all.length) return h;
  return { past: all.slice(0, index), present: all[index], future: all.slice(index + 1), lastKey: null, lastAt: 0 };
}

export const canUndo = (h: History<unknown>) => h.past.length > 0;
export const canRedo = (h: History<unknown>) => h.future.length > 0;
