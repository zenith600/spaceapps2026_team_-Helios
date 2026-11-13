// TypeScript port of pipeline/deepfield/crowd/consensus.py (SWAP-style skill-weighted voting).
// Must stay numerically identical to the Python; both are tested against tests/fixtures/consensus.json.

export const PRIOR_A = 3.0;
export const PRIOR_B = 2.0;
export const SKILL_MIN = 0.05, SKILL_MAX = 0.95;
export const P_MIN = 0.001, P_MAX = 0.999;
export const TEST_CARD_FRACTION = 0.1;
export const POINTS_TEST_CORRECT = 10, POINTS_TEST_WRONG = -2, POINTS_VOTE = 1;
export const VOTES_TO_CREDIT_PATCH = 10.0;

export type Skill = { real_correct: number; real_seen: number; bogus_correct: number; bogus_seen: number };
export const emptySkill = (): Skill => ({ real_correct: 0, real_seen: 0, bogus_correct: 0, bogus_seen: 0 });

const clip = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

export function pReal(s: Skill): number {
  return clip((s.real_correct + PRIOR_A) / (s.real_seen + PRIOR_A + PRIOR_B), SKILL_MIN, SKILL_MAX);
}
export function pBogus(s: Skill): number {
  return clip((s.bogus_correct + PRIOR_A) / (s.bogus_seen + PRIOR_A + PRIOR_B), SKILL_MIN, SKILL_MAX);
}
export const reliability = (s: Skill) => 0.5 * (pReal(s) + pBogus(s));
export const nTest = (s: Skill) => Math.floor(s.real_seen + s.bogus_seen);

export function normaliseAnswer(a: string): "real" | "bogus" {
  const x = a.trim().toLowerCase();
  if (x === "real") return "real";
  if (x === "artifact" || x === "nothing" || x === "bogus") return "bogus";
  throw new Error(`unknown answer ${a}`);
}

export function updateSkill(s: Skill, answer: string, truth: string): Skill {
  const a = normaliseAnswer(answer), t = normaliseAnswer(truth);
  const n = { ...s };
  if (t === "real") { n.real_seen += 1; n.real_correct += a === "real" ? 1 : 0; }
  else { n.bogus_seen += 1; n.bogus_correct += a === "bogus" ? 1 : 0; }
  return n;
}

export function updateProbability(p: number, answer: string, s: Skill): number {
  const a = normaliseAnswer(answer);
  const pr = pReal(s), pb = pBogus(s);
  p = clip(p, P_MIN, P_MAX);
  let num: number, den: number;
  if (a === "real") { num = p * pr; den = num + (1 - p) * (1 - pb); }
  else { num = p * (1 - pr); den = num + (1 - p) * pb; }
  return clip(num / den, P_MIN, P_MAX);
}

export const voteWeight = (s: Skill) => clip(2 * reliability(s) - 1, 0, 1);
export const pointsFor = (answer: string, truth: string | null) =>
  truth == null ? POINTS_VOTE : normaliseAnswer(answer) === normaliseAnswer(truth) ? POINTS_TEST_CORRECT : POINTS_TEST_WRONG;
export const patchCredit = (weighted: number, needed = VOTES_TO_CREDIT_PATCH) => clip(weighted / needed, 0, 1);
export const isTestCard = (draw: number, fraction = TEST_CARD_FRACTION) => draw < fraction;
