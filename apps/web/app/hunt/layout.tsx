import type { Metadata } from "next";
import { planetXMeta } from "@/lib/meta";

// Also the parent of /hunt/proof, which sets its own title in hunt/proof/layout.tsx.
export const metadata: Metadata = planetXMeta(
  "The Hunt",
  "an overview of a shift-and-stack Planet Nine search pipeline, demonstrated on a synthetic sample bundle.",
);

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
