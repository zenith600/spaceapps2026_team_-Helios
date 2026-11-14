"use client";
// Small, dense controls for the workstation chrome. Native elements underneath, so
// keyboard and screen-reader behaviour come for free.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export function IconBtn({ icon: Icon, label, shortcut, active, disabled, onClick, className, size = 15, tone }: {
  icon: LucideIcon; label: string; shortcut?: string; active?: boolean; disabled?: boolean;
  onClick?: () => void; className?: string; size?: number; tone?: "danger";
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} aria-pressed={active}
      title={shortcut ? `${label}  (${shortcut})` : label}
      className={cn("inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[3px] text-ws-muted transition-colors",
        "hover:bg-ws-hover hover:text-ws-fg disabled:pointer-events-none disabled:opacity-30",
        active && "bg-ws-selbg text-ws-fg ring-1 ring-inset ring-ws-sel/60",
        tone === "danger" && "hover:text-ws-err", className)}>
      <Icon size={size} strokeWidth={1.75} />
    </button>
  );
}

export function TextBtn({ children, onClick, disabled, active, title, className, primary }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean; active?: boolean; title?: string;
  className?: string; primary?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title}
      className={cn("inline-flex h-6 items-center gap-1 rounded-[3px] border px-2 text-[11px] transition-colors disabled:opacity-35 disabled:pointer-events-none",
        primary ? "border-ws-sel/70 bg-ws-sel/90 text-white hover:bg-ws-sel"
          : active ? "border-ws-sel/60 bg-ws-selbg text-ws-fg"
          : "border-ws-line bg-ws-raised text-ws-fg hover:bg-ws-hover", className)}>
      {children}
    </button>
  );
}

/** A collapsible block inside a panel, Photoshop-properties style. */
export function Section({ title, children, right, defaultOpen = true }: {
  title: ReactNode; children: ReactNode; right?: ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-ws-edge">
      <div className="flex h-6 items-center gap-1 bg-ws-raised/60 px-1.5">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-[10.5px] font-semibold uppercase tracking-wider text-ws-muted hover:text-ws-fg">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span className="truncate">{title}</span>
        </button>
        {right}
      </div>
      {open ? <div className="px-2 py-1.5">{children}</div> : null}
    </section>
  );
}

export function KV({ k, v, mono = true, title }: { k: ReactNode; v: ReactNode; mono?: boolean; title?: string }) {
  return (
    <div className="flex min-h-[18px] items-baseline gap-2 py-px text-[11px]" title={title}>
      <span className="w-[42%] shrink-0 truncate text-ws-muted">{k}</span>
      <span className={cn("min-w-0 flex-1 break-words text-ws-fg", mono && "mono text-[10.5px]")}>{v}</span>
    </div>
  );
}

export function Slider({ label, value, min, max, step, onChange, format, disabled }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; format?: (v: number) => string; disabled?: boolean;
}) {
  return (
    <label className={cn("flex items-center gap-2 py-0.5 text-[11px]", disabled && "opacity-40")}>
      <span className="w-[34%] shrink-0 text-ws-muted">{label}</span>
      <input type="range" className="ws-range min-w-0 flex-1" min={min} max={max} step={step} value={value}
        disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
      <span className="mono w-11 shrink-0 text-right text-[10.5px] text-ws-fg">{format ? format(value) : value}</span>
    </label>
  );
}

export function Select<T extends string | number>({ value, options, onChange, label, disabled, className }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string;
  disabled?: boolean; className?: string;
}) {
  return (
    <select aria-label={label} title={label} value={String(value)} disabled={disabled}
      onChange={(e) => {
        const o = options.find((x) => String(x.value) === e.target.value);
        if (o) onChange(o.value);
      }}
      className={cn("h-6 rounded-[3px] border border-ws-line bg-ws-raised px-1.5 text-[11px] text-ws-fg outline-none focus:border-ws-sel disabled:opacity-40", className)}>
      {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
    </select>
  );
}

export function Check({ label, checked, onChange, disabled, title }: {
  label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; title?: string;
}) {
  return (
    <label title={title} className={cn("flex cursor-pointer items-center gap-1.5 py-0.5 text-[11px] text-ws-fg", disabled && "pointer-events-none opacity-40")}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)}
        className="h-3 w-3 accent-[var(--color-ws-sel)]" />
      {label}
    </label>
  );
}

export function Empty({ children, icon: Icon }: { children: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-6 text-center text-[11px] leading-relaxed text-ws-muted">
      {Icon ? <Icon size={20} strokeWidth={1.5} className="text-ws-dim" /> : null}
      <div>{children}</div>
    </div>
  );
}

export type TaskState = "loading" | "queued" | "processing" | "rendering" | "cached" | "completed" | "failed" | "cancelled";

export const STATE_STYLE: Record<TaskState, { label: string; dot: string; text: string }> = {
  loading: { label: "Loading", dot: "bg-ws-sel animate-pulse", text: "text-ws-sel" },
  queued: { label: "Queued", dot: "bg-ws-muted", text: "text-ws-muted" },
  processing: { label: "Processing", dot: "bg-ws-warn animate-pulse", text: "text-ws-warn" },
  rendering: { label: "Rendering", dot: "bg-ws-sel animate-pulse", text: "text-ws-sel" },
  cached: { label: "Cached", dot: "bg-teal-400", text: "text-teal-300" },
  completed: { label: "Completed", dot: "bg-ws-ok", text: "text-ws-ok" },
  failed: { label: "Failed", dot: "bg-ws-err", text: "text-ws-err" },
  cancelled: { label: "Cancelled", dot: "bg-ws-dim", text: "text-ws-dim" },
};

export function StateChip({ state, compact }: { state: TaskState; compact?: boolean }) {
  const s = STATE_STYLE[state];
  return (
    <span className={cn("inline-flex items-center gap-1 text-[10.5px]", s.text)}>
      <span className={cn("inline-block h-1.5 w-1.5 rounded-full", s.dot)} />
      {compact ? null : s.label}
    </span>
  );
}

/** A click-to-open menu that closes on outside click or Escape. */
export function Menu({ trigger, children, align = "left", width = 220 }: {
  trigger: (open: boolean) => ReactNode; children: (close: () => void) => ReactNode;
  align?: "left" | "right"; width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("pointerdown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen((o) => !o)}>{trigger(open)}</div>
      {open ? (
        <div role="menu" style={{ width }}
          className={cn("absolute top-full z-50 mt-1 overflow-hidden rounded-[4px] border border-ws-line bg-ws-panel py-1 shadow-xl shadow-black/50",
            align === "right" ? "right-0" : "left-0")}>
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({ children, onClick, checked, disabled, hint, title }: {
  children: ReactNode; onClick?: () => void; checked?: boolean; disabled?: boolean; hint?: string; title?: string;
}) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick} title={title}
      className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-[11.5px] text-ws-fg hover:bg-ws-selbg disabled:opacity-35 disabled:hover:bg-transparent">
      <span className="w-3 text-ws-sel">{checked ? "✓" : ""}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? <span className="mono text-[10px] text-ws-dim">{hint}</span> : null}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-ws-dim">{children}</div>;
}

export function MenuSep() {
  return <div className="my-1 border-t border-ws-line" />;
}
