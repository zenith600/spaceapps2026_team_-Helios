"use client";
import { useEffect, useRef, useState } from "react";
import {
  ArrowDown, ArrowUp, ChevronDown, ChevronRight, CircleDot, Eye, EyeOff, Flag, Folder, FolderOpen, Image as ImageIcon,
  Lock, LockOpen, Pipette, Radar, Ruler, SquareStack, Layers, Trash, LoaderCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { BLEND_MODES, type LayerKind, type ResolvedLayer, canMove } from "@/lib/workstation/layers";
import { useWS } from "../context";
import { Empty, IconBtn, Select, Slider } from "../ui";

const KIND_ICON: Record<LayerKind, typeof Eye> = {
  group: Folder, frames: ImageIcon, stack: SquareStack, static: Layers, flags: Flag, change: Radar,
  catalog: CircleDot, probe: Pipette, measure: Ruler,
};

export function LayersPanel() {
  const ws = useWS();
  const [renaming, setRenaming] = useState<string | null>(null);
  if (!ws.bundle || !ws.tree) return <Empty icon={Layers}>Open a field to see its layers.</Empty>;

  const sel = ws.layer(ws.selected) ?? ws.layer("frames");
  const editable = sel ? !sel.config.locked : false;
  const tree = ws.tree;

  return (
    <div className="flex h-full flex-col">
      {/* Blend + opacity for the selected layer, as at the top of Photoshop's Layers panel. */}
      <div className="flex flex-col gap-1 border-b border-ws-edge px-2 py-1.5">
        <div className="flex items-center gap-2">
          <Select label="Blend mode" className="flex-1" value={sel?.config.blend ?? "normal"}
            disabled={!sel?.node.canBlend || !editable}
            options={BLEND_MODES.map((b) => ({ value: b.id, label: b.label }))}
            onChange={(v) => sel && ws.setLayer(sel.node.id, { blend: v }, `Blend ${sel.name}: ${v}`)} />
          <span className="text-[10.5px] text-ws-dim" title={BLEND_MODES.find((b) => b.id === sel?.config.blend)?.note}>
            {sel?.node.canBlend ? "display blend" : "no blend"}
          </span>
        </div>
        <Slider label="Opacity" min={0} max={1} step={0.01} value={sel?.config.opacity ?? 1}
          disabled={!sel?.node.canOpacity || !editable} format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => sel && ws.setLayer(sel.node.id, { opacity: v }, `Opacity ${sel.name}`, `opacity-${sel.node.id}`)} />
      </div>

      <ul role="tree" aria-label="Layers" className="ws-scroll min-h-0 flex-1 overflow-y-auto py-0.5">
        {ws.layers.filter((l) => !l.folded).map((l) => (
          <LayerRow key={l.node.id} l={l} selected={ws.selected === l.node.id} renaming={renaming === l.node.id}
            onRename={(v) => { setRenaming(null); if (v !== null) ws.setLayer(l.node.id, { name: v || undefined }, `Rename to ${v || l.node.defaultName}`); }}
            onStartRename={() => !l.config.locked && setRenaming(l.node.id)} />
        ))}
      </ul>

      <div className="flex items-center gap-0.5 border-t border-ws-edge px-1.5 py-1">
        <IconBtn icon={ArrowUp} label="Move layer up" disabled={!sel || !canMove(tree, ws.doc.layers, sel.node.id, -1)}
          onClick={() => sel && ws.moveLayer(sel.node.id, -1)} />
        <IconBtn icon={ArrowDown} label="Move layer down" disabled={!sel || !canMove(tree, ws.doc.layers, sel.node.id, 1)}
          onClick={() => sel && ws.moveLayer(sel.node.id, 1)} />
        <IconBtn icon={sel?.config.locked ? Lock : LockOpen} label={sel?.config.locked ? "Unlock layer" : "Lock layer (prevents edits and moves)"}
          disabled={!sel} active={sel?.config.locked}
          onClick={() => sel && ws.setLayer(sel.node.id, { locked: !sel.config.locked }, `${sel.config.locked ? "Unlock" : "Lock"} ${sel.name}`)} />
        <span className="mx-1 min-w-0 flex-1 truncate text-[10.5px] text-ws-dim">
          {sel ? `${sel.node.typeLabel}` : ""}
        </span>
        <IconBtn icon={Trash} tone="danger"
          label={sel?.node.canClear ? `Clear ${sel.name} (a mark or a derived result; source data is never removed)` : "Source layers cannot be removed"}
          disabled={!sel?.node.canClear || !editable} onClick={() => sel && ws.clearLayer(sel.node.id)} />
      </div>
    </div>
  );
}

function LayerRow({ l, selected, renaming, onRename, onStartRename }: {
  l: ResolvedLayer; selected: boolean; renaming: boolean;
  onRename: (v: string | null) => void; onStartRename: () => void;
}) {
  const ws = useWS();
  const n = l.node;
  const committed = useRef(false);
  useEffect(() => { if (renaming) committed.current = false; }, [renaming]);
  const finish = (v: string | null) => {
    if (committed.current) return;
    committed.current = true;
    onRename(v !== null && v === l.name ? null : v);
  };
  const Icon = n.kind === "group" ? (l.config.collapsed ? Folder : FolderOpen) : KIND_ICON[n.kind];
  const dim = !l.shown;
  const badge = layerBadge(l, ws);

  return (
    <li role="treeitem" aria-selected={selected} aria-expanded={n.kind === "group" ? !l.config.collapsed : undefined}
      onClick={() => ws.select(n.id)}
      title={n.available ? n.source.note : n.unavailableReason}
      className={cn("group flex h-[26px] cursor-default items-center gap-1 border-b border-ws-edge/70 pr-1.5 text-[11.5px]",
        selected ? "bg-ws-selbg" : "hover:bg-ws-raised", n.kind === "group" && "bg-ws-bg/40")}>
      <button type="button" aria-label={l.config.visible ? `Hide ${l.name}` : `Show ${l.name}`} aria-pressed={l.config.visible}
        onClick={(e) => { e.stopPropagation(); ws.toggleLayer(n.id); }}
        className="flex h-full w-7 shrink-0 items-center justify-center border-r border-ws-edge/70 text-ws-muted hover:text-ws-fg">
        {l.config.visible ? <Eye size={13} /> : <EyeOff size={13} className="text-ws-dim" />}
      </button>
      <span style={{ width: l.depth * 12 }} className="shrink-0" />
      {n.kind === "group" ? (
        <button type="button" aria-label={l.config.collapsed ? "Expand group" : "Collapse group"}
          onClick={(e) => { e.stopPropagation(); ws.setLayer(n.id, { collapsed: !l.config.collapsed }, `${l.config.collapsed ? "Expand" : "Collapse"} ${l.name}`); }}
          className="flex w-3.5 shrink-0 items-center justify-center text-ws-dim hover:text-ws-fg">
          {l.config.collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
        </button>
      ) : <span className="w-3.5 shrink-0" />}
      <Icon size={13} strokeWidth={1.6} className={cn("shrink-0", dim ? "text-ws-dim" : n.kind === "catalog" ? "" : "text-ws-muted")}
        style={n.kind === "catalog" ? { color: ws.session.overlay?.layers.find((c) => `cat:${c.id}` === n.id)?.colour } : undefined} />
      {renaming ? (
        <input autoFocus defaultValue={l.name} aria-label="Layer name"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") finish((e.target as HTMLInputElement).value.trim());
            else if (e.key === "Escape") finish(null);
          }}
          onBlur={(e) => finish(e.target.value.trim())}
          className="h-[19px] min-w-0 flex-1 rounded-[2px] border border-ws-sel bg-ws-bg px-1 text-[11.5px] text-ws-fg outline-none" />
      ) : (
        <span onDoubleClick={(e) => { e.stopPropagation(); onStartRename(); }}
          className={cn("min-w-0 flex-1 truncate", dim ? "text-ws-dim" : "text-ws-fg", n.kind === "group" && "font-medium")}>
          {l.name}
        </span>
      )}
      {badge}
      {l.config.locked ? <Lock size={11} className="shrink-0 text-ws-dim" aria-label="locked" /> : null}
    </li>
  );
}

function layerBadge(l: ResolvedLayer, ws: ReturnType<typeof useWS>) {
  const n = l.node;
  const cls = "mono shrink-0 rounded-[2px] px-1 text-[9.5px]";
  if (!n.available) return <span className={cn(cls, "text-ws-dim")}>n/a</span>;
  if (n.kind === "change") {
    const c = ws.change;
    if (c.state === "running") return <LoaderCircle size={11} className="shrink-0 animate-spin text-ws-warn" />;
    if (c.state === "ready") return <span className={cn(cls, "bg-sim/15 text-sim")}>{c.report?.peaks.length ?? 0} peaks</span>;
    if (c.state === "error") return <span className={cn(cls, "text-ws-err")}>error</span>;
    return <span className={cn(cls, "text-ws-dim")}>not run</span>;
  }
  if (n.kind === "catalog") {
    const c = ws.session.overlay?.layers.find((x) => `cat:${x.id}` === n.id);
    return c ? <span className={cn(cls, "text-ws-muted")}>{c.n}</span> : null;
  }
  if (n.kind === "frames") return <span className={cn(cls, "text-ws-muted")}>{ws.loaded.count}/{ws.loaded.total}</span>;
  if (n.kind === "probe") return ws.doc.pixel ? <span className={cn(cls, "text-ws-muted")}>{ws.doc.pixel.x},{ws.doc.pixel.y}</span> : <span className={cn(cls, "text-ws-dim")}>empty</span>;
  if (n.kind === "measure") return ws.doc.ruler ? null : <span className={cn(cls, "text-ws-dim")}>empty</span>;
  return null;
}
