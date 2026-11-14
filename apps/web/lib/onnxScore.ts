// Run our own real/bogus classifier in the visitor's browser.
//
// The network is small (tens of KB) and was trained from scratch on our own injected
// planets — no third-party weights, which is what the project rule requires. Running it
// client-side means the "is this a real mover?" score is computed on the viewer's machine
// from the same normalised float stamps the training used, not from the 8-bit display
// PNGs, and it keeps working on a static deployment with no inference server.
//
// Everything here is lazy: onnxruntime-web is a large dependency and is only fetched when
// someone actually asks for a score.
import { fileUrl } from "./api";

export type ModelInfo = {
  val_auc?: number; val_acc?: number; n_train?: number; n_val?: number;
  trained_from_scratch?: boolean; pretrained_weights?: null | string;
  input?: string; output?: string; onnx_roundtrip_max_abs_diff?: number;
};

const STAMP = 32, CHANNELS = 3;

let sessionPromise: Promise<unknown> | null = null;
let ortModule: typeof import("onnxruntime-web") | null = null;

export async function modelInfo(): Promise<ModelInfo | null> {
  try {
    const r = await fetch(fileUrl("model.json"), { cache: "force-cache" });
    return r.ok ? ((await r.json()) as ModelInfo) : null;
  } catch {
    return null;
  }
}

export async function modelAvailable(): Promise<boolean> {
  try {
    const r = await fetch(fileUrl("model.onnx"), { method: "HEAD" });
    return r.ok;
  } catch {
    return false;
  }
}

async function session() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const ort = await import("onnxruntime-web");
    ortModule = ort;
    // WASM only: no WebGL/WebGPU fallbacks to go wrong on a judge's laptop.
    ort.env.wasm.numThreads = 1;
    const buf = await (await fetch(fileUrl("model.onnx"))).arrayBuffer();
    return ort.InferenceSession.create(new Uint8Array(buf), {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
  })();
  return sessionPromise;
}

/** Score one candidate from its exported 3x32x32 float32 tensor. */
export async function scoreCandidate(tensorPath: string): Promise<number> {
  const [sess, buf] = await Promise.all([
    session(),
    fetch(fileUrl(tensorPath)).then((r) => {
      if (!r.ok) throw new Error(`stamp tensor missing (${r.status})`);
      return r.arrayBuffer();
    }),
  ]);
  const expected = CHANNELS * STAMP * STAMP;
  const data = new Float32Array(buf);
  if (data.length !== expected) {
    throw new Error(`stamp tensor is ${data.length} floats, expected ${expected}`);
  }
  const ort = ortModule!;
  const input = new ort.Tensor("float32", data, [1, CHANNELS, STAMP, STAMP]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await (sess as any).run({ stamps: input });
  const prob = out.prob?.data?.[0];
  if (typeof prob !== "number") throw new Error("model returned no probability");
  return prob;
}

export function resetModel() {
  sessionPromise = null;
  ortModule = null;
}
