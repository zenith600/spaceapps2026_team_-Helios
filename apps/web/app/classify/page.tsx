"use client";
import { useCallback, useEffect, useState } from "react";
import { BlinkViewer } from "@/components/BlinkViewer";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SourceTag } from "@/components/Tags";
import { getTask, postVote } from "@/lib/api";
import type { Answer, Task, VoteResult } from "@/lib/types";
import { fmt, pct } from "@/lib/utils";

export default function Classify() {
  const [task, setTask] = useState<Task | null>(null);
  const [result, setResult] = useState<VoteResult | null>(null);
  const [click, setClick] = useState<{ x: number; y: number } | undefined>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const next = useCallback(async () => {
    setResult(null); setClick(undefined); setErr(null);
    try { setTask(await getTask()); } catch (e) { setErr(String(e)); }
  }, []);
  useEffect(() => { next(); }, [next]);

  const vote = async (a: Answer) => {
    if (!task || busy) return;
    setBusy(true);
    try { setResult(await postVote(task, a, click)); } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-md">
      <div className="mb-2 flex items-center justify-between text-xs text-muted">
        <span>Classify · card {task ? (task.user.n_votes + 1) : "—"}</span>
        <span className="mono">{task ? `${task.user.points} pts · reliability ${pct(task.user.reliability, 0)}` : ""}</span>
      </div>
      {err ? <p className="text-sm text-danger">{err}</p> : null}
      {task && !result ? (
        <Card>
          <CardContent className="flex flex-col gap-3 pt-4">
            <p className="text-sm">{task.prompt} <span className="text-muted">Tap the spot if you see it.</span></p>
            <BlinkViewer stamps={task.stamps} isSimulated={false} compact onClick={setClick} />
            <div className="mono text-[11px] text-muted">
              {task.candidate.n_epochs} epochs · stack SNR {fmt(task.candidate.snr_stack, 1)} · {task.candidate.best_distance_au == null
                ? "best trial: not moving"
                : `trial ${fmt(task.candidate.best_distance_au, 0)} AU`}
              {click ? ` · marked (${click.x.toFixed(2)}, ${click.y.toFixed(2)})` : ""}
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Button size="lg" onClick={() => vote("real")} disabled={busy}>Real mover</Button>
              <Button size="lg" variant="outline" onClick={() => vote("artifact")} disabled={busy}>Artifact</Button>
              <Button size="lg" variant="outline" onClick={() => vote("nothing")} disabled={busy}>Nothing</Button>
            </div>
            <SourceTag source={task.candidate.source} />
            <p className="text-[10px] text-muted">About 1 in 10 cards is a secret test (an injected planet or an empty field). Tests tell you the answer and train your reliability score; live cards update the consensus.</p>
          </CardContent>
        </Card>
      ) : null}
      {result ? (
        <Card className={result.is_test ? (result.correct ? "border-sim" : "border-danger") : "border-accent"}>
          <CardContent className="flex flex-col gap-2 pt-4 text-sm">
            {result.is_test ? (
              <>
                <div className="text-lg font-bold">{result.correct ? "Correct" : "Not quite"} <span className="text-muted">— test card</span></div>
                <p>This was {result.reveal?.is_simulated ? <span className="text-sim">a SIMULATED injected planet</span> : <span>an empty / artifact field</span>}
                  {result.reveal?.injected_mag ? <> at V≈{result.reveal.injected_mag.toFixed(1)}, {result.reveal.injected_distance_au?.toFixed(0)} AU</> : null}.</p>
              </>
            ) : (
              <>
                <div className="text-lg font-bold">Vote recorded</div>
                <p>Consensus P(real) is now <span className="mono text-accent">{result.consensus ? result.consensus.p_real.toFixed(3) : "—"}</span> from {result.consensus?.n_votes} votes.</p>
              </>
            )}
            <dl className="grid grid-cols-2 gap-y-1 text-xs text-muted">
              <dt>points</dt><dd className="mono text-right text-fg">{result.points_awarded > 0 ? "+" : ""}{result.points_awarded} → {result.user.points}</dd>
              <dt>your reliability</dt><dd className="mono text-right text-fg">{pct(result.user.reliability, 0)} ({result.user.n_test} tests)</dd>
              <dt>sky ruled out</dt><dd className="mono text-right text-accent">{pct(result.map.frac_excluded_total, 4)}</dd>
              <dt>by Deep Field</dt><dd className="mono text-right text-sim">{pct(result.map.frac_excluded_deepfield, 5)}</dd>
            </dl>
            <Button size="lg" onClick={next}>Next card</Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
