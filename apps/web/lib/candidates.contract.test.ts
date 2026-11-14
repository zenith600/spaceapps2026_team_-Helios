// The Candidate type promised `best_distance_au: number`, but the pipeline writes null when
// the best trial is stationary. The synthetic SAMPLE bundle never produced one, so nothing
// caught it until the real release did — and /classify crashed on `.toFixed` of null.
//
// This checks the shipped bundle against the type's promises: every field the type says is
// non-nullable must be non-null in every row. If the pipeline starts emitting null for a
// field, this fails and the type has to say so, so the compiler can find every unsafe use.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const rows = JSON.parse(readFileSync(resolve(__dirname, "../public/demo/candidates.json"), "utf8"))
  .candidates as Record<string, unknown>[];

// Fields lib/types.ts declares as plain `number` (not `number | null`). Keep in step with it.
const NON_NULL_NUMBERS = ["snr_stack", "snr_single_max", "flux_mjysr", "n_epochs", "n_bands",
                          "rule_score", "crowd_p_real", "n_votes", "ra_deg", "dec_deg"];

describe("shipped candidates honour the Candidate type", () => {
  it("has candidates to check", () => expect(rows.length).toBeGreaterThan(0));

  for (const field of NON_NULL_NUMBERS) {
    it(`${field} is always a finite number`, () => {
      for (const r of rows) {
        expect(typeof r[field], `${r.candidate_id}.${field}`).toBe("number");
        expect(Number.isFinite(r[field] as number), `${r.candidate_id}.${field}`).toBe(true);
      }
    });
  }

  it("best_distance_au is a number or null — and null does occur in real data", () => {
    for (const r of rows) {
      const v = r.best_distance_au;
      expect(v === null || (typeof v === "number" && Number.isFinite(v)), String(r.candidate_id)).toBe(true);
    }
    // The case that crashed /classify. If the bundle stops containing one, this test is
    // no longer exercising the null path and should be revisited.
    expect(rows.some((r) => r.best_distance_au === null)).toBe(true);
  });
});
