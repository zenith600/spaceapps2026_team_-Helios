"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { DEMO } from "@/lib/api";

const items = [
  { href: "/", label: "The Hunt" },
  { href: "/lab", label: "Candidate Lab" },
  { href: "/classify", label: "Classify" },
  { href: "/proof", label: "Proof" },
];

export function Nav() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-base font-bold tracking-tight">Deep Field</span>
          <span className="hidden text-xs text-muted sm:inline">Planet X × SPHEREx</span>
        </Link>
        <nav className="flex gap-1 text-sm">
          {items.map((it) => (
            <Link key={it.href} href={it.href}
              className={cn("rounded-md px-3 py-1.5 text-muted hover:text-fg", path === it.href && "bg-panel text-fg")}>
              {it.label}
            </Link>
          ))}
        </nav>
        <span className="hidden text-[10px] text-muted mono md:inline">{DEMO ? "DEMO_MODE: frozen files" : "live API"}</span>
      </div>
    </header>
  );
}
