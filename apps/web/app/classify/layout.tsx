import type { Metadata } from "next";
import { planetXMeta } from "@/lib/meta";

export const metadata: Metadata = planetXMeta(
  "Classify",
  "vote on candidate cards from the experimental Planet X search; about one card in ten is a hidden test.",
);

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
