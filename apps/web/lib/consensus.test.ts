import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emptySkill, pBogus, pReal, updateProbability, updateSkill, voteWeight, patchCredit } from "./consensus";

const fixture = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "tests", "fixtures", "consensus.json"), "utf8"));

describe("consensus (TS port matches Python)", () => {
  it("prior skill is 0.6", () => {
    expect(pReal(emptySkill())).toBeCloseTo(0.6, 12);
    expect(pBogus(emptySkill())).toBeCloseTo(0.6, 12);
  });
  it("probability fixture", () => {
    for (const c of fixture.probability) {
      expect(updateProbability(c.p, c.answer, c.skill)).toBeCloseTo(c.expected, 12);
    }
  });
  it("skill fixture", () => {
    for (const c of fixture.skill) {
      const s = updateSkill(c.skill, c.answer, c.truth);
      expect(pReal(s)).toBeCloseTo(c.p_real, 12);
      expect(pBogus(s)).toBeCloseTo(c.p_bogus, 12);
    }
  });
  it("weights and credit", () => {
    expect(voteWeight({ real_correct: 0, real_seen: 20, bogus_correct: 0, bogus_seen: 20 })).toBe(0);
    expect(patchCredit(5)).toBe(0.5);
    expect(patchCredit(50)).toBe(1);
  });
});
