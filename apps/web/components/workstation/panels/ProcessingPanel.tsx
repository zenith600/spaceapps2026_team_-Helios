"use client";
import { useMemo, useState } from "react";
import { Cloud, Cpu, Database, Eye, LoaderCircle, RefreshCw, Workflow } from "lucide-react";
import { DEMO } from "@/lib/api";
import { cn } from "@/lib/utils";
import { type PipelineNode, buildPipeline, downstreamOf } from "@/lib/workstation/pipeline";
import { useWS } from "../context";
import { Empty, TextBtn } from "../ui";

const WHERE_ICON = { "IRSA": Database, "server · build": Cloud, "browser": Cpu, "server · on request": Cloud } as const;

const STATE: Record<PipelineNode["state"], { label: string; cls: string }> = {
  baked: { label: "baked", cls: "text-ws-muted" },
  ready: { label: "ready", cls: "text-ws-ok" },
  "not-run": { label: "not run", cls: "text-ws-dim" },
  running: { label: "running", cls: "text-ws-warn" },
  unavailable: { label: "unavailable", cls: "text-ws-err" },
  "on-demand": { label: "on demand", cls: "text-ws-sel" },
};

export function ProcessingPanel() {
  const ws = useWS();
  const b = ws.bundle;
  const [focus, setFocus] = useState<string | null>(null);
  const nodes = useMemo(() => (b ? buildPipeline(b, {
    demo: DEMO, change: { state: ws.change.state === "cancelled" ? "idle" : ws.change.state, params: ws.doc.change },
    aperture: ws.doc.radius, pixelPicked: Boolean(ws.doc.pixel),
  }) : []), [b, ws.change.state, ws.doc.change, ws.doc.radius, ws.doc.pixel]);
  const affected = useMemo(() => (focus ? new Set(downstreamOf(nodes, focus)) : new Set<string>()), [nodes, focus]);
  const upstream = useMemo(() => new Set(focus ? nodes.find((n) => n.id === focus)?.inputs ?? [] : []), [nodes, focus]);

  if (!b) return <Empty icon={Workflow}>Open a field to see how its images were made.</Empty>;

  return (
    <div>
      <div className="border-b border-ws-edge px-2 py-2 text-[11px]">
        <div className="flex items-center gap-2">
          <span className="text-ws-fg">Built {b.generated_at.slice(0, 16).replace("T", " ")} UTC</span>
          {b.elapsed_s !== undefined ? <span className="mono text-ws-muted">{b.elapsed_s}s</span> : null}
          {!DEMO ? (
            <TextBtn className="ml-auto" onClick={() => ws.session.build(true)} disabled={Boolean(ws.session.job && ws.session.job.state !== "done" && ws.session.job.state !== "error")}
              title="Re-run every server step for this field (fetch, reproject, coadd, render). Results replace this bundle.">
              {ws.session.job && ws.session.job.state === "running" ? <LoaderCircle size={11} className="animate-spin" /> : <RefreshCw size={11} />} Rebuild view
            </TextBtn>
          ) : null}
        </div>
        <p className="pt-1 text-[10.5px] leading-snug text-ws-dim">
          {DEMO
            ? "Server steps ran once when this view was baked; this deployment serves their output as files. Steps marked browser run here, on the pixel cube."
            : "Server steps ran when the view was built; Rebuild re-runs them. Analysis steps run on request."}
          {" "}Order is fixed by data dependencies. Click a step to see what it feeds.
        </p>
      </div>

      <ol className="relative py-1">
        {nodes.map((n, k) => {
          const Icon = WHERE_ICON[n.where];
          const isFocus = focus === n.id;
          const hot = affected.has(n.id), up = upstream.has(n.id);
          return (
            <li key={n.id} className="relative">
              {k < nodes.length - 1 ? <span className="absolute left-[15px] top-6 h-[calc(100%-12px)] w-px bg-ws-line" aria-hidden /> : null}
              <div role="button" tabIndex={0} onClick={() => setFocus(isFocus ? null : n.id)}
                onKeyDown={(e) => { if (e.key === "Enter") setFocus(isFocus ? null : n.id); }}
                className={cn("mx-1 flex cursor-pointer gap-2 rounded-[3px] px-1.5 py-1",
                  isFocus ? "bg-ws-selbg" : hot ? "bg-ws-warn/10" : up ? "bg-ws-sel/10" : "hover:bg-ws-raised")}>
                <span className={cn("relative z-10 mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border bg-ws-panel",
                  n.state === "unavailable" ? "border-ws-err/60" : n.where === "browser" ? "border-ws-sel/70" : "border-ws-line")}>
                  {n.state === "running" ? <LoaderCircle size={10} className="animate-spin text-ws-warn" /> : <Icon size={10} className="text-ws-muted" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="truncate text-[11.5px] text-ws-fg">{n.label}</span>
                    <span className={cn("mono text-[9.5px]", STATE[n.state].cls)}>{STATE[n.state].label}</span>
                    {n.editable ? <span className="rounded-[2px] bg-ws-sel/20 px-1 text-[9px] text-ws-sel">editable</span> : null}
                    <span className="ml-auto shrink-0 text-[9.5px] text-ws-dim">{n.where}</span>
                  </div>
                  <div className="text-[10.5px] text-ws-muted">→ {n.output}</div>
                  {isFocus ? (
                    <div className="mt-1 rounded-[2px] border border-ws-line/70 bg-ws-bg/60 px-1.5 py-1">
                      {n.params.map((p) => (
                        <div key={p.k} className="flex gap-2 text-[10.5px]">
                          <span className="w-[40%] shrink-0 text-ws-muted">{p.k}</span>
                          <span className="mono min-w-0 break-words text-ws-fg">{p.v}</span>
                        </div>
                      ))}
                      {n.inputs.length ? <div className="pt-0.5 text-[10px] text-ws-dim">inputs: {n.inputs.join(", ")}</div> : null}
                      <div className="pt-0.5 text-[10px] text-ws-dim">
                        {affected.size ? `feeds: ${Array.from(affected).join(", ")}` : "nothing downstream: changing it affects only itself"}
                      </div>
                      {n.note ? <p className="pt-0.5 text-[10px] leading-snug text-ws-dim">{n.note}</p> : null}
                      <div className="flex gap-1.5 pt-1">
                        {n.layer ? (
                          <TextBtn onClick={() => { ws.select(n.layer!); ws.openPanel("properties"); }}>
                            <Eye size={11} /> Inspect output
                          </TextBtn>
                        ) : null}
                        {n.id === "change" && n.state !== "unavailable" ? (
                          <TextBtn primary onClick={ws.runChange}>{n.state === "ready" ? "Run again" : "Run"}</TextBtn>
                        ) : null}
                        {n.id === "pair-difference" && n.state !== "unavailable" ? (
                          <TextBtn onClick={() => ws.openPanel("compare")}>Open Compare</TextBtn>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
