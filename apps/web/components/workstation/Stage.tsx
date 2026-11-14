"use client";
// The canvas region and every state it can be in: nothing open, loading, not built, no
// coverage, building, or showing a field. The wording matches the Simple view.
import { useState } from "react";
import { FolderOpen, LoaderCircle, RefreshCw, Telescope, TriangleAlert } from "lucide-react";
import { TargetGallery } from "@/components/TargetGallery";
import { DEMO } from "@/lib/api";
import { Canvas } from "./Canvas";
import { useWS } from "./context";
import { TextBtn } from "./ui";

const EXAMPLES = ["Barnard's Star", "08 55 10.831 -07 14 42.53", "133.795 -7.245"];

export function Stage() {
  const ws = useWS();
  const s = ws.session;
  const opened = Boolean(s.qParam || s.raParam);

  if (!opened) return <StartScreen />;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {s.fresh?.stale && ws.bundle ? (
        <Notice tone="info" icon={RefreshCw}
          action={<TextBtn primary onClick={() => s.build(true)}>Update it</TextBtn>}>
          NASA has released {s.fresh.new_exposures > 0 ? `${s.fresh.new_exposures} new images` : "new data"}
          {s.fresh.new_collections.length ? ` (${s.fresh.new_collections.join(", ")})` : ""} of this spot since this view was made.
        </Notice>
      ) : null}
      {s.error ? (
        <Notice tone="error" icon={TriangleAlert} action={<TextBtn onClick={() => s.setError(null)}>Dismiss</TextBtn>}>
          {s.error}
        </Notice>
      ) : null}

      {ws.bundle ? (
        <>
          <Canvas />
          {s.busy ? (
            <div className="pointer-events-none absolute right-3 top-14 flex items-center gap-2 rounded-[3px] bg-black/75 px-2 py-1 text-[11px] text-ws-fg">
              <LoaderCircle size={12} className="animate-spin text-ws-sel" /> {s.status ?? "Loading…"}
            </div>
          ) : null}
        </>
      ) : (
        <div className="ws-scroll flex min-h-0 flex-1 items-center justify-center overflow-auto bg-ws-canvas p-6">
          <EmptyState />
        </div>
      )}
    </div>
  );
}

function Notice({ tone, icon: Icon, children, action }: {
  tone: "info" | "error"; icon: typeof RefreshCw; children: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <div className={tone === "error"
      ? "flex items-center gap-2 border-b border-ws-err/40 bg-ws-err/10 px-3 py-1.5 text-[11.5px] text-ws-err"
      : "flex items-center gap-2 border-b border-accent/40 bg-accent/10 px-3 py-1.5 text-[11.5px] text-accent"}>
      <Icon size={13} className="shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

function Dialog({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="w-full max-w-md rounded-[4px] border border-ws-line bg-ws-panel shadow-2xl shadow-black/50">
      <div className="border-b border-ws-line px-3 py-2 text-[12px] font-semibold">{title}</div>
      <div className="flex flex-col gap-2 px-3 py-3 text-[12px] text-ws-fg">{children}</div>
    </div>
  );
}

function EmptyState() {
  const ws = useWS();
  const s = ws.session;
  if (s.busy) {
    return (
      <div className="flex flex-col items-center gap-3 text-ws-muted">
        <LoaderCircle size={22} className="animate-spin text-ws-sel" />
        <span className="text-[12px]">{s.status ?? "Loading…"}</span>
      </div>
    );
  }
  if (s.status === "not-prebuilt") {
    return (
      <Dialog title="This view hasn’t been prepared yet">
        <p className="text-ws-muted">
          This copy of the app serves ready-made views only. The built-in targets work right away; fetching a
          brand-new position from NASA needs the live service running.
        </p>
        <div><TextBtn onClick={s.clear}>Back to the targets</TextBtn></div>
      </Dialog>
    );
  }
  if (s.status === "no-coverage") {
    return (
      <Dialog title="SPHEREx hasn’t photographed this spot yet">
        <p className="text-ws-muted">
          It maps the whole sky every six months, so this position should appear in a future release. Try a wider
          view, or pick a different target.
        </p>
        <div><TextBtn onClick={s.clear}>Back to the targets</TextBtn></div>
      </Dialog>
    );
  }
  if (s.status === "not-built" || s.job) {
    const j = s.job;
    if (j && j.state !== "done") {
      return (
        <Dialog title="Fetching images from NASA…">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-ws-raised">
            <div className="h-full bg-ws-sel transition-all" style={{ width: `${Math.max(4, Math.round(100 * j.progress))}%` }} />
          </div>
          <p className="text-[11px] text-ws-muted">
            {j.n_total ? `${j.n_done} of ${j.n_total} images` : "starting up"} · {j.state} · this usually takes a minute
            or two, and is instant next time. The rest of the workstation stays usable meanwhile.
          </p>
        </Dialog>
      );
    }
    const e = s.epochs;
    return (
      <Dialog title="Ready to build this view">
        {e && e.n_exposures > 0 ? (
          <p className="text-[11px] text-ws-muted">
            NASA has <span className="mono text-ws-fg">{e.n_exposures}</span> images of this spot, taken on{" "}
            <span className="mono text-ws-fg">{e.n_visits}</span> separate visits spanning{" "}
            <span className="mono text-ws-fg">{((e.baseline_days ?? 0) / 365.25).toFixed(1)}</span> years.
            {e.estimate ? ` We'll download ${e.estimate.n_frames} of them (~${e.estimate.download_mb} MB, about ${e.estimate.seconds} seconds).` : ""}
          </p>
        ) : null}
        <div><TextBtn primary onClick={() => s.build()}>Build it</TextBtn></div>
      </Dialog>
    );
  }
  return (
    <Dialog title="Nothing to show">
      <p className="text-ws-muted">No view could be loaded for this position.</p>
      <div><TextBtn onClick={s.clear}>Back to the targets</TextBtn></div>
    </Dialog>
  );
}

function StartScreen() {
  const ws = useWS();
  const s = ws.session;
  const [q, setQ] = useState(s.query);
  return (
    <div className="ws-scroll min-h-0 flex-1 overflow-auto bg-ws-canvas">
      <div className="mx-auto flex max-w-4xl flex-col gap-5 px-6 py-10">
        <div className="flex items-center gap-3">
          <Telescope size={28} strokeWidth={1.4} className="text-accent" />
          <div>
            <h1 className="text-[18px] font-semibold tracking-tight">Open a field</h1>
            <p className="text-[12px] text-ws-muted">
              Every SPHEREx visit to a patch of sky, as a time series you can blink, measure, subtract and take spectra from.
            </p>
          </div>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) s.show(q.trim()); }} className="flex gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus
            aria-label="Object name or sky coordinates" placeholder="A name like Barnard's Star, or RA Dec"
            className="h-8 min-w-0 flex-1 rounded-[3px] border border-ws-line bg-ws-panel px-3 text-[13px] outline-none placeholder:text-ws-dim focus:border-ws-sel" />
          <button type="submit" className="flex h-8 items-center gap-1.5 rounded-[3px] bg-ws-sel px-3 text-[12px] font-medium text-white hover:bg-ws-sel/85">
            <FolderOpen size={14} /> Open
          </button>
        </form>
        <div className="-mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-ws-muted">
          <span>Try:</span>
          {EXAMPLES.map((ex) => (
            <button key={ex} onClick={() => s.show(ex)}
              className="mono rounded-[3px] border border-ws-line px-1.5 py-0.5 hover:border-ws-sel hover:text-ws-fg">{ex}</button>
          ))}
        </div>
        {s.error ? <p className="rounded-[3px] border border-ws-err/40 bg-ws-err/10 px-3 py-2 text-[11.5px] text-ws-err">{s.error}</p> : null}
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ws-muted">Ready-made fields</h2>
            <span className="text-[10.5px] text-ws-dim">
              {DEMO ? "Built from real NASA images; they open instantly." : "Any other position is built live from IRSA."}
            </span>
          </div>
          <TargetGallery targets={s.index} onPick={(t) => s.show(t.name)} />
        </div>
      </div>
    </div>
  );
}
