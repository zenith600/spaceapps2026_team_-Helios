"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { type ModelInfo, modelInfo, scoreCandidate } from "@/lib/onnxScore";
import type { Candidate } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Runs our own classifier on the visitor's machine.
 *
 * The network is small and was trained from scratch on our injected planets, so shipping
 * it costs tens of KB and breaks no rule about third-party weights. It scores the same
 * normalised float stamps the training used — not the display PNGs — and it needs no
 * inference server, so it keeps working on a static deployment.
 *
 * The stored score and the one computed here should agree. Showing both is the point: a
 * model you can re-run yourself is a model you can check.
 */
export function BrowserClassifier({ candidate }: { candidate: Candidate }) {
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const [score, setScore] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ms, setMs] = useState<number | null>(null);

  const tensor = (candidate as Candidate & { tensor?: string }).tensor;

  useEffect(() => { modelInfo().then(setInfo).catch(() => setInfo(null)); }, []);
  useEffect(() => { setScore(null); setError(null); setMs(null); }, [candidate.candidate_id]);

  const run = async () => {
    if (!tensor) return;
    setBusy(true); setError(null);
    const t0 = performance.now();
    try {
      setScore(await scoreCandidate(tensor));
      setMs(Math.round(performance.now() - t0));
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally { setBusy(false); }
  };

  if (!info && !tensor) return null;

  const stored = candidate.ml_score;
  const agree = score != null && stored != null && Math.abs(score - stored) < 0.02;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">Run the classifier yourself</span>
        {info?.trained_from_scratch ? (
          <span className="rounded-full border border-sim/50 px-2 py-0.5 text-[10px] text-sim">
            trained from scratch · no third-party weights
          </span>
        ) : null}
      </div>

      <p className="text-muted">
        A small network of ours, trained only on planets we injected into real SPHEREx frames.
        Press the button and it runs here, in your browser, on this candidate&apos;s actual
        pixel data — nothing is sent anywhere.
      </p>

      {!tensor ? (
        <p className="text-muted">
          This candidate was exported without its stamp tensor, so there is nothing to score.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={run} disabled={busy}>
            {busy ? "loading the model…" : score == null ? "Score it here" : "Score again"}
          </Button>
          {score != null ? (
            <span className="flex items-baseline gap-2">
              <span className="mono text-lg font-bold text-accent">{score.toFixed(3)}</span>
              <span className="text-muted">probability it is a real mover</span>
            </span>
          ) : null}
          {ms != null ? <span className="text-muted mono">{ms} ms</span> : null}
        </div>
      )}

      {error ? <p className="text-danger">{error}</p> : null}

      {score != null && stored != null ? (
        <p className={cn("text-[11px]", agree ? "text-muted" : "text-accent")}>
          The pipeline recorded <span className="mono">{stored.toFixed(3)}</span> for this candidate.
          {agree ? " Same answer, recomputed on your machine." :
            " These differ, which would mean the shipped model and the stored score came from different runs."}
        </p>
      ) : null}

      {info ? (
        <details className="text-[10px] text-muted">
          <summary className="cursor-pointer select-none hover:text-fg">About this model</summary>
          <ul className="mt-1 space-y-0.5">
            {info.val_auc != null && Number.isFinite(info.val_auc) ? <li>validation AUC {info.val_auc.toFixed(3)}</li> : null}
            {info.val_acc != null && Number.isFinite(info.val_acc) ? <li>validation accuracy {(100 * info.val_acc).toFixed(0)}%</li> : null}
            {info.n_train ? <li>{info.n_train} training stamps, {info.n_val} held out</li> : null}
            <li>input {info.input}</li>
            <li>pretrained weights: {String(info.pretrained_weights ?? "none")}</li>
            {info.onnx_roundtrip_max_abs_diff != null ? (
              <li>PyTorch vs ONNX agreement: {info.onnx_roundtrip_max_abs_diff.toExponential(1)}</li>
            ) : null}
          </ul>
          <p className="mt-1">
            Trained on a few dozen examples, so treat it as a demonstration of the method rather
            than a reliable detector. The Proof page carries the honest numbers.
          </p>
        </details>
      ) : null}
    </div>
  );
}
