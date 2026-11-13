import { Badge } from "@/components/ui/badge";

/** Every number and image shows where it came from. */
export function SourceTag({ source, className = "" }: { source?: string | null; className?: string }) {
  if (!source) return null;
  return <span className={"text-[10px] text-muted mono " + className} title="Data source">src: {source}</span>;
}

/** Anything injected or synthetic is visibly tagged. */
export function SimTag({ show = true, text = "Simulated" }: { show?: boolean; text?: string }) {
  return show ? <Badge variant="sim">{text}</Badge> : null;
}

export function BundleTag({ kind }: { kind?: string }) {
  if (!kind) return null;
  const sample = kind === "SAMPLE";
  return <Badge variant={sample ? "danger" : "accent"}>{sample ? "SAMPLE DATA (not NASA)" : `bundle: ${kind}`}</Badge>;
}
