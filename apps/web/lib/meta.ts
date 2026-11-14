import type { Metadata } from "next";

/**
 * Title + description, mirrored into Open Graph and Twitter cards.
 *
 * Next.js replaces (does not deep-merge) a parent's `openGraph` / `twitter` objects when a
 * child segment sets them, so every page that changes its title must set all three together
 * or a shared link would show the parent's card.
 */
export function pageMeta(title: string, description: string): Metadata {
  return {
    title,
    description,
    openGraph: { title, description, type: "website", siteName: "Deep Field" },
    twitter: { card: "summary", title, description },
  };
}

export const SITE_TITLE = "Deep Field — Watch the sky change with SPHEREx";
export const SITE_DESCRIPTION =
  "Type any position on the sky and watch every SPHEREx visit as a film, with motion measured and checked against Gaia DR3. NASA Space Apps 2026.";

/** Planet X pages: a separate, experimental project on simulated data. Their titles say so. */
export function planetXMeta(page: string, what: string): Metadata {
  return pageMeta(
    `${page} — Planet X (experimental, simulated data) · Deep Field`,
    `Experimental, simulated data: ${what} Nothing on this page is a discovery.`,
  );
}
