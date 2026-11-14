"use client";
// Makes a 1-2 pixel shift impossible to miss: the measured position at every visit, the
// straight line fitted through them, a ring fixed where the source started, and a ring that
// rides the fit to the current frame's date. The old blink-comparator trick -- a fixed
// reference mark -- plus the measurement itself.
import Link from "next/link";
import { type Motion, motionAt } from "@/lib/sky";

export function MotionTrack({ motion, npix, mjd, z, opacity = 1 }: {
  motion: Motion; npix: number; mjd?: number; z?: number; opacity?: number;
}) {
  const visits = motion.visits ?? [];
  if (!motion.available || !visits.length) return null;
  const sx = (x: number) => x + 0.5;
  const sy = (y: number) => npix - y - 0.5;
  const first = Math.min(...visits.map((v) => v.mjd));
  const last = Math.max(...visits.map((v) => v.mjd));
  const a = motionAt(motion, first)!, b = motionAt(motion, last)!;
  const now = mjd !== undefined ? motionAt(motion, Math.min(Math.max(mjd, first), last)) : null;
  // Rings are ~1.4 PSF FWHM across, so the star sits inside and its drift out is visible.
  const r = 1.3;
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${npix} ${npix}`}
      preserveAspectRatio="none" style={{ zIndex: z, opacity }} aria-label="Measured motion track">
      <defs>
        <marker id="mt-arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill="#fbbf24" />
        </marker>
      </defs>
      {/* start: where it was at the first measured visit */}
      <circle cx={sx(a.x)} cy={sy(a.y)} r={r} fill="none" stroke="#fbbf24" strokeWidth={1.2}
        strokeDasharray="3 2" vectorEffect="non-scaling-stroke" opacity={0.9} />
      {/* the fitted straight line */}
      <line x1={sx(a.x)} y1={sy(a.y)} x2={sx(b.x)} y2={sy(b.y)} stroke="#fbbf24" strokeWidth={1.5}
        vectorEffect="non-scaling-stroke" markerEnd="url(#mt-arrow)" />
      {/* each visit's measured position, with its 1-sigma error */}
      {visits.map((v) => (
        <g key={v.visit}>
          <line x1={sx(v.x - v.ex)} x2={sx(v.x + v.ex)} y1={sy(v.y)} y2={sy(v.y)} stroke="#67e8f9" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <line x1={sx(v.x)} x2={sx(v.x)} y1={sy(v.y - v.ey)} y2={sy(v.y + v.ey)} stroke="#67e8f9" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <circle cx={sx(v.x)} cy={sy(v.y)} r={0.14} fill="#67e8f9" />
        </g>
      ))}
      {/* where the fit puts it on this frame's date */}
      {now ? (
        <circle cx={sx(now.x)} cy={sy(now.y)} r={r} fill="none" stroke="#67e8f9" strokeWidth={1.6}
          vectorEffect="non-scaling-stroke" />
      ) : null}
    </svg>
  );
}

/** Plain-language readout of a measurement, with the Gaia comparison when there is one. */
export function MotionSummary({ motion, compact }: { motion: Motion; compact?: boolean }) {
  if (!motion.available || !motion.pm) {
    return (
      <p className="text-xs text-muted">
        No motion measured here: {motion.reason ?? "the source is not detected well enough in enough visits"}.
        {motion.target?.epoch_note ? <> {motion.target.epoch_note}</> : null}
      </p>
    );
  }
  const p = motion.pm, c = motion.comparison;
  const still = p.total_arcsec_yr < 2 * p.err_total;
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <p>
        <span className="text-muted">Measured from {motion.visits?.length} visits over {Math.round(motion.baseline_days ?? 0)} days: </span>
        {still ? (
          <span className="font-semibold text-fg">no detectable motion</span>
        ) : (
          <span className="font-semibold text-accent">
            {p.total_arcsec_yr.toFixed(2)} ± {p.err_total.toFixed(2)} arcsec/yr
          </span>
        )}
        {!still ? <span className="text-muted"> toward {compass(p.pa_deg)} (PA {p.pa_deg.toFixed(0)}°) — {motion.shift_px?.toFixed(1)} pixels so far</span> : null}
      </p>
      {c ? (
        <p className={c.agrees ? "text-sim" : "text-accent"}>
          Gaia DR3 says {c.total_arcsec_yr.toFixed(2)} arcsec/yr toward PA {c.pa_deg.toFixed(0)}°{" "}
          — {c.agrees ? "agrees" : "differs"} within {c.n_sigma.toFixed(1)}σ.
        </p>
      ) : (
        <p className="text-muted">No Gaia DR3 source matches here to compare with.</p>
      )}
      {!compact ? (
        <p className="text-[10px] text-muted">
          Dashed ring: where it started. Cyan dots: its measured position at each visit. Line: the straight-line fit.
          Solid ring: where the fit puts it on the frame you are looking at. {motion.caveat}
        </p>
      ) : null}
      {!compact ? <HowMotionIsMeasured motion={motion} /> : null}
    </div>
  );
}

/** Plain-language version of pipeline/deepfield/sky/motion.py; the full maths is on /proof. */
function HowMotionIsMeasured({ motion }: { motion: Motion }) {
  const pix = motion.pixel_arcsec;
  const n = motion.visits?.length ?? 0;
  return (
    <details className="group rounded-md border border-line bg-bg/40 px-3 py-2 text-[11px] text-muted">
      <summary className="cursor-pointer select-none text-fg">How is this motion measured?</summary>
      <ol className="mt-2 list-decimal space-y-1.5 pl-4">
        <li>
          <span className="text-fg">Find the star at each visit.</span> SPHEREx comes back to this patch every few
          months. For each visit we combine its pictures, weighting the cleaner ones more, and skip pixels NASA
          flags as saturated or bad.
        </li>
        <li>
          <span className="text-fg">Pin down its position to a fraction of a pixel.</span> A star&apos;s light spreads
          over a few pixels, so instead of picking the brightest pixel we fit the shape of that spread and take its
          centre. That is how a {pix}″ pixel can still give each visit&apos;s position to within a tenth of a pixel. Visits where
          the star is too faint or saturated are left out ({n} were usable here).
        </li>
        <li>
          <span className="text-fg">Draw the best straight line through time.</span> The positions are plotted
          against date, separately east–west and north–south. The slope of each line is the motion; how far the
          points scatter around the line sets the ± error. If they scatter more than expected, the error grows.
        </li>
        <li>
          <span className="text-fg">Turn it into a speed and a direction on the sky.</span> Pixels per year times
          {" "}{pix}″ per pixel gives arcseconds per year; the two slopes together give the direction.
        </li>
        <li>
          <span className="text-fg">Check it against Gaia.</span> ESA&apos;s Gaia satellite has measured this star&apos;s
          motion far more precisely. We look Gaia up only <em>after</em> measuring, and report how many of our own
          error bars apart the two answers are.
        </li>
      </ol>
      <p className="mt-2">
        The track on the image is that fit: the dashed ring is the first visit, the cyan dots are where we found the
        star each visit, and the solid ring slides along the fitted line to the date of the frame you are watching.
        Full maths, tests and results for every target: <Link href="/proof" className="text-accent underline underline-offset-2">Proof</Link>.
      </p>
    </details>
  );
}

function compass(pa: number): string {
  const names = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  return names[Math.round(((pa % 360) + 360) % 360 / 45) % 8];
}
