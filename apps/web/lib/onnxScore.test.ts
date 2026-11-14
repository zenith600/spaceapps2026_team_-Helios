// The browser runs our classifier with onnxruntime-web; the pipeline scored the same
// candidates with onnxruntime in Python and stored the result as `ml_score`. If the two
// disagree, the Lab would show a stored score the visitor cannot reproduce — so run the
// exact browser runtime here, on the exported model and tensors, and compare.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as ort from "onnxruntime-web";

const demo = resolve(__dirname, "../public/demo");
const modelPath = resolve(demo, "model.onnx");
const hasModel = existsSync(modelPath);

type Cand = { candidate_id: string; ml_score: number | null; tensor?: string; is_simulated: boolean };
const cands = (JSON.parse(readFileSync(resolve(demo, "candidates.json"), "utf8")).candidates as Cand[])
  .filter((c) => c.tensor);

describe.skipIf(!hasModel)("browser classifier reproduces the pipeline's scores", () => {
  ort.env.wasm.numThreads = 1;
  const session = ort.InferenceSession.create(new Uint8Array(readFileSync(modelPath)),
    { executionProviders: ["wasm"] });

  it("ships a model with the advertised input and output", async () => {
    const s = await session;
    expect(s.inputNames).toEqual(["stamps"]);
    expect(s.outputNames).toEqual(["prob"]);
  });

  it("has a tensor for every candidate it scores", () => {
    expect(cands.length).toBeGreaterThan(0);
  });

  for (const c of cands) {
    it(`${c.candidate_id}: same probability as the stored ml_score`, async () => {
      const s = await session;
      const raw = readFileSync(resolve(demo, c.tensor!));
      const data = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
      expect(data.length).toBe(3 * 32 * 32);
      const out = await s.run({ stamps: new ort.Tensor("float32", Float32Array.from(data), [1, 3, 32, 32]) });
      const p = (out.prob.data as Float32Array)[0];
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
      if (c.ml_score != null) {
        // Same weights, same input, two runtimes: agreement to float32 rounding.
        expect(Math.abs(p - c.ml_score)).toBeLessThan(1e-4);
      }
    });
  }

  it("is batch-safe: scoring together gives the same answers as one at a time", async () => {
    const s = await session;
    const tensors = cands.map((c) => {
      const raw = readFileSync(resolve(demo, c.tensor!));
      return Float32Array.from(new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4));
    });
    const batch = new Float32Array(tensors.length * 3 * 32 * 32);
    tensors.forEach((t, i) => batch.set(t, i * t.length));
    const out = await s.run({ stamps: new ort.Tensor("float32", batch, [tensors.length, 3, 32, 32]) });
    const probs = Array.from(out.prob.data as Float32Array);
    cands.forEach((c, i) => {
      if (c.ml_score != null) expect(Math.abs(probs[i] - c.ml_score)).toBeLessThan(1e-4);
    });
  });
});

describe("model card", () => {
  it.skipIf(!hasModel)("declares it was trained from scratch, with no pretrained weights", () => {
    const card = JSON.parse(readFileSync(resolve(demo, "model.json"), "utf8"));
    expect(card.trained_from_scratch).toBe(true);
    expect(card.pretrained_weights).toBeNull();
    expect(card.onnx_roundtrip_max_abs_diff).toBeLessThan(1e-4);
  });
});
