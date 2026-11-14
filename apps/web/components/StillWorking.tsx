"use client";
/**
 * "This isn't stuck" reassurance for slow steps: an elapsed-time counter plus a plain sentence
 * about how long the step normally takes. After `slowAfter` seconds it says so, rather than
 * pretending everything is normal. Shared by the Simple view and the Pro workstation.
 *
 * The promise "if anything goes wrong we'll say so" is backed by useSkySession: a failed or
 * lost build, and a server that stops answering, end in a visible error, never a silent spin.
 */
import { useEffect, useState } from "react";

/** Seconds since this component mounted (or since `resetKey` last changed), ticking once a second. */
export function useElapsed(resetKey?: unknown): number {
  const [start, setStart] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = Date.now(); setStart(t); setNow(t); }, [resetKey]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return Math.max(0, Math.floor((now - start) / 1000));
}

export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export type SlowStep = { task: string; typical: string; slowAfter: number };

/** What a status line means in time, so the reassurance can be specific. */
export function slowStepFor(status: string | null | undefined): SlowStep {
  if (status?.startsWith("Asking NASA"))
    return { task: "asking NASA's archive what it has at a new position", typical: "up to a minute", slowAfter: 120 };
  return { task: "loading this view", typical: "a few seconds", slowAfter: 30 };
}

export const BUILD_STEP: SlowStep = {
  task: "downloading and lining up NASA's images", typical: "a few minutes", slowAfter: 600,
};

export function StillWorking({ seconds, step, className = "text-xs text-muted", quietFor = 4 }: {
  seconds: number; step: SlowStep; className?: string; quietFor?: number;
}) {
  if (seconds < quietFor) return null;
  const slow = seconds >= step.slowAfter;
  return (
    <p className={className} role="status" aria-live="polite">
      <span className="mono">{mmss(seconds)}</span>{" · "}
      {slow ? (
        <>This is taking longer than usual. NASA&apos;s archive is sometimes slow; it&apos;s still trying, and if it
          fails you&apos;ll see an error here rather than a spinner.</>
      ) : (
        <>Still working, not stuck: {step.task} usually takes {step.typical}. If anything goes wrong, we&apos;ll tell
          you here.</>
      )}
    </p>
  );
}
