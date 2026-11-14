import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { pageMeta, SITE_DESCRIPTION, SITE_TITLE } from "@/lib/meta";

/** Site-wide default. Planet X routes override it in their own layout.tsx. */
export const metadata: Metadata = pageMeta(SITE_TITLE, SITE_DESCRIPTION);

export const viewport: Viewport = { themeColor: "#07080c", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Nav />
        <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
        <footer className="mx-auto max-w-6xl px-4 py-8 text-[11px] text-muted">
          Deep Field · NASA Space Apps 2026 · Every number shows its source; anything injected is labelled Simulated. No candidate here is a discovery.
        </footer>
      </body>
    </html>
  );
}
