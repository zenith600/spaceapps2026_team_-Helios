// Pixel statistics for the Histogram panel, in calibrated surface brightness read from the
// same uint16 cube spectra use (decoded through `decode`, so the log-stored variance plane
// and the nodata code are handled the one correct way).
import { type CubeU16, decode } from "../sky";
import type { FrameMode, PlayFrame } from "../../components/SkyPlayer";

/**
 * Which cube exposures a displayed frame was built from. Empty when the frame is not a
 * plain combination of exposures (difference frames are visit − first visit).
 */
export function cubePlanesForFrame(cube: CubeU16, frame: PlayFrame, mode: FrameMode): number[] {
  const n = cube.shape[1];
  const out: number[] = [];
  if (mode === "difference") return out;
  for (let i = 0; i < n; i++) {
    if (mode === "epochs") {
      if (cube.obs_id[i] === frame.obsId && cube.detector[i] === frame.detector && Math.abs(cube.mjd[i] - frame.mjd) < 1e-5) out.push(i);
    } else if (mode === "detectors") {
      if (cube.visit[i] === frame.visit && cube.detector[i] === frame.detector) out.push(i);
    } else if (cube.visit[i] === frame.visit) {
      out.push(i);
    }
  }
  return out;
}

/** Decoded flux of every usable pixel in the given exposures (flux and variance both valid). */
export function fluxValues(cube: CubeU16, data: Uint16Array, planes: number[]): Float64Array {
  const [, n, ny, nx] = cube.shape;
  const plane = ny * nx;
  const vals: number[] = [];
  for (const i of planes) {
    const cf = cube.codec.find((c) => c.plane === "flux" && c.i === i);
    if (!cf) continue;
    for (let p = 0; p < plane; p++) {
      const fc = data[i * plane + p], vc = data[(n + i) * plane + p];
      if (fc === cube.nodata_code || vc === cube.nodata_code) continue;
      vals.push(decode(cf, fc));
    }
  }
  return Float64Array.from(vals);
}

export type Stats = {
  n: number; min: number; max: number; mean: number; median: number;
  p01: number; p99: number; sigmaMad: number;
};

export function robustStats(values: ArrayLike<number>): Stats | null {
  const xs = Array.from(values).filter(Number.isFinite).sort((a, b) => a - b);
  const n = xs.length;
  if (!n) return null;
  const q = (f: number) => xs[Math.min(n - 1, Math.max(0, Math.round(f * (n - 1))))];
  const median = n % 2 ? xs[(n - 1) / 2] : 0.5 * (xs[n / 2 - 1] + xs[n / 2]);
  const dev = xs.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = n % 2 ? dev[(n - 1) / 2] : 0.5 * (dev[n / 2 - 1] + dev[n / 2]);
  return {
    n, min: xs[0], max: xs[n - 1], mean: xs.reduce((a, b) => a + b, 0) / n, median,
    p01: q(0.01), p99: q(0.99), sigmaMad: 1.4826 * mad,
  };
}

/** Equal-width bins over [lo, hi]; values outside are counted in under/over, not dropped silently. */
export function histogram(values: ArrayLike<number>, bins: number, lo: number, hi: number) {
  const counts = new Array(bins).fill(0);
  let under = 0, over = 0;
  const w = (hi - lo) / bins || 1;
  for (let k = 0; k < values.length; k++) {
    const v = values[k];
    if (!Number.isFinite(v)) continue;
    if (v < lo) { under++; continue; }
    if (v > hi) { over++; continue; }
    counts[Math.min(bins - 1, Math.floor((v - lo) / w))]++;
  }
  return { counts, lo, hi, width: w, under, over };
}
