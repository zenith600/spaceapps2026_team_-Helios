// Port of pipeline/deepfield/spectral/templates.py + sky/analyse.py:classify_point.
//
// It lives in the browser so a static deployment can still answer "what kind of thing is
// this?" when you click a point. Both implementations are held to the same numbers by
// lib/spectralFit.test.ts against a Python-generated fixture — if they drift, the same
// click gives two different verdicts depending on how the app was deployed.
//
// These are simple physical models, not trained weights: no third-party model is involved.
import type { Classification, SpectrumPoint } from "./sky";

const H = 6.62607015e-34, C = 2.99792458e8, KB = 1.380649e-23;
const V_UM = 0.55;

export function planckNu(waveUm: number, T: number): number {
  const nu = C / (waveUm * 1e-6);
  const x = (H * nu) / (KB * T);
  return (nu ** 3) / Math.expm1(x);
}

const solarRel = (w: number) => planckNu(w, 5772) / planckNu(V_UM, 5772);
const dip = (w: number, c: number, width: number, depth: number) =>
  1 - depth * Math.exp(-0.5 * ((w - c) / width) ** 2);

const CH4: [number, number, number][] = [
  [0.89, 0.03, 0.5], [1.15, 0.04, 0.6], [1.4, 0.06, 0.8],
  [1.7, 0.07, 0.8], [2.3, 0.12, 0.9], [3.3, 0.25, 0.9],
];

export function planetAlbedo(w: number): number {
  let a = 0.6;
  for (const [c, wd, d] of CH4) a *= dip(w, c, wd, d);
  if (w > 2.6) a *= Math.exp(-(w - 2.6) / 1.5);
  return a;
}

export const asteroidAlbedo = (w: number) => 0.6 * (1 + 0.15 * (w - V_UM));

export function templateFnu(kind: "planet" | "asteroid" | "star", w: number): number {
  if (kind === "planet") return (solarRel(w) * planetAlbedo(w)) / planetAlbedo(V_UM);
  if (kind === "asteroid") return (solarRel(w) * asteroidAlbedo(w)) / asteroidAlbedo(V_UM);
  return planckNu(w, 4500) / planckNu(V_UM, 4500);
}

const KINDS = ["planet", "asteroid", "star"] as const;

export const TEMPLATE_LABELS: Record<string, [string, string]> = {
  planet: ["cold and methane-rich",
    "Reflected sunlight with methane absorption — the signature of a cold giant planet or a brown dwarf."],
  asteroid: ["reflected sunlight",
    "A flat, slightly red reflection spectrum, like rock or ice lit by the Sun."],
  star: ["star-like",
    "A smooth thermal glow with no absorption dips, like an ordinary star."],
  none: ["not enough data", "Too few bands measured here to tell."],
};

/** Best single blackbody colour temperature, by coarse geometric scan. */
export function fitTemperature(w: number[], f: number[], e: number[]) {
  const ok = w.map((_, i) => Number.isFinite(f[i]) && Number.isFinite(e[i]) && e[i] > 0);
  const W = w.filter((_, i) => ok[i]), F = f.filter((_, i) => ok[i]), E = e.filter((_, i) => ok[i]);
  if (W.length < 3 || new Set(W.map((x) => x.toFixed(2))).size < 3) {
    return { temperature_k: null, chi2_per_dof: null };
  }
  let bestChi = Infinity, bestT: number | null = null;
  const n = 220, lo = Math.log(100), hi = Math.log(20000);
  for (let k = 0; k < n; k++) {
    const T = Math.exp(lo + ((hi - lo) * k) / (n - 1));
    const t = W.map((x) => planckNu(x, T));
    const tmax = Math.max(...t);
    if (!(tmax > 0)) continue;
    const tn = t.map((v) => v / tmax);
    let num = 0, den = 0;
    for (let i = 0; i < W.length; i++) { const wt = 1 / E[i] ** 2; num += wt * tn[i] * F[i]; den += wt * tn[i] * tn[i]; }
    const s = num / Math.max(den, 1e-30);
    if (s <= 0) continue;
    let chi = 0;
    for (let i = 0; i < W.length; i++) chi += ((F[i] - s * tn[i]) / E[i]) ** 2;
    if (chi < bestChi) { bestChi = chi; bestT = T; }
  }
  if (bestT === null) return { temperature_k: null, chi2_per_dof: null };
  return {
    temperature_k: Math.round(bestT),
    chi2_per_dof: Math.round((bestChi / Math.max(W.length - 2, 1)) * 100) / 100,
  };
}

export function fitTemplates(w: number[], f: number[], e: number[]) {
  const idx = w.map((_, i) => i).filter((i) => Number.isFinite(f[i]) && Number.isFinite(e[i]) && e[i] > 0);
  if (idx.length < 2) return { n: idx.length, chi2: {} as Record<string, number>, methane_score: NaN, best: "none" };
  const chi2: Record<string, number> = {};
  for (const kind of KINDS) {
    const t = w.map((x) => templateFnu(kind, x));
    let num = 0, den = 0;
    for (const i of idx) { const wt = 1 / e[i] ** 2; num += wt * t[i] * f[i]; den += wt * t[i] * t[i]; }
    const s = Math.max(num / Math.max(den, 1e-30), 0);
    let c = 0;
    for (const i of idx) c += ((f[i] - s * t[i]) / e[i]) ** 2;
    chi2[kind] = c;
  }
  const cs = KINDS.map((k) => chi2[k]);
  const min = Math.min(...cs);
  const like = cs.map((c) => Math.exp(-0.5 * (c - min)));
  const sum = like.reduce((a, b) => a + b, 0);
  const p = like.map((l) => l / sum);
  return { n: idx.length, chi2, methane_score: p[0], best: KINDS[p.indexOf(Math.max(...p))] as string };
}

/** Same verdict shape the API returns, computed locally. */
export function classifyPoints(points: SpectrumPoint[]): Classification {
  if (!points.length) return { available: false, reason: "no usable exposures at this point" };
  const w = points.map((p) => p.wave_um), f = points.map((p) => p.flux_mjysr), e = points.map((p) => p.flux_err_mjysr);
  const nBands = new Set(w.map((x) => x.toFixed(2))).size;
  if (nBands < 3) {
    return { available: false,
      reason: `only ${nBands} distinct colour${nBands === 1 ? "" : "s"} here — need at least three to compare shapes` };
  }
  const fit = fitTemplates(w, f, e);
  const temp = fitTemperature(w, f, e);
  const best = fit.best;
  const [label, meaning] = TEMPLATE_LABELS[best] ?? TEMPLATE_LABELS.none;
  const dof = Math.max(fit.n - 1, 1);
  const ranked = Object.entries(fit.chi2).filter(([, v]) => Number.isFinite(v)).sort((a, b) => a[1] - b[1]);
  // How badly does even the best template fit? High means none of our shapes explain this,
  // which says something about our small model library rather than about the object.
  const bestChi = ranked.length ? Math.round((ranked[0][1] / dof) * 100) / 100 : null;
  const unexplained = bestChi !== null && bestChi > 5.0;
  return {
    available: true, best, label, meaning,
    confident: ranked.length > 1 && ranked[1][1] - ranked[0][1] > 2.0,
    unexplained,
    best_chi2_per_dof: bestChi,
    anomaly_note: unexplained
      ? "None of the three templates fits this spectrum well. That makes it worth a look, but it is a " +
        "gap in our small model library, not evidence of something new — a blended pair, a variable " +
        "source, or a bad measurement all land here too."
      : null,
    methane_score: Number.isFinite(fit.methane_score) ? Math.round(fit.methane_score * 1000) / 1000 : null,
    n_bands: nBands,
    ranking: ranked.map(([k, v]) => ({ template: k, label: TEMPLATE_LABELS[k][0], chi2_per_dof: Math.round((v / dof) * 100) / 100 })),
    temperature: temp,
    method: "Weighted least-squares fit of three fixed template shapes, plus a single blackbody colour " +
      "temperature. No trained model, no third-party weights — the templates are simple physical models.",
    caveat: "A shape match is a hint, not an identification: these templates are illustrative, and a " +
      "handful of bands rarely pins down what something is.",
  };
}
