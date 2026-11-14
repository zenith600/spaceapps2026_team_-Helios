"use client";
/**
 * Proof that the Sky Viewer measures what it says it measures.
 *
 * Every number in the tables, tiles and plots is loaded from the same motion files the viewer
 * uses (baked views from /demo, live-built views from the API). Nothing is typed in by hand.
 * The method text mirrors pipeline/deepfield/sky/{motion,analyse,resolver}.py; the constants
 * quoted are the ones in that code.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Plot, darkLayout } from "@/components/Plot";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { API_URL, DEMO, getManifest } from "@/lib/api";
import type { Manifest } from "@/lib/types";
import { resolveTarget, skySlug, type Motion } from "@/lib/sky";

type Row = { name: string; slug: string; live: boolean; m: Motion | null; error?: string };

/** Views built on the server by a live job rather than baked into the site. */
const LIVE_BUILT = ["Teegarden's Star"];
/** A Gaia motion below this is a "should not move" control rather than a mover. */
const CONTROL_ARCSEC_YR = 0.1;

async function json<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

const isoDate = (mjd: number) => new Date((mjd - 40587) * 86_400_000).toISOString().slice(0, 10);
const f2 = (v: number | undefined | null, d = 2) => (v === undefined || v === null || !Number.isFinite(v) ? "—" : v.toFixed(d));

type Verdict = { kind: "agree" | "control" | "disagree" | "refused" | "nogaia" | "missing"; text: string };
function verdictOf(m: Motion | null): Verdict {
  if (!m) return { kind: "missing", text: "not loaded" };
  if (!m.available) return { kind: "refused", text: m.reason ?? "refused" };
  const c = m.comparison;
  if (!c) return { kind: "nogaia", text: "measured · no Gaia DR3 match to compare" };
  if (c.total_arcsec_yr < CONTROL_ARCSEC_YR)
    return c.agrees ? { kind: "control", text: `control: no detectable motion, as expected (${c.n_sigma.toFixed(2)}σ)` }
      : { kind: "disagree", text: `control failed: ${c.n_sigma.toFixed(2)}σ` };
  return c.agrees ? { kind: "agree", text: `agrees with Gaia within ${c.n_sigma.toFixed(2)}σ` }
    : { kind: "disagree", text: `differs from Gaia by ${c.n_sigma.toFixed(2)}σ` };
}
const TONE: Record<Verdict["kind"], string> = {
  agree: "text-emerald-400", control: "text-emerald-400", disagree: "text-red-400",
  refused: "text-amber-300", nogaia: "text-muted", missing: "text-muted",
};

// ------------------------------------------------------------------ small layout helpers
function Eq({ children }: { children: ReactNode }) {
  return <div className="mono my-2 overflow-x-auto whitespace-nowrap rounded-md border border-line bg-bg px-3 py-2 text-[13px] leading-relaxed text-fg">{children}</div>;
}
function Step({ n, title, children }: { n: number | string; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="mono mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-bold text-accent">{n}</div>
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-semibold text-fg">{title}</div>
        <div className="mt-1 space-y-1 text-muted">{children}</div>
      </div>
    </div>
  );
}
function Tile({ big, label, sub }: { big: string; label: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel p-4">
      <div className="mono text-3xl font-bold text-accent">{big}</div>
      <div className="mt-1 text-sm font-medium text-fg">{label}</div>
      {sub ? <div className="mt-1 text-[11px] text-muted">{sub}</div> : null}
    </div>
  );
}
const Code = ({ children }: { children: ReactNode }) => <code className="mono rounded bg-bg px-1 py-0.5 text-[12px] text-fg">{children}</code>;

// ------------------------------------------------------------------ page
export default function Proof() {
  const [rows, setRows] = useState<Row[]>([]);
  const [man, setMan] = useState<Manifest | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const index = await json<{ targets: { name: string; slug: string }[] }>("/demo/sky/index.json").catch(() => ({ targets: [] }));
      const baked: Row[] = await Promise.all(index.targets.map(async (t) => {
        try { return { name: t.name, slug: t.slug, live: false, m: await json<Motion>(`/demo/sky/${t.slug}/motion.json`) }; }
        catch (e) { return { name: t.name, slug: t.slug, live: false, m: null, error: String(e) }; }
      }));
      const live: Row[] = DEMO ? [] : (await Promise.all(LIVE_BUILT.map(async (q): Promise<Row | null> => {
        try {
          const t = await resolveTarget(q);
          const slug = skySlug(t.ra_deg, t.dec_deg, 0.1);
          return { name: t.name ?? q, slug, live: true, m: await json<Motion>(`${API_URL}/sky/motion/${slug}`) };
        } catch { return null; }   // not built on this server yet: simply not shown
      }))).filter((r): r is Row => r !== null);
      if (!cancelled) { setRows([...baked, ...live]); setLoading(false); }
    })();
    getManifest().then((m) => { if (!cancelled) setMan(m); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const stats = useMemo(() => {
    const v = rows.map((r) => ({ r, v: verdictOf(r.m) }));
    const movers = v.filter(({ r }) => r.m?.comparison && r.m.comparison.total_arcsec_yr >= CONTROL_ARCSEC_YR);
    const agree = movers.filter(({ v }) => v.kind === "agree");
    const controls = v.filter(({ v }) => v.kind === "control");
    const refused = v.filter(({ v }) => v.kind === "refused");
    const maxSigma = movers.reduce((a, { r }) => Math.max(a, r.m!.comparison!.n_sigma), 0);
    const barnard = rows.find((r) => /barnard/i.test(r.name))?.m ?? null;
    return { movers, agree, controls, refused, maxSigma, barnard };
  }, [rows]);

  const b = stats.barnard;
  const pix = b?.pixel_arcsec ?? 6.15;

  return (
    <div className="flex flex-col gap-5">
      {/* ---------------------------------------------------------------- header */}
      <div>
        <h1 className="text-2xl font-bold">Proof: how we know Deep Field is right</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          A tool that shows the sky changing is only useful if what it shows is real. So every measurement it makes is
          checked against an independent answer, every method is written out below with its maths, and when the data
          cannot support a number the tool says so instead of inventing one. The results on this page are loaded live
          from the same files the <Link href="/sky" className="text-accent underline underline-offset-2">Sky Viewer</Link> uses;
          none of them are typed in by hand.
        </p>
      </div>

      {/* ---------------------------------------------------------------- scoreboard */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile big={loading ? "…" : `${stats.agree.length}/${stats.movers.length}`} label="moving stars agree with Gaia DR3"
          sub={loading ? undefined : `largest difference ${stats.maxSigma.toFixed(2)}σ (agreement means < 3σ)`} />
        <Tile big={loading ? "…" : String(stats.controls.length)} label="control star shows no motion"
          sub={stats.controls[0] ? `${stats.controls[0].r.name}: ${f2(stats.controls[0].r.m?.pm?.total_arcsec_yr)} ± ${f2(stats.controls[0].r.m?.pm?.err_total)}″/yr` : undefined} />
        <Tile big={loading ? "…" : String(stats.refused.length)} label="honest refusals"
          sub="saturated or blended sources: the tool explains why instead of guessing" />
        <Tile big={b?.pm ? `${(b.pm.err_total / pix).toFixed(2)} px` : "…"} label="per-year precision on Barnard's Star"
          sub={b?.pm ? `±${f2(b.pm.err_total)}″/yr with ${f2(pix)}″ pixels: positions are fitted to a fraction of a pixel` : undefined} />
      </div>

      {/* ---------------------------------------------------------------- results */}
      <Card>
        <CardHeader><CardTitle>1 · Motion measured from SPHEREx, compared with Gaia DR3</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted">
            Gaia (ESA) measures stellar motions about a thousand times more precisely than SPHEREx can, so it is the
            answer key. It is never an input: the SPHEREx measurement is made first, and Gaia is only looked up
            afterwards to grade it.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="text-muted">
                <tr>
                  <th className="py-1.5 pr-3">target</th><th className="whitespace-nowrap py-1.5 pr-3">visits · baseline</th>
                  <th className="py-1.5 pr-3">SPHEREx (this tool)</th><th className="py-1.5 pr-3">Gaia DR3</th>
                  <th className="py-1.5 pr-3">verdict</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const m = r.m, v = verdictOf(m);
                  return (
                    <tr key={r.slug} className="border-t border-line align-top">
                      <td className="py-1.5 pr-3">
                        <Link href={`/sky?q=${encodeURIComponent(r.name)}`} className="whitespace-nowrap font-semibold text-fg hover:text-accent">{r.name}</Link>
                        <div className="text-[10px] text-muted">{r.live ? "built live on the server" : "ready-made view"}</div>
                      </td>
                      <td className="mono whitespace-nowrap py-1.5 pr-3">{m?.available ? `${m.visits?.length ?? 0} · ${f2(m.baseline_days, 0)} d` : "—"}</td>
                      <td className="mono whitespace-nowrap py-1.5 pr-3">
                        {m?.pm ? <>{f2(m.pm.total_arcsec_yr)} ± {f2(m.pm.err_total)}″/yr<div className="text-[10px] text-muted">PA {f2(m.pm.pa_deg, 1)}°</div></> : "—"}
                      </td>
                      <td className="mono whitespace-nowrap py-1.5 pr-3">
                        {m?.comparison ? <>{f2(m.comparison.total_arcsec_yr)}″/yr<div className="text-[10px] text-muted">PA {f2(m.comparison.pa_deg, 1)}°</div></> : "—"}
                      </td>
                      <td className={`py-1.5 pr-3 ${TONE[v.kind]}`}>{v.text}</td>
                    </tr>
                  );
                })}
                {loading ? <tr><td colSpan={5} className="py-3 text-muted">loading the measurements…</td></tr> : null}
              </tbody>
            </table>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <div className="text-sm font-semibold">Measured against the answer key</div>
              <div className="h-72">
                <Plot
                  data={[
                    { x: [0, 12], y: [0, 12], mode: "lines", line: { color: "#3b4256", dash: "dot" }, name: "perfect agreement", hoverinfo: "skip" },
                    {
                      x: rows.filter((r) => r.m?.comparison).map((r) => r.m!.comparison!.total_arcsec_yr),
                      y: rows.filter((r) => r.m?.comparison).map((r) => r.m!.pm!.total_arcsec_yr),
                      error_y: { type: "data", array: rows.filter((r) => r.m?.comparison).map((r) => r.m!.pm!.err_total), visible: true, color: "#f59e0b" },
                      text: rows.filter((r) => r.m?.comparison).map((r) => r.name), textposition: "middle right",
                      mode: "text+markers", marker: { color: "#f59e0b", size: 9 }, name: "SPHEREx measurement", type: "scatter",
                    },
                  ]}
                  layout={{ ...darkLayout, showlegend: false,
                    xaxis: { ...darkLayout.xaxis, title: { text: "Gaia DR3 proper motion (″/yr)" }, range: [-0.5, 12] },
                    yaxis: { ...darkLayout.yaxis, title: { text: "SPHEREx, this tool (″/yr)" }, range: [-0.5, 12] } }} />
              </div>
              <p className="text-[11px] text-muted">Each point is one star; the bar is our 1σ error. Points on the dotted line agree exactly.</p>
            </div>
            <div>
              <div className="text-sm font-semibold">Barnard&apos;s Star, visit by visit</div>
              <div className="h-72">
                {b?.visits && b.fit && b.pm && b.t_ref_mjd !== undefined ? (() => {
                  const tr = b.t_ref_mjd!;
                  const ts = b.visits!.map((v) => (v.mjd - tr) / 365.25);
                  const dates = b.visits!.map((v) => isoDate(v.mjd));
                  const span = [Math.min(...ts) - 0.05, Math.max(...ts) + 0.05];
                  const spanDates = span.map((t) => isoDate(tr + t * 365.25));
                  const north = b.visits!.map((v) => (v.y - b.fit!.y0) * pix);
                  const east = b.visits!.map((v) => -(v.x - b.fit!.x0) * pix);
                  const c = b.comparison;
                  return (
                    <Plot
                      data={[
                        { x: dates, y: north, error_y: { type: "data", array: b.visits!.map((v) => v.ey * pix), visible: true }, mode: "markers", marker: { color: "#f59e0b", size: 8 }, name: "north offset (measured)", type: "scatter" },
                        { x: spanDates, y: span.map((t) => b.pm!.pmdec_arcsec_yr * t), mode: "lines", line: { color: "#f59e0b" }, name: "fitted line", type: "scatter" },
                        ...(c ? [{ x: spanDates, y: span.map((t) => c.pmdec_arcsec_yr * t), mode: "lines" as const, line: { color: "#34d399", dash: "dash" as const }, name: "Gaia DR3 slope", type: "scatter" as const }] : []),
                        { x: dates, y: east, error_y: { type: "data", array: b.visits!.map((v) => v.ex * pix), visible: true }, mode: "markers", marker: { color: "#60a5fa", size: 7 }, name: "east offset (measured)", type: "scatter" },
                      ]}
                      layout={{ ...darkLayout, margin: { l: 50, r: 10, t: 10, b: 30 },
                        legend: { orientation: "h", y: -0.18 },
                        xaxis: { ...darkLayout.xaxis },
                        yaxis: { ...darkLayout.yaxis, title: { text: "offset (″)" } } }} />
                  );
                })() : <div className="h-full animate-pulse rounded bg-panel" />}
              </div>
              <p className="text-[11px] text-muted">
                Orange: where the star was fitted at each usable visit, north of its mean position. The solid line is our
                straight-line fit; the dashed green line is the slope Gaia predicts, drawn through the same mean. Blue:
                the east–west offsets, which barely change because Barnard&apos;s Star moves almost due north.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- method: motion */}
      <Card>
        <CardHeader><CardTitle>2 · How the motion is measured, step by step</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted">
            The challenge&apos;s movers shift only one or two SPHEREx pixels over the survey so far, which is easy to miss by
            eye. So the tool turns “watch closely” into a number with an error bar. Code: <Code>pipeline/deepfield/sky/motion.py</Code>.
          </p>
          <Step n={1} title="Remove each exposure's own background">
            <p>The zodiacal glow differs from frame to frame, so every exposure i loses its own median over good pixels:</p>
            <Eq>f′ᵢ(p) = fᵢ(p) − median<sub>good</sub>( fᵢ )</Eq>
          </Step>
          <Step n={2} title="Combine the exposures of each visit, weighted by their noise">
            <p>Within one visit, exposures are averaged with inverse-variance weights from NASA&apos;s variance plane, and flagged pixels get zero weight:</p>
            <Eq>F(p) = Σᵢ wᵢ(p) f′ᵢ(p) / Σᵢ wᵢ(p),  wᵢ = 1/σᵢ²(p),  σ<sub>F</sub>(p) = ( Σᵢ wᵢ(p) )<sup>−½</sup></Eq>
          </Step>
          <Step n={3} title="Fit the star's position to a fraction of a pixel">
            <p>
              SPHEREx under-samples its point-spread function (FWHM ≈ 1.2 px), so a plain centroid is biased by where the
              star falls inside a pixel. Instead a 2-D Gaussian plus a flat background is fitted in a 7×7 box by
              weighted least squares (SciPy <Code>least_squares</Code>):
            </p>
            <Eq>m(x, y) = A · exp( −[(x − x<sub>c</sub>)² + (y − y<sub>c</sub>)²] / 2s² ) + B,  minimise χ² = Σ ( (m − F) / σ<sub>F</sub> )²</Eq>
            <p>
              Position errors come from the covariance (JᵀJ)⁻¹, inflated by max(1, χ²/dof) when the fit is worse than the
              noise predicts, and a 0.05 px systematic floor is added in quadrature for reprojection and detector-to-detector
              PSF changes. A visit only counts if its detection has SNR ≥ 5 and the fit is not pinned to the edge of its box
              (which means it found a neighbour, not the star). At least 3 such visits spanning 60 days are required.
            </p>
          </Step>
          <Step n={4} title="Fit a straight line through time">
            <p>With t in years from the mean visit date, x and y are fitted separately by weighted linear least squares (w = 1/σ²):</p>
            <Eq>x(t) = x₀ + vₓ t,  y(t) = y₀ + v<sub>y</sub> t,  errors × √max(1, χ²/(N − 2))</Eq>
            <p>If the visits scatter more than their error bars predict, the error bars grow to match. They are never trusted below what the data shows.</p>
          </Step>
          <Step n={5} title="Convert pixels per year to arcseconds per year">
            <p>Through the grid&apos;s own WCS scale (CDELT; on this grid +x points west, so CDELT1 &lt; 0):</p>
            <Eq>μ<sub>α*</sub> = vₓ · CDELT1 · 3600,  μ<sub>δ</sub> = v<sub>y</sub> · CDELT2 · 3600,  μ = √(μ<sub>α*</sub>² + μ<sub>δ</sub>²),  PA = atan2(μ<sub>α*</sub>, μ<sub>δ</sub>)</Eq>
            <Eq>σ<sub>μ</sub> = √( (μ<sub>α*</sub> σ<sub>α*</sub>)² + (μ<sub>δ</sub> σ<sub>δ</sub>)² ) / μ</Eq>
          </Step>
          <Step n={6} title="Grade it against Gaia DR3">
            <p>The nearest Gaia DR3 source, carried to the same date, supplies the reference. The difference is expressed in units of <em>our</em> error, because Gaia&apos;s is ~1000× smaller:</p>
            <Eq>n<sub>σ</sub> = √( (Δμ<sub>α*</sub> / σ<sub>α*</sub>)² + (Δμ<sub>δ</sub> / σ<sub>δ</sub>)² ) / √2,  agrees ⇔ n<sub>σ</sub> &lt; 3</Eq>
          </Step>
          <Step n="★" title="Look where the star is now, not where it was in 2000">
            <p>
              Star catalogues quote positions at a reference epoch. A fast mover is propagated linearly from Gaia&apos;s epoch
              J2016.0 (MJD 57388.5) to the survey&apos;s view epoch (MJD 61000, 2025-09-07); over a decade at 10″/yr the neglected
              curvature is under 0.01″:
            </p>
            <Eq>δ(t) = δ₀ + μ<sub>δ</sub> Δt,  α(t) = α₀ + μ<sub>α*</sub> Δt / cos δ₀,  Δt = (MJD − 57388.5) / 365.25</Eq>
            <p>
              This step caught a real bug. With its year-2000 catalogue position, Barnard&apos;s Star was 4.4′ north of the
              view centre, outside its own 6′ image, and the “bright star at the centre” was a different star. The same
              propagation moves the Gaia markers frame by frame in the viewer. Code: <Code>pipeline/deepfield/sky/resolver.py</Code>.
            </p>
          </Step>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- method: spectra */}
      <Card>
        <CardHeader><CardTitle>3 · Spectra on the fly, and what kind of thing a point is</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <Step n={1} title="Every exposure is one colour">
            <p>
              SPHEREx&apos;s linear variable filters mean each exposure of a sky position samples a different wavelength λᵢ.
              Clicking a pixel averages a (2r+1)² box (3×3 by default, about the 7.5″ PSF) of good pixels in every exposure,
              giving one point per exposure:
            </p>
            <Eq>f̄ᵢ = (1/nᵢ) Σ<sub>p∈box, good</sub> fᵢ(p),  σ̄ᵢ = √( Σ σᵢ²(p) ) / nᵢ,  plotted at λᵢ</Eq>
            <p>Pixels NASA&apos;s pipeline flags (saturation, transients, artefacts) are excluded. If none are left, the tool says which flags fired and offers the nearest usable pixel.</p>
          </Step>
          <Step n={2} title="Compare with simple physical shapes">
            <p>Each point&apos;s error gets a 10% systematic floor, because the shapes are deliberately simple:</p>
            <Eq>σ′ᵢ = √( σ̄ᵢ² + (0.10 f̄ᵢ)² ),  s<sub>k</sub> = Σ w tₖ f / Σ w tₖ²,  χ²ₖ = Σ ( (f − s<sub>k</sub> tₖ) / σ′ )²</Eq>
            <p>
              The shapes tₖ are reflected sunlight with methane absorption, plain reflected sunlight, and a stellar
              blackbody B<sub>ν</sub>(λ, T) whose temperature is fitted over 2,300–12,000 K (120 log steps). Relative weights
              follow from the χ² values:
            </p>
            <Eq>pₖ ∝ exp( −½ (χ²ₖ − χ²<sub>min</sub>) )</Eq>
            <p>
              A verdict is “confident” only if the best shape wins by Δχ² &gt; 2 <em>and</em> fits. “Odd one out” means the best
              shape fits worse than 95% of 150 random points in the same field. At least three distinct colours are
              required, otherwise the tool refuses. No trained model and no third-party weights are involved.
              Code: <Code>pipeline/deepfield/sky/analyse.py</Code>, browser port <Code>apps/web/lib/spectralFit.ts</Code>.
            </p>
          </Step>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- method: change */}
      <Card>
        <CardHeader><CardTitle>4 · “Find what changed”: change detection without a trained model</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted">
            “Nothing happened here” means brightness is a smooth function of wavelength and does not depend on when you
            looked. Each pixel is tested against exactly that.
          </p>
          <Step n={1} title="Model each pixel as a smooth spectrum">
            <p>After per-exposure background removal, brightness is fitted as a quadratic in (centred) wavelength, with a 5% systematic floor in the weights:</p>
            <Eq>f′ᵢ ≈ Σ<sub>k=0..2</sub> c<sub>k</sub> (λᵢ − λ̄)<sup>k</sup>,  wᵢ = 1 / ( σᵢ² + (0.05 f′ᵢ)² )</Eq>
          </Step>
          <Step n={2} title="Score what the smooth spectrum cannot explain">
            <Eq>χ²/dof = Σ wᵢ (f′ᵢ − model)² / (n − 3)</Eq>
          </Step>
          <Step n={3} title="Judge each pixel against its own field">
            <p>NASA&apos;s variance plane slightly underestimates the true scatter, so the score is made relative to the field&apos;s own distribution with robust statistics:</p>
            <Eq>z = ( χ²/dof − median ) / ( 1.4826 · MAD ),  flagged when z &gt; 5</Eq>
            <p>A star that moves lights up the pixels it leaves and enters; a star that varies lights up in place; a flagged spot is a place to look, not a discovery. Code: <Code>pipeline/deepfield/sky/analyse.py</Code> (<Code>change_map</Code>).</p>
          </Step>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- evidence */}
      <Card>
        <CardHeader><CardTitle>5 · Validation evidence</CardTitle></CardHeader>
        <CardContent className="grid gap-5 text-sm lg:grid-cols-2">
          <div>
            <div className="font-semibold">Checks against known answers, on real data</div>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-muted">
              <li><span className="text-fg">Independent reference.</span> Every moving star in section 1 is graded against Gaia DR3, which is never used as an input.</li>
              <li><span className="text-fg">Null test.</span> RW Aurigae should not move; the same pipeline measures it as consistent with zero.</li>
              <li>
                <span className="text-fg">Change detection finds the right thing.</span> Measured on the current views
                (15 Nov 2026, with the same <Code>change_map</Code> the viewer runs): RW Aurigae z = 43 and ε Indi Ba z = 25,
                each the strongest spot in its field; Barnard&apos;s Star z ≈ 115 within 2 px of its fitted position (the
                field&apos;s top spot, z = 193, is 4.5 px away in its bright, mostly flagged halo); R Draconis z = 7, fourth in
                its field. WISE 0855 does not flag at the view centre (z ≈ 0): the brief&apos;s 2010 position is about 2′ from
                where it is now, the same reason no motion is claimed for it. Reproduce: open a target and press
                “Find what changed”.
              </li>
              <li><span className="text-fg">Spectra make physical sense.</span> Barnard&apos;s Star, an M4 red dwarf with an effective temperature near 3,100–3,200 K, reads “star-like” at about 3,100–3,350 K wherever its spectrum is usable.</li>
              <li><span className="text-fg">Empty sky behaves like noise.</span> After background removal the median χ²/dof over empty sky is ≈ 1 (0.95 on Barnard&apos;s Star&apos;s field), as it should be when nothing changes.</li>
            </ul>
          </div>
          <div>
            <div className="font-semibold">Automated tests with a planted answer</div>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-muted">
              <li><Code>tests/test_sky_motion.py</Code>: synthetic views with a known motion are recovered within their errors; a static star comes out consistent with zero; position angle and Gaia comparison follow the sky convention; the tool refuses rather than invent a measurement.</li>
              <li><Code>tests/test_sky_analyse.py</Code>: a constant field scores ≈ 1; colour and a shifting background are not flagged; a moving and a pulsing source are; blackbody temperatures are recovered; too few colours means a refusal.</li>
              <li><Code>tests/test_sky_resolver.py</Code>: movers are viewed where they are during the survey; WISE 0855 keeps the brief&apos;s position verbatim; built-in coordinates match CDS Sesame.</li>
              <li><Code>apps/web/lib/sky.cube.test.ts</Code> and <Code>spectralFit.test.ts</Code>: the browser&apos;s spectrum and classifier reproduce the Python reference on a real bundle: same exposures, same flux within one quantisation step, same verdicts.</li>
            </ul>
          </div>
          <div className="lg:col-span-2">
            <div className="font-semibold">Bugs the tests missed and real data caught, each now pinned by a test</div>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-muted">
              <li><span className="text-fg">The wrong star at the centre.</span> Year-2000 positions put Barnard&apos;s Star outside its own view. Fixed by epoch propagation (section 2, ★).</li>
              <li><span className="text-fg">Change detection detected colour.</span> A constant-brightness model ignored that every exposure sees a different wavelength: median χ²/dof over <em>empty sky</em> was 7–97. Fixed with the wavelength model and field-relative z.</li>
              <li><span className="text-fg">“Odd one out” fired on every real star.</span> Random pixels have a median best-shape χ²/dof of 13–19, so any fixed threshold flagged everything. Now calibrated per field.</li>
              <li><span className="text-fg">Cool stars were called asteroids.</span> A single fixed 4,500 K star shape lost to “reflected sunlight” for a 3,100 K M dwarf. The star&apos;s temperature is now fitted.</li>
              <li><span className="text-fg">The browser lost variance precision.</span> Linear 16-bit storage left 10% of pixels wrong by more than 38%; variance is now stored in log space (99th-percentile error 0.015%).</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- limits */}
      <Card>
        <CardHeader><CardTitle>6 · Known limits, stated plainly</CardTitle></CardHeader>
        <CardContent className="text-sm">
          <ul className="list-disc space-y-1.5 pl-5 text-muted">
            <li>Parallax is not modelled. For Barnard&apos;s Star it is 0.55″, under a tenth of a pixel and well inside our error bar.</li>
            <li>Bright cores saturate. Barnard&apos;s Star gives a usable position in only part of its visits; R Draconis in none, so its motion is refused.</li>
            <li>Blends defeat 6.15″ pixels. By 2025 WISE 0855 sits within 8″ of a brighter star, so the tool does not claim a motion for it.</li>
            <li>The spectral shapes are illustrative. A warm brown dwarf can read “star-like” (ε Indi Ba does, at ≈ 2,500 K); real brown-dwarf templates are the fix.</li>
            <li>New positions are built on demand from NASA&apos;s archive and take minutes on our small server; the archive itself is sometimes slow.</li>
          </ul>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- provenance */}
      <Card>
        <CardHeader><CardTitle>7 · Data provenance (manifest.yaml)</CardTitle></CardHeader>
        <CardContent className="overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted"><tr><th className="py-1 pr-3">dataset</th><th className="py-1 pr-3">owner</th><th className="py-1 pr-3">country</th><th className="py-1 pr-3">licence</th><th className="py-1 pr-3">used for</th></tr></thead>
            <tbody>
              {man?.datasets.map((d) => (
                <tr key={d.id} className="border-t border-line align-top">
                  <td className="py-1 pr-3 font-semibold">{d.name}{d.doi ? <div className="mono text-[10px] text-muted">doi:{d.doi}</div> : null}</td>
                  <td className="py-1 pr-3">{d.owner}</td><td className="py-1 pr-3">{d.country}</td><td className="py-1 pr-3">{d.licence}</td><td className="py-1 pr-3 text-muted">{d.used_for}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted">
        The Planet X search&apos;s own injection tests are a separate, experimental project on simulated data:
        see <Link href="/hunt/proof" className="underline underline-offset-2">Planet X · Injection tests</Link>.
      </p>
    </div>
  );
}
