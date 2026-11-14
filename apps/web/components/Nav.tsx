"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { DEMO } from "@/lib/api";

/**
 * The Sky Viewer is the challenge tool and the front door. The Planet X search is a second,
 * experimental act that runs on a synthetic SAMPLE bundle, so it is grouped, labelled, and
 * every page in it carries a banner saying so.
 */
const EXPERIMENTAL = [
  { href: "/hunt", label: "The Hunt" },
  { href: "/lab", label: "Candidate Lab" },
  { href: "/classify", label: "Classify" },
  { href: "/hunt/proof", label: "Injection tests" },
];

/** The challenge tool and the evidence that it measures what it says it measures. */
const MAIN = [
  { href: "/sky", label: "Sky Viewer" },
  { href: "/proof", label: "Proof" },
];

export function Nav() {
  const path = usePathname();
  const experimental = EXPERIMENTAL.some((it) => path === it.href);
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur">
      {/* A wordmark plus the links does not fit on a 375px phone. Below `sm` the nav
          drops to its own full-width row and scrolls sideways instead of overflowing. */}
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 sm:py-3">
        <Link href="/sky" className="flex items-baseline gap-2">
          <span className="text-base font-bold tracking-tight">Deep Field</span>
          <span className="hidden text-xs text-muted sm:inline">SPHEREx</span>
        </Link>
        <nav className="-mx-1 order-last w-full overflow-x-auto px-1 sm:order-none sm:mx-0 sm:w-auto sm:flex-1 sm:px-0">
          <div className="flex items-center gap-1 text-sm sm:justify-center">
            {MAIN.map((it) => (
              <Link key={it.href} href={it.href}
                className={cn("whitespace-nowrap rounded-md px-2.5 py-1.5 font-medium sm:px-3",
                  path === it.href ? "bg-panel text-fg" : "text-muted hover:text-fg")}>
                {it.label}
              </Link>
            ))}
            <span className="mx-1 h-4 w-px shrink-0 bg-line" aria-hidden />
            <span className="whitespace-nowrap px-1 text-[10px] uppercase tracking-wider text-muted/70"
              title="A second project on synthetic sample data. Not part of the Sky Viewer.">
              Planet X · experimental
            </span>
            {EXPERIMENTAL.map((it) => (
              <Link key={it.href} href={it.href}
                className={cn("whitespace-nowrap rounded-md px-2 py-1.5 text-xs text-muted/80 hover:text-fg sm:px-2.5",
                  path === it.href && "bg-panel text-fg")}>
                {it.label}
              </Link>
            ))}
          </div>
        </nav>
        <span className="ml-auto hidden text-[10px] text-muted mono md:inline">
          {DEMO ? "ready-made views" : "live NASA access"}
        </span>
      </div>
      {experimental ? (
        <div className="border-t border-sim/30 bg-sim/10">
          <p className="mx-auto max-w-6xl px-4 py-1.5 text-[11px] text-sim">
            <strong>Experimental · simulated data.</strong> The Planet X search on these pages runs on a synthetic
            SAMPLE bundle to show how the pipeline would work; nothing here is a discovery. The challenge tool —
            real SPHEREx data — is the <Link href="/sky" className="underline underline-offset-2">Sky Viewer</Link>.
          </p>
        </div>
      ) : null}
    </header>
  );
}
