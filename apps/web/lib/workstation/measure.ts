// Angular measurements between two points on a view, through the same pixel -> sky mapping
// the spectrum uses (pixelToSky), so a measured separation agrees with the coordinates
// shown everywhere else.
import { type SkyBundle, pixelToSky } from "../sky";

const RAD = Math.PI / 180;

/** Great-circle separation (haversine) in arcseconds. */
export function separationArcsec(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const d1 = dec1 * RAD, d2 = dec2 * RAD, dra = (ra2 - ra1) * RAD;
  const h = Math.sin((d2 - d1) / 2) ** 2 + Math.cos(d1) * Math.cos(d2) * Math.sin(dra / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(h)))) / RAD * 3600;
}

/** Position angle of point 2 from point 1, degrees east of north, 0..360. */
export function positionAngle(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const d1 = dec1 * RAD, d2 = dec2 * RAD, dra = (ra2 - ra1) * RAD;
  const pa = Math.atan2(Math.sin(dra) * Math.cos(d2), Math.cos(d1) * Math.sin(d2) - Math.sin(d1) * Math.cos(d2) * Math.cos(dra)) / RAD;
  return (pa + 360) % 360;
}

export type Measurement = { pixels: number; arcsec: number; pa_deg: number; dx: number; dy: number };

export function measure(bundle: Pick<SkyBundle, "npix" | "pixel_arcsec" | "ra_deg" | "dec_deg">,
                        a: { x: number; y: number }, b: { x: number; y: number }): Measurement {
  const A = pixelToSky(bundle, a.x, a.y), B = pixelToSky(bundle, b.x, b.y);
  return {
    pixels: Math.hypot(b.x - a.x, b.y - a.y),
    arcsec: separationArcsec(A.ra_deg, A.dec_deg, B.ra_deg, B.dec_deg),
    pa_deg: positionAngle(A.ra_deg, A.dec_deg, B.ra_deg, B.dec_deg),
    dx: b.x - a.x, dy: b.y - a.y,
  };
}

export function formatArcsec(s: number): string {
  if (s < 60) return `${s.toFixed(1)}″`;
  const m = Math.floor(s / 60);
  return `${m}′ ${(s - 60 * m).toFixed(1)}″`;
}
