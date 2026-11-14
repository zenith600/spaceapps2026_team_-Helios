"use client";
import { cn } from "@/lib/utils";

export type UiMode = "simple" | "pro";

/**
 * Simple is the public front door; Pro is the analysis workstation. Both read and write the
 * same URL, so switching keeps the field, mode and field of view.
 */
export function UiModeToggle({ value, onPick, tone = "page", className }: {
  value: UiMode; onPick: (m: UiMode) => void; tone?: "page" | "workstation"; className?: string;
}) {
  const ws = tone === "workstation";
  return (
    <div role="radiogroup" aria-label="Interface"
      className={cn("inline-flex overflow-hidden rounded-md border text-[11px]",
        ws ? "h-6 rounded-[3px] border-ws-line" : "border-line", className)}>
      {(["simple", "pro"] as const).map((m) => {
        const on = value === m;
        return (
          <button key={m} type="button" role="radio" aria-checked={on} onClick={() => !on && onPick(m)}
            title={m === "simple" ? "The plain viewer: one page, plain words" : "The analysis workstation: layers, timeline, measurements, caches"}
            className={cn("px-2.5 py-0.5 transition-colors",
              on ? (ws ? "bg-ws-selbg text-ws-fg" : "bg-accent/15 text-accent")
                : (ws ? "text-ws-muted hover:text-ws-fg" : "text-muted hover:text-fg"))}>
            {m === "simple" ? "Simple" : "Pro"}
          </button>
        );
      })}
    </div>
  );
}
