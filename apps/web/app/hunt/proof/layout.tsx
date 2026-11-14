import type { Metadata } from "next";
import { planetXMeta } from "@/lib/meta";

export const metadata: Metadata = planetXMeta(
  "Injection tests",
  "how many synthetic Planet Nines injected into SPHEREx frames the experimental search recovers, by brightness and distance.",
);

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
