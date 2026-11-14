"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { DEMO } from "@/lib/api";

// Sky Viewer first after home: it is the thing a first-time visitor can actually use.
const items = [
  { href: "/sky", label: "Sky Viewer" },
  { href: "/", label: "The Hunt" },
  { href: "/lab", label: "Candidate Lab" },
  { href: "/classify", label: "Classify" },
  { href: "/proof", label: "Proof" },
];

export function Nav() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur">
      {/* A wordmark plus five links does not fit on a 375px phone. Below `sm` the nav
          drops to its own full-width row and scrolls sideways instead of overflowing. */}
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 sm:py-3">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-base font-bold tracking-tight">Deep Field</span>
          <span className="hidden text-xs text-muted sm:inline">SPHEREx</span>
        </Link>
        <nav className="-mx-1 order-last w-full overflow-x-auto px-1 sm:order-none sm:mx-0 sm:w-auto sm:flex-1 sm:px-0">
          <div className="flex gap-1 text-sm sm:justify-center">
            {items.map((it) => (
              <Link key={it.href} href={it.href}
                className={cn("whitespace-nowrap rounded-md px-2.5 py-1.5 text-muted hover:text-fg sm:px-3",
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
    </header>
  );
}
