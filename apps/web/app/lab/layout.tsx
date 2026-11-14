import type { Metadata } from "next";
import { planetXMeta } from "@/lib/meta";

export const metadata: Metadata = planetXMeta(
  "Candidate Lab",
  "inspect injected test candidates from the experimental Planet X search and run its classifier on them.",
);

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
