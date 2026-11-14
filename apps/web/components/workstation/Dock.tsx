"use client";
// Photoshop-style panel dock: two tab groups stacked on the right. Panels can be
// collapsed, closed (Window menu brings them back) or docked in the other group.
import { useRef } from "react";
import { ArrowDownUp, ChevronDown, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { type Layout, type PanelId, PANELS, closePanel, movePanel } from "@/lib/workstation/workspaces";
import { useWS } from "./context";
import { CachePanel } from "./panels/CachePanel";
import { HistogramPanel } from "./panels/HistogramPanel";
import { ComparePanel, ContextPanel, HistoryPanel, MetadataPanel, NoPanels, TargetsPanel } from "./panels/info";
import { LayersPanel } from "./panels/LayersPanel";
import { ProcessingPanel } from "./panels/ProcessingPanel";
import { PropertiesPanel } from "./panels/PropertiesPanel";
import { SpectrumPanel } from "./panels/SpectrumPanel";
import { Splitter } from "./Workstation";
import { IconBtn } from "./ui";

const RENDER: Record<PanelId, () => React.ReactNode> = {
  layers: () => <LayersPanel />,
  properties: () => <PropertiesPanel />,
  metadata: () => <MetadataPanel />,
  histogram: () => <HistogramPanel />,
  spectrum: () => <SpectrumPanel />,
  processing: () => <ProcessingPanel />,
  cache: () => <CachePanel />,
  compare: () => <ComparePanel />,
  context: () => <ContextPanel />,
  history: () => <HistoryPanel />,
  targets: () => <TargetsPanel />,
};

const HEADER_H = 26;

export function Dock() {
  const ws = useWS();
  const l = ws.layout;
  const box = useRef<HTMLDivElement>(null);
  const hasTop = l.top.length > 0, hasBottom = l.bottom.length > 0;
  const bothOpen = hasTop && hasBottom && !l.topCollapsed && !l.bottomCollapsed;

  const topStyle: React.CSSProperties = !hasBottom || l.bottomCollapsed
    ? { flex: "1 1 0" }
    : l.topCollapsed ? { flex: `0 0 ${HEADER_H}px` } : { flex: `0 0 ${l.split * 100}%` };

  return (
    <div ref={box} className="flex h-full min-h-0 flex-col border-l border-ws-edge bg-ws-panel">
      {hasTop ? <Group pos="top" style={topStyle} /> : null}
      {bothOpen ? (
        <Splitter dir="row" onDrag={(d) => {
          const h = box.current?.clientHeight || 1;
          ws.setLayout((x) => ({ ...x, split: Math.max(0.12, Math.min(0.88, x.split + d / h)) }));
        }} />
      ) : hasTop && hasBottom ? <div className="h-px shrink-0 bg-ws-edge" /> : null}
      {hasBottom ? <Group pos="bottom" style={l.bottomCollapsed ? { flex: `0 0 ${HEADER_H}px` } : { flex: "1 1 0" }} /> : null}
      {!hasTop && !hasBottom ? <NoPanels /> : null}
    </div>
  );
}

function Group({ pos, style }: { pos: "top" | "bottom"; style: React.CSSProperties }) {
  const ws = useWS();
  const l = ws.layout;
  const tabs = pos === "top" ? l.top : l.bottom;
  const active = (pos === "top" ? l.topActive : l.bottomActive) ?? tabs[0];
  const collapsed = pos === "top" ? l.topCollapsed : l.bottomCollapsed;
  const set = (patch: Partial<Layout>) => ws.setLayout((x) => ({ ...x, ...patch }));
  const setActive = (id: PanelId) => set(pos === "top" ? { topActive: id, topCollapsed: false } : { bottomActive: id, bottomCollapsed: false });
  const toggle = () => set(pos === "top" ? { topCollapsed: !collapsed } : { bottomCollapsed: !collapsed });
  const title = (id: PanelId) => PANELS.find((p) => p.id === id);

  return (
    <section className="flex min-h-0 flex-col overflow-hidden" style={style} aria-label={`${pos} panel group`}>
      <div className="flex shrink-0 items-stretch border-b border-ws-edge bg-ws-bg" style={{ height: HEADER_H }}>
        <button type="button" onClick={toggle} aria-label={collapsed ? "Expand panel group" : "Collapse panel group"}
          className="flex w-5 shrink-0 items-center justify-center text-ws-dim hover:text-ws-fg">
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
        <div className="ws-noscrollbar flex min-w-0 flex-1 items-end overflow-x-auto" role="tablist"
          onWheel={(e) => { if (e.deltaY) e.currentTarget.scrollLeft += e.deltaY; }}>
          {tabs.map((id) => (
            <button key={id} type="button" role="tab" aria-selected={id === active}
              onClick={() => setActive(id)} onDoubleClick={toggle} title={title(id)?.hint}
              className={cn("h-[25px] shrink-0 whitespace-nowrap border-r border-ws-edge px-2 text-[11px]",
                id === active && !collapsed ? "bg-ws-panel text-ws-fg" : "text-ws-muted hover:bg-ws-raised hover:text-ws-fg")}>
              {title(id)?.title}
            </button>
          ))}
        </div>
        {active ? (
          <div className="flex shrink-0 items-center gap-0.5 px-1">
            <IconBtn icon={ArrowDownUp} size={12} label={`Dock “${title(active)?.title}” in the ${pos === "top" ? "lower" : "upper"} group`}
              onClick={() => ws.setLayout((x) => movePanel(x, active))} />
            <IconBtn icon={X} size={12} label={`Close “${title(active)?.title}” (reopen from Window)`}
              onClick={() => ws.setLayout((x) => closePanel(x, active))} />
          </div>
        ) : null}
      </div>
      {!collapsed && active ? (
        <div className={cn("ws-scroll min-h-0 flex-1 overflow-x-hidden", active === "layers" ? "overflow-hidden" : "overflow-y-auto")} role="tabpanel">
          {RENDER[active]()}
        </div>
      ) : null}
    </section>
  );
}
