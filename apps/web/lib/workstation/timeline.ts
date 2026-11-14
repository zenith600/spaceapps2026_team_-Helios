// Timeline geometry. Two scales: real time (frames sit at their MJD, so the six-month
// survey cadence is visible) and frame index (evenly spaced, so exposures taken minutes
// apart inside one visit can still be told apart and scrubbed).
import { mjdToDate } from "../sky";

export type TimeScale = "time" | "index";

export type Scale = {
  /** Fraction 0..1 across the track for frame k. */
  frac: (k: number) => number;
  /** Fraction 0..1 for an arbitrary MJD (time scale) -- index scale maps via nearest frame. */
  fracOfMjd: (mjd: number) => number;
  /** The frame nearest to a fraction 0..1. */
  nearest: (f: number) => number;
  t0: number;
  t1: number;
};

/** A little padding so the first and last frame are not drawn on the edge. */
const PAD = 0.02;

export function makeScale(mjds: number[], mode: TimeScale): Scale {
  const n = mjds.length;
  const t0 = n ? Math.min(...mjds) : 0;
  const t1 = n ? Math.max(...mjds) : 1;
  const span = t1 - t0 || 1;
  const inner = (f: number) => PAD + f * (1 - 2 * PAD);
  const outer = (f: number) => (f - PAD) / (1 - 2 * PAD);

  if (mode === "index") {
    const frac = (k: number) => inner(n <= 1 ? 0.5 : k / (n - 1));
    return {
      frac,
      fracOfMjd: (mjd) => frac(nearestByMjd(mjds, mjd)),
      nearest: (f) => (n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(outer(f) * (n - 1))))),
      t0, t1,
    };
  }
  const fracOfMjd = (mjd: number) => inner(n <= 1 ? 0.5 : (mjd - t0) / span);
  return {
    frac: (k) => fracOfMjd(mjds[k] ?? t0),
    fracOfMjd,
    nearest: (f) => nearestByMjd(mjds, t0 + outer(f) * span),
    t0, t1,
  };
}

/** Index of the frame whose MJD is closest; ties go to the earlier frame. */
export function nearestByMjd(mjds: number[], mjd: number): number {
  let best = 0, bestD = Infinity;
  for (let k = 0; k < mjds.length; k++) {
    const d = Math.abs(mjds[k] - mjd);
    if (d < bestD) { best = k; bestD = d; }
  }
  return best;
}

export type Tick = { mjd: number; label: string; major: boolean };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MJD_EPOCH_MS = Date.UTC(1858, 10, 17);
const toMjd = (ms: number) => (ms - MJD_EPOCH_MS) / 86400000;

/**
 * Calendar ticks between two MJDs: days for short spans, months for long ones, with the
 * year marked as major. Never more than about `maxTicks`.
 */
export function timeTicks(t0: number, t1: number, maxTicks = 12): Tick[] {
  const span = Math.max(t1 - t0, 1e-6);
  const out: Tick[] = [];
  if (span <= 45) {
    const steps = [1, 2, 5, 7, 14];
    const step = steps.find((s) => span / s <= maxTicks) ?? 14;
    const start = Math.ceil(t0 / step) * step;
    for (let m = start; m <= t1 + 1e-9; m += step) {
      const d = mjdToDate(m);
      out.push({ mjd: m, label: `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`, major: d.getUTCDate() === 1 });
    }
    return out;
  }
  const monthSteps = [1, 2, 3, 6, 12];
  const months = span / 30.44;
  const step = monthSteps.find((s) => months / s <= maxTicks) ?? 12;
  const d0 = mjdToDate(t0);
  const y = d0.getUTCFullYear();
  // first month boundary after t0 that lands on the step grid
  let m = d0.getUTCMonth() + 1;
  while (m % step !== 0) m += 1;
  for (let guard = 0; guard < 400; guard++) {
    const yy = y + Math.floor(m / 12), mm = m % 12;
    const mjd = toMjd(Date.UTC(yy, mm, 1));
    if (mjd > t1) break;
    out.push({ mjd, label: mm === 0 ? String(yy) : MONTHS[mm], major: mm === 0 });
    m += step;
  }
  return out;
}

export function formatDuration(days: number): string {
  if (!Number.isFinite(days)) return "—";
  if (days < 1) return `${(days * 24).toFixed(1)} h`;
  if (days < 60) return `${days.toFixed(1)} d`;
  return `${Math.round(days)} d (${(days / 365.25).toFixed(2)} yr)`;
}
