// Data access layer. Two backends:
//  - DEMO_MODE (NEXT_PUBLIC_DEMO_MODE=1): static files under /demo and a localStorage crowd store running the
//    same consensus maths as the API (lib/consensus.ts). No network beyond the static host.
//  - API mode: the FastAPI service at NEXT_PUBLIC_API_URL.
import * as C from "./consensus";
import type { Answer, Candidate, CompletenessRow, Dossier, Manifest, MapSummary, SpectrumRow, Target, Task, UserStats, VoteResult } from "./types";

export const DEMO = process.env.NEXT_PUBLIC_DEMO_MODE !== "0";
export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/$/, "");

export function fileUrl(rel: string | null | undefined): string {
  if (!rel) return "";
  if (/^https?:\/\//.test(rel)) return rel;
  return DEMO ? `/demo/${rel}` : `${API_URL}/files/${rel}`;
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return (await r.json()) as T;
}

// ---------------------------------------------------------------------------
// Demo crowd store (localStorage)
// ---------------------------------------------------------------------------
type DemoState = {
  user_id: string; display_name: string; points: number; n_votes: number; skill: C.Skill;
  seen: string[]; consensus: Record<string, { p_real: number; n_votes: number; weighted_votes: number }>;
  patch_credit: Record<string, number>; total_votes: number;
  tasks: Record<string, { candidate_id: string; is_test: boolean; truth: string | null; answered: boolean }>;
};
const KEY = "deepfield-demo-crowd-v1";

function loadState(): DemoState {
  if (typeof window === "undefined") return freshState();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as DemoState;
  } catch { /* ignore */ }
  const s = freshState();
  saveState(s);
  return s;
}
function freshState(): DemoState {
  return { user_id: Math.random().toString(36).slice(2), display_name: "you", points: 0, n_votes: 0, skill: C.emptySkill(),
    seen: [], consensus: {}, patch_credit: {}, total_votes: 0, tasks: {} };
}
function saveState(s: DemoState) {
  if (typeof window !== "undefined") window.localStorage.setItem(KEY, JSON.stringify(s));
}
export function resetDemoCrowd() { if (typeof window !== "undefined") window.localStorage.removeItem(KEY); }

const userStats = (s: DemoState): UserStats => ({ points: s.points, reliability: C.reliability(s.skill), n_test: C.nTest(s.skill), n_votes: s.n_votes });

function testTruth(c: Candidate): string | null {
  if (c.is_simulated && c.injection_id) return "real";
  if (c.status === "artifact" || c.status === "empty") return "bogus";
  return null;
}

async function demoMapSummary(): Promise<MapSummary> {
  const m = await getJson<MapSummary & { per_patch_share: number }>("/demo/map.json");
  const t = await getJson<{ targets: Target[] }>("/demo/targets.json");
  const s = loadState();
  const searched = t.targets.filter((x) => x.status === "searched");
  const surviving = 1 - m.frac_excluded_prior;
  let verified = 0;
  const patches = searched.map((p) => {
    const credit = C.patchCredit(s.patch_credit[p.patch_id] || 0);
    verified += m.per_patch_share * credit;
    return { ...p, crowd_credit: credit, exclusion_share: m.per_patch_share };
  });
  const frac_df = surviving * verified;
  return { ...m, frac_excluded_deepfield: frac_df, frac_excluded_total: m.frac_excluded_prior + frac_df, n_votes: s.total_votes, patches };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function getMap(): Promise<MapSummary> {
  return DEMO ? demoMapSummary() : getJson<MapSummary>(`${API_URL}/map`);
}

export async function getTargets(): Promise<{ targets: Target[]; source: string }> {
  return getJson(DEMO ? "/demo/targets.json" : `${API_URL}/targets`);
}

export async function getCandidates(): Promise<{ candidates: Candidate[]; source: string }> {
  if (!DEMO) return getJson(`${API_URL}/candidates`);
  const j = await getJson<{ candidates: Candidate[]; source: string }>("/demo/candidates.json");
  const s = loadState();
  return { ...j, candidates: j.candidates.map((c) => {
    const k = s.consensus[c.candidate_id];
    return k ? { ...c, crowd_p_real: k.p_real, n_votes: k.n_votes } : c;
  }) };
}

export async function getCandidate(id: string): Promise<{ candidate: Candidate; spectrum: SpectrumRow[]; dossier: Dossier | null; spectrum_source: string }> {
  if (!DEMO) return getJson(`${API_URL}/candidates/${id}`);
  const all = await getCandidates();
  const candidate = all.candidates.find((c) => c.candidate_id === id);
  if (!candidate) throw new Error("unknown candidate");
  const sp = await getJson<{ rows: SpectrumRow[]; source: string }>(`/demo/spectra/${id}.json`);
  let dossier: Dossier | null = null;
  try { dossier = await getJson<Dossier>(`/demo/dossiers/${id}.json`); } catch { dossier = null; }
  return { candidate, spectrum: sp.rows, dossier, spectrum_source: sp.source };
}

export async function getCompleteness(): Promise<{ rows: CompletenessRow[]; source: string }> {
  return getJson(DEMO ? "/demo/completeness.json" : `${API_URL}/completeness`);
}

export async function getManifest(): Promise<Manifest> {
  return getJson(DEMO ? "/demo/manifest.json" : `${API_URL}/manifest`);
}

export async function getTask(): Promise<Task> {
  if (!DEMO) {
    const uid = typeof window !== "undefined" ? window.localStorage.getItem("deepfield-user-id") : null;
    const t = await getJson<Task>(`${API_URL}/task${uid ? `?user_id=${uid}` : ""}`);
    if (typeof window !== "undefined") window.localStorage.setItem("deepfield-user-id", t.user_id);
    return t;
  }
  const s = loadState();
  const { candidates } = await getCandidates();
  const tests = candidates.filter((c) => testTruth(c) !== null);
  let live = candidates.filter((c) => testTruth(c) === null && !s.seen.includes(c.candidate_id));
  const wantTest = C.isTestCard(Math.random()) || live.length === 0;
  let chosen: Candidate; let isTest = false; let truth: string | null = null;
  if (wantTest && tests.length) {
    const unseen = tests.filter((c) => !s.seen.includes(c.candidate_id));
    const pool = unseen.length ? unseen : tests;
    chosen = pool[Math.floor(Math.random() * pool.length)]; isTest = true; truth = testTruth(chosen);
  } else {
    if (!live.length) live = candidates.filter((c) => testTruth(c) === null);
    if (!live.length) live = candidates;
    live.sort((a, b) => Math.abs((a.ml_score ?? 0.5) - 0.5) - Math.abs((b.ml_score ?? 0.5) - 0.5));
    chosen = live[0];
  }
  const task_id = Math.random().toString(36).slice(2);
  s.tasks[task_id] = { candidate_id: chosen.candidate_id, is_test: isTest, truth, answered: false };
  saveState(s);
  const { candidate_id, patch_id, n_epochs, n_bands, snr_stack, snr_single_max, best_distance_au, ml_score, source } = chosen;
  return { task_id, user_id: s.user_id, candidate: { candidate_id, patch_id, n_epochs, n_bands, snr_stack, snr_single_max, best_distance_au, ml_score, source },
    stamps: chosen.stamps, prompt: "Blink the frames, then look at the stack. Is there a real mover?", user: userStats(s) };
}

export async function postVote(task: Task, answer: Answer, click?: { x: number; y: number }): Promise<VoteResult> {
  if (!DEMO) {
    const r = await fetch(`${API_URL}/vote`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: task.user_id, task_id: task.task_id, answer, click_x: click?.x ?? null, click_y: click?.y ?? null }) });
    if (!r.ok) throw new Error(`vote failed: ${r.status}`);
    return (await r.json()) as VoteResult;
  }
  const s = loadState();
  const t = s.tasks[task.task_id];
  if (!t || t.answered) throw new Error("task already answered");
  const { candidates } = await getCandidates();
  const cand = candidates.find((c) => c.candidate_id === t.candidate_id)!;
  const weight = C.voteWeight(s.skill);
  t.answered = true; s.seen.push(cand.candidate_id); s.total_votes += 1; s.n_votes += 1;
  const result: VoteResult = { candidate_id: cand.candidate_id, is_test: t.is_test, answer, points_awarded: 0, user: userStats(s),
    map: { frac_excluded_prior: 0, frac_excluded_deepfield: 0, frac_excluded_total: 0, n_votes: s.total_votes } };
  if (t.is_test && t.truth) {
    s.skill = C.updateSkill(s.skill, answer, t.truth);
    const correct = C.normaliseAnswer(answer) === C.normaliseAnswer(t.truth);
    result.truth = t.truth; result.correct = correct;
    result.reveal = { is_simulated: cand.is_simulated, injected_mag: cand.injected_mag, injected_distance_au: cand.injected_distance_au, status: cand.status };
    if (correct && cand.is_simulated) s.patch_credit[cand.patch_id] = (s.patch_credit[cand.patch_id] || 0) + Math.max(weight, 0.1);
  } else {
    const k = s.consensus[cand.candidate_id] || { p_real: cand.ml_score ?? cand.rule_score ?? 0.5, n_votes: 0, weighted_votes: 0 };
    const p = C.updateProbability(k.p_real, answer, s.skill);
    s.consensus[cand.candidate_id] = { p_real: p, n_votes: k.n_votes + 1, weighted_votes: k.weighted_votes + weight };
    result.consensus = { p_real: p, n_votes: k.n_votes + 1 };
  }
  const pts = C.pointsFor(answer, t.is_test ? t.truth : null);
  s.points += pts; result.points_awarded = pts; result.user = userStats(s);
  saveState(s);
  const m = await demoMapSummary();
  result.map = { frac_excluded_prior: m.frac_excluded_prior, frac_excluded_deepfield: m.frac_excluded_deepfield, frac_excluded_total: m.frac_excluded_total, n_votes: m.n_votes };
  return result;
}
