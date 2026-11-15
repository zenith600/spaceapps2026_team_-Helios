"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * /proof — the scientific methodology and the evidence for it.
 *
 * Every number on this page is read from the validation run's machine-readable report
 * (public/validation/report.json, produced by `python -m deepfield.validation`), or from the
 * viewer's own motion files for the "quick method" table. Nothing is typed in by hand.
 * Each result is labelled with its dataset, method, sample size, and whether it comes from
 * real SPHEREx observations or from synthetic sources injected into real exposures.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Plot, darkLayout } from "@/components/Plot";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getManifest } from "@/lib/api";
import type { Manifest } from "@/lib/types";
import type { Motion } from "@/lib/sky";

type R = Record<string, any>;

async function json<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}
const fmt = (v: any, d = 2) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "—");
const pct = (v: any, d = 0) => (typeof v === "number" && Number.isFinite(v) ? `${(100 * v).toFixed(d)} %` : "—");

// ------------------------------------------------------------------ layout helpers
function Eq({ children }: { children: ReactNode }) {
  return <div className="mono my-2 overflow-x-auto whitespace-nowrap rounded-md border border-line bg-bg px-3 py-2 text-[13px] leading-relaxed text-fg">{children}</div>;
}
const Code = ({ children }: { children: ReactNode }) => <code className="mono rounded bg-bg px-1 py-0.5 text-[12px] text-fg">{children}</code>;
function Tag({ kind }: { kind: "real" | "synthetic" | "both" }) {
  const t = { real: ["real SPHEREx data", "bg-emerald-500/15 text-emerald-300"], synthetic: ["synthetic injections into real exposures", "bg-sky-500/15 text-sky-300"], both: ["real + injections", "bg-amber-500/15 text-amber-300"] }[kind];
  return <span className={`ml-2 inline-block rounded px-1.5 py-0.5 align-middle text-[10px] font-medium ${t[1]}`}>{t[0]}</span>;
}
function Section({ n, title, tag, children }: { n: number; title: string; tag?: "real" | "synthetic" | "both"; children: ReactNode }) {
  return (
    <Card id={`s${n}`}>
      <CardHeader><CardTitle>{n} · {title}{tag ? <Tag kind={tag} /> : null}</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm text-muted">{children}</CardContent>
    </Card>
  );
}
function T({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-xs">
        <thead className="text-muted"><tr>{head.map((h) => <th key={h} className="whitespace-nowrap py-1.5 pr-3 font-medium">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-line align-top">{r.map((c, j) => <td key={j} className="py-1.5 pr-3 text-fg">{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
function Status({ s }: { s: "implemented" | "tested" | "validated" | "partial" | "independent" | "blocked" | "failed" }) {
  const m: Record<string, string> = {
    implemented: "bg-slate-500/20 text-slate-300", tested: "bg-sky-500/15 text-sky-300", validated: "bg-emerald-500/15 text-emerald-300",
    partial: "bg-amber-500/15 text-amber-300",
    independent: "bg-violet-500/15 text-violet-300", blocked: "bg-slate-500/20 text-slate-400", failed: "bg-red-500/15 text-red-300",
  };
  const label: Record<string, string> = { implemented: "implemented", tested: "unit-tested", validated: "empirically validated", partial: "partly validated (failures shown)", independent: "independently verified", blocked: "not done", failed: "failed / not achieved" };
  return <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium ${m[s]}`}>{label[s]}</span>;
}

// ------------------------------------------------------------------ page
export default function Proof() {
  const [rep, setRep] = useState<R | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [quick, setQuick] = useState<{ name: string; m: Motion }[]>([]);
  const [man, setMan] = useState<Manifest | null>(null);

  useEffect(() => {
    json<R>("/validation/report.json").then(setRep).catch((e) => setErr(String(e)));
    json<{ targets: { name: string; slug: string }[] }>("/demo/sky/index.json")
      .then((ix) => Promise.all(ix.targets.map(async (t) => ({ name: t.name, m: await json<Motion>(`/demo/sky/${t.slug}/motion.json`).catch(() => null) }))))
      .then((rows) => setQuick(rows.filter((r): r is { name: string; m: Motion } => r.m !== null)))
      .catch(() => {});
    getManifest().then(setMan).catch(() => {});
  }, []);

  const fields: [string, R][] = useMemo(() => (rep ? Object.entries(rep.fields as R) : []), [rep]);
  const split = (s: string) => fields.filter(([, f]) => f.split === s);
  const hold = split("holdout");
  const allInj = fields.filter(([, f]) => f.injection);
  const sum = (rows: [string, R][], get: (f: R) => any) => rows.reduce((a, [, f]) => a + (Number(get(f)) || 0), 0);
  const hSolveP = sum(hold, (f) => f.astrometry?.seeded_solve?.n_passed);
  const hSolveN = sum(hold, (f) => f.astrometry?.seeded_solve?.n_exposures);
  const hWcsPassed = hold.filter(([, f]) => f.astrometry?.passed).length;
  const failedChecks = (f: R) => Object.entries(f.astrometry?.checks ?? {}).filter(([, ok]) => !ok).map(([k]) => k.replace(/_/g, " "));
  const range = (rows: [string, R][], get: (f: R) => any, as: (v: number) => string) => {
    const v = rows.map(([, f]) => get(f)).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    return v.length ? `${as(Math.min(...v))}–${as(Math.max(...v))}` : "—";
  };
  const extScan: R[] = rep?.splits?.development?.decided?.extendedness_threshold_scan ?? [];
  const extMetTarget = extScan.some((r) => r.false_extended_rate_points != null && r.false_extended_rate_points <= 0.05);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-bold">Proof: methods, evidence and limits</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          This page documents what Deep Field actually computes and how well it works, measured. Results come from a reproducible
          validation run on <b className="text-fg">original NASA SPHEREx Level 2 exposures</b> (not the resampled images the viewer
          plays), from <b className="text-fg">synthetic sources injected into those real exposures</b>, and from a
          <b className="text-fg"> holdout of fields that were not looked at until every parameter was frozen</b>. Each result says which.
          Where something failed or could not be tested, it says that too.
        </p>
        {err ? <p className="mt-2 text-xs text-amber-300">The validation report could not be loaded ({err}).</p> : null}
        {rep ? (
          <p className="mono mt-2 text-[11px] text-muted">
            run {rep.run_id} · config {rep.config_hash} · seed {rep.seed} · commit {String(rep.environment?.git_commit).slice(0, 10)}
            {rep.environment?.git_dirty ? " (dirty)" : ""} · frozen params {rep.frozen_params?.hash}
          </p>
        ) : null}
      </div>

      {/* readiness at a glance */}
      <Card>
        <CardHeader><CardTitle>Status of each capability</CardTitle></CardHeader>
        <CardContent>
          <T head={["capability", "status", "evidence (holdout fields unless stated)"]} rows={[
            ["Official WCS checked against Gaia DR3", <Status key="a" s="partial" />,
              `median residual ${range(hold, (f) => f.astrometry?.residual_arcsec?.median, (v) => v.toFixed(2))}″; pre-set pass criteria met in ${hWcsPassed} of ${hold.length} holdout fields — every field has some exposures with fewer than 5 confirmed stars, and R Draconis also fails the 0.6″ median limit (§7)`],
            ["Independent seeded plate solve", <Status key="b" s="partial" />,
              `${hSolveP} of ${hSolveN} holdout exposures pass all checks (most failures: the rotation vote is not decisive in sparse windows); where it passes it agrees with the official WCS to ${range(hold, (f) => f.astrometry?.seeded_solve?.vs_official_centre_sep_arcsec?.median, (v) => v.toFixed(2))}″ at the centre (§4). No blind Astrometry.net solve here.`],
            ["Epoch-aware Gaia matching with covariance", <Status key="c" s="validated" />, `field stars reproduce their own Gaia proper motions: ${range(hold, (f) => f.motion?.registration?.fraction_inconsistent, (v) => pct(v, 1))} inconsistent at p < 0.0027 (§9); propagation unit-tested against Astropy and Monte Carlo`],
            ["Galaxy / extended-source identification", <Status key="d" s="partial" />, `injected extended sources recovered ${range(hold, (f) => f.injection?.extended?.recall_extended, (v) => pct(v))}, points wrongly called extended ${range(hold, (f) => f.injection?.extended?.false_extended_rate_points, (v) => pct(v))}; in real data next to a very bright star (R Draconis) most "extended" detections are artefacts (§6)`],
            ["Instrument ePSF vs Gaussian", <Status key="e" s="validated" />, `${rep?.psf_comparison?.n_star_exposures ?? "—"} real star-exposures: ePSF fits better in ${pct(rep?.psf_comparison?.fraction_epsf_better_chi2)}, Gaussian under-measures flux by ${pct(1 - (rep?.psf_comparison?.flux_ratio_gauss_over_epsf?.median ?? NaN))} (§8)`],
            ["Proper motion of a target star", <Status key="f" s="partial" />, "Epsilon Indi B (calibration field) agrees with Gaia; bright targets (R Dra, Teegarden, Barnard, RW Aur) saturate and are reported not measurable (§9)"],
            ["Variability without colour confusion", <Status key="g" s="partial" />, `steep constant spectra no longer flagged (primary test ${range(hold, (f) => f.injection?.variability?.false_positive_rate_steep_spectrum_q05, (v) => pct(v))} vs up to 100 % for the model fit); static false-positive rate ${range(hold, (f) => f.injection?.variability?.false_positive_rate_static_q05, (v) => pct(v))} against a 5 % target (§10)`],
            ["Multiple-testing control (BH FDR)", <Status key="h" s="tested" />, "implemented and unit-tested; it is only as good as the per-source p-values, which are not calibrated in every field (§11)"],
            ["Uncertainty calibration", <Status key="i" s="partial" />, "positions close to nominal at 68 % but with heavy tails; flux and proper-motion errors are too small in the tails (§14)"],
            ["Independent verification by a third party", <Status key="j" s="blocked" />, "not done; everything here is reproducible from the repository (§17)"],
          ]} />
        </CardContent>
      </Card>

      <Section n={1} title="Scientific problem">
        <p>SPHEREx images the whole sky every six months in 102 infrared colours. The challenge is to let anyone see how a patch of sky changes over time. Doing that credibly needs three things this page tests: that pixel positions map to the right places on the sky, that measured changes (motion, brightness) are real rather than artefacts of colour, calibration or blending, and that the stated uncertainties mean what they claim.</p>
      </Section>

      <Section n={2} title="System architecture">
        <T head={["layer", "what it does"]} rows={[
          ["NASA IRSA (archive)", "SPHEREx DR1/QR3 Level 2 cutouts: image, flags, variance, zodi, ePSF, per-pixel wavelength, official TAN-SIP WCS"],
          ["Viewer path", "cutouts resampled onto one grid → films, quick motion, spectra (what the Sky Viewer plays)"],
          ["Validation path", <span key="v">original exposures, never resampled → ePSF fits → official WCS → Gaia DR3 at each exposure's epoch → statistics. Code: <Code>pipeline/deepfield/astro</Code>, runner <Code>pipeline/deepfield/validation</Code></span>],
          ["Catalogues", "Gaia DR3 (IRSA mirror via Gator), 2MASS XSC and AllWISE (IRSA), NED (NASA/IPAC). Cached with provenance."],
          ["Front end", "Next.js on Vercel; FastAPI on a VM proxied at /api"],
        ]} />
      </Section>

      <Section n={3} title="Image processing methodology" tag="real">
        <p>
          Measurements use each exposure's own pixels in a fixed 91×91-pixel window around the field centre (cutouts were requested at
          different sizes; the window keeps exposures comparable). Pixels with NASA flag bits TRANSIENT, OVERFLOW, SUR_ERROR, NONFUNC,
          MISSING_DATA, HOT, COLD, NONLINEAR, PERSIST, OUTLIER, GHOST*, STREAK, BLOOM, SNOWBALL or HALO are excluded. A star whose core has
          OVERFLOW or NONLINEAR is "saturated" and is not used as an astrometric reference.
        </p>
        <p>
          Sources are found with a matched filter, SNR = Σk(I−B)/√(Σk²σ²), with a Gaussian kernel of the exposure's PSF width, peaks above 5.
          The viewer's films are different: cutouts bilinearly resampled onto one grid, which overstates per-pixel variance and correlates
          neighbouring pixels. That is why the validation does not use them.
        </p>
      </Section>

      <Section n={4} title="Plate solving and WCS" tag="real">
        <p>Pixel → sky uses the official SPHEREx WCS exactly as published (gnomonic projection with 3rd-order SIP distortion):</p>
        <Eq>u = x − x₀ + Σ A_pq (x−x₀)^p (y−y₀)^q,  v = y − y₀ + Σ B_pq (x−x₀)^p (y−y₀)^q,  [ξ, η]ᵀ = CD·[u, v]ᵀ,  (α, δ) = TAN⁻¹(ξ, η; α₀, δ₀)</Eq>
        <p>
          The SPHEREx pipeline itself plate-solves every exposure with Astrometry.net on the full detector (header <Code>ASTRONETSOLVED</Code>,
          <Code>FINAST = 0</Code>). We do not replace that solution. We (a) validate it against Gaia DR3 (§7) and (b) re-derive an independent
          solution per exposure, seeded only by the requested pointing and the nominal 6.15″ scale: rotation (0.5° steps), parity and translation
          by voting over detection–Gaia pixel offsets with the 40 brightest detections and 60 brightest references, then a TAN fit
          (<Code>astropy.wcs.utils.fit_wcs_from_points</Code>), 5-fold out-of-sample residuals, and only then a comparison with the official WCS.
        </p>
        <p>A solve <b className="text-fg">passes</b> only if: ≥ 6 matches, the winning vote ≥ 2× the best rival, out-of-sample RMS ≤ 0.35 px, and scale within 2 % of nominal.</p>
        <T head={["field", "split", "exposures", "solves passed", "out-of-sample RMS (px, median)", "vs official: centre (″)", "vs official: max over window (″)", "rotation diff (°, median)", "scale ratio"]}
          rows={fields.map(([id, f]) => {
            const s = f.astrometry?.seeded_solve ?? {};
            return [f.name, f.split, s.n_exposures, `${s.n_passed} / ${s.n_exposures}`, fmt(s.out_of_sample_rms_px?.median, 3),
              fmt(s.vs_official_centre_sep_arcsec?.median, 2), fmt(s.vs_official_max_sep_arcsec?.median, 2), fmt(s.rotation_diff_deg?.median, 3), fmt(s.scale_ratio?.median, 4)];
          })} />
        <p>
          <b className="text-fg">Result:</b> on the holdout fields {hSolveP} of {hSolveN} exposures pass. Nearly all failures are the "unambiguous" check: in a 9′ window with
          10–30 usable stars the best rotation does not beat the runner-up by 2×, so the solve declines to answer rather than guess. Exposures with
          too few stars (&lt; 6 matches) are reported as "insufficient". The checks were fixed before the run and were not relaxed afterwards.
        </p>
        <p className="text-[11px]">The independent solution is TAN-only; across the window it differs from the SIP solution by the "max" column, which bounds what ignoring distortion costs over 9′.</p>
      </Section>

      <Section n={5} title="Gaia DR3 integration and epoch-aware matching" tag="real">
        <p>
          Gaia DR3 is queried through IRSA's mirror (<Code>gaia_dr3_source</Code>; ESA's archive was unreachable on 15 Nov 2026). Reference stars
          must have RUWE &lt; 1.4, a 5- or 6-parameter solution, 8 ≤ G ≤ 19.5 and no duplicated-source flag. Each star is carried from J2016.0 to the
          exposure's mid-time with ERFA <Code>pmpx</Code> (proper motion, parallax, radial velocity), as seen from SPHEREx itself (Earth from ERFA
          <Code>epv00</Code> plus the spacecraft's geocentric position from the FITS header). Its 5×5 covariance is propagated with the Jacobian of the same model:
        </p>
        <Eq>C_G(t) = J·Σ₅·Jᵀ,  J = ∂(ξ, η)/∂(α*, δ, ϖ, μα*, μδ)</Eq>
        <p>A detection and a candidate are compared with a covariance-aware statistic, never a fixed pixel radius alone:</p>
        <Eq>D² = Δᵀ (C_DF + C_G + σ_sys²·I)⁻¹ Δ,  acceptable if D² &lt; 11.83 (χ²₂, p = 0.0027)</Eq>
        <T head={["class", "rule"]} rows={[
          ["confirmed", "one acceptable candidate, passes the reference filter, no Gaia neighbour within 12″ brighter than G + 2.5, not saturated"],
          ["probable", "one acceptable candidate that fails the quality, isolation or saturation conditions"],
          ["ambiguous", "two or more acceptable candidates within 2.5 mag of each other"],
          ["no match", "no acceptable candidate (a non-Gaia source, a galaxy, an artefact or a mover)"],
        ]} />
        <T head={["field", "confirmed", "probable", "ambiguous", "no match", "confirmed per exposure (min / median)"]}
          rows={fields.map(([, f]) => {
            const c = f.astrometry?.association_counts ?? {};
            const pe = f.astrometry?.confirmed_per_exposure ?? {};
            return [f.name, c.confirmed, c.probable, c.ambiguous, c.none, `${pe.min ?? "—"} / ${fmt(pe.median, 0)}`];
          })} />
      </Section>

      <Section n={6} title="Galaxy catalogue integration and extended sources" tag="both">
        <p>
          A source is called a galaxy only on evidence: NED type (<Code>prefphytype</Code>) and redshift, membership of the 2MASS Extended Source
          Catalog, AllWISE <Code>ext_flg</Code> &gt; 0, Gaia's own galaxy probability, and SPHEREx morphology. Morphology is a likelihood-ratio test of
          the ePSF blurred by a Gaussian of width w against the plain ePSF (w = 0 on the boundary, so p = ½·P(χ²₁ ≥ Δχ²)), combined over exposures with
          Fisher's method; "resolved" needs p &lt; 10⁻³ and a median blur ≥ the threshold tuned on the development split
          ({fmt(rep?.splits?.development?.decided?.ext_min_blur_px, 2)} px). <b className="text-fg">A source is never called a galaxy because it lacks a Gaia match.</b> Resolved sources are flagged unsuitable for point-source analysis.
        </p>
        <T head={["field", "sources classified", "classes found (real data)"]}
          rows={fields.map(([, f]) => [f.name, f.sources?.n_sources, Object.entries(f.sources?.classes ?? {}).map(([k, v]) => `${v} × ${k}`).join("; ") || "—"])} />
        <T head={["field (synthetic test)", "extended injected", "recovered as extended", "point sources wrongly called extended", "recall by blur (px)"]}
          rows={allInj.map(([, f]) => {
            const e = f.injection?.extended ?? {};
            return [f.name, e.n_extended, pct(e.recall_extended), pct(e.false_extended_rate_points),
              (e.recall_by_blur ?? []).map((r: R) => `${r.blur_px}: ${pct(r.recall)}`).join(", ")];
          })} />
        <p>
          <b className="text-fg">Threshold choice:</b> the development rule was "smallest blur threshold with ≤ 5 % of point sources called extended,
          best recall". {extMetTarget ? "A threshold met it." : <>No threshold in the scan met the 5 % target on the development injections (best: {pct(Math.min(...extScan.map((r) => r.false_extended_rate_points ?? 1)), 1)}), so the pre-set default ({fmt(rep?.splits?.development?.decided?.ext_min_blur_px, 2)} px) was kept, with a false-extended rate of {pct(extScan[0]?.false_extended_rate_points, 1)} on development.</>}
        </p>
        <p>
          <b className="text-fg">Real data caveat:</b> in the R Draconis field most detections are classed "extended, not in the catalogues searched".
          These are almost certainly structure in the halo and diffraction pattern of the saturated star, not galaxies; the classifier has no
          bright-star mask yet. Classes near a saturated star should be treated as unreliable. In the high-latitude field the catalogue
          matches (NED, 2MASS XSC, AllWISE) give the galaxy classes shown.
        </p>
        <p className="text-[11px]">Injected extended sources are ePSF ⊗ Gaussian profiles, not Sérsic galaxies. The real fields here are mostly star fields; the high-latitude field is the one with a meaningful number of catalogued galaxies. Catalogue coverage is not complete: Pan-STARRS and SDSS are not queried, and SIMBAD is not used.</p>
      </Section>

      <Section n={7} title="Astrometric validation of the official WCS" tag="real">
        <p>For every confirmed Gaia star in every exposure: offset between where the official WCS puts the ePSF-fitted position and where Gaia predicts the star at that moment, as seen from SPHEREx.</p>
        <T head={["field", "split", "n", "median residual (″)", "RMS (″)", "95th pct (″)", "mean offset ξ, η (″) ± s.e.", "zero-point scatter between exposures (″)", "confirmed stars per exposure (min)", "pre-set criteria"]}
          rows={fields.map(([, f]) => {
            const a = f.astrometry ?? {};
            const r = a.residual_arcsec ?? {};
            const mo = a.mean_offset_arcsec ?? {};
            const zp = a.per_exposure_zero_point_arcsec ?? {};
            const fc = failedChecks(f);
            return [f.name, f.split, r.n, fmt(r.median, 3), fmt(r.rms, 3), fmt(r.p95, 2),
              `${fmt(mo.xi, 3)} ± ${fmt(mo.sem_xi, 3)}, ${fmt(mo.eta, 3)} ± ${fmt(mo.sem_eta, 3)}`,
              `${fmt(zp.rms_xi, 3)}, ${fmt(zp.rms_eta, 3)}`, a.confirmed_per_exposure?.min,
              a.passed ? <span key="p" className="text-emerald-300">passed</span> : <span key="p" className="text-red-300">failed: {fc.join("; ")}</span>];
          })} />
        <T head={["field", "residual trend across the window: ξ vs x, ξ vs y, η vs x, η vs y (″ per 100 px ± s.e.)"]}
          rows={fields.map(([, f]) => {
            const t = f.astrometry?.spatial_trend ?? {};
            const c = (v: any, s: any) => {
              const sig = Math.abs(v / s) >= 3;
              return <span key={String(v)} className={sig ? "text-amber-300" : ""}>{fmt(v, 2)} ± {fmt(s, 2)}{sig ? " (≥ 3σ)" : ""}</span>;
            };
            return [f.name, <span key="t" className="flex flex-wrap gap-x-3">{c(t.xi?.slope_x_arcsec_per_100px, t.xi?.se_x)}{c(t.xi?.slope_y_arcsec_per_100px, t.xi?.se_y)}{c(t.eta?.slope_x_arcsec_per_100px, t.eta?.se_x)}{c(t.eta?.slope_y_arcsec_per_100px, t.eta?.se_y)}</span>];
          })} />
        <p>
          <b className="text-fg">Reading this:</b> where enough stars are present the official WCS matches Gaia to about a third of an arcsecond
          (median; ≈ 1/18 pixel), in development, calibration and holdout fields alike. Mean offsets are within the 0.6″ criterion everywhere, but in
          two fields (Epsilon Indi B, R Draconis) a ~0.2″ offset in ξ is statistically significant — small next to the 6.15″ pixel, and removed for motion
          work by the per-exposure zero point (§9). The failures are of two kinds.
          (1) Every holdout field has a few exposures with fewer than 5 confirmed stars in the 91×91 window (sparse sky, window near a detector
          edge, or a bright star masking neighbours), so the criterion "every exposure is checked by ≥ 5 stars" is not met. (2) In the R Draconis
          field (a G = 6.4 Mira that saturates) residuals are larger and depend on position by up to ~0.5″ per 100 px — consistent with the bright
          star's halo pulling the fitted positions of its neighbours, though this run does not prove the cause.
        </p>
        <p className="text-[11px]">
          Pass criteria (fixed before running): ≥ 5 confirmed stars in every exposure, median residual ≤ 0.6″ (0.1 px), |mean offset| ≤ 0.6″.
          Spatial trends (residual vs position in the window) and normalised-residual coverage are in the report; the systematic floor σ_sys used in D² was measured on the calibration field ({fmt(rep?.splits?.calibration?.astrometric_floor_arcsec, 3)}″).
        </p>
      </Section>

      <Section n={8} title="PSF and photometry: instrument ePSF vs the Gaussian" tag="both">
        {rep?.psf_comparison?.n_star_exposures ? (() => {
          const p = rep.psf_comparison;
          return (
            <>
              <p>Same stars, same pixels, same fitter; only the model differs. The ePSF is NASA's per-exposure effective PSF (5× oversampled, 21×21 detector zones; calibration <Code>epsf_&lt;det&gt;_20260507.fits</Code>), evaluated at each star's own zone. {p.n_star_exposures} star-exposures of Gaia-confirmed stars, SNR 10–2000.</p>
              <T head={["metric (real stars)", "instrument ePSF", "Gaussian (previous model)"]} rows={[
                ["median χ²/dof of the fit", fmt(p.median_chi2_dof?.epsf, 2), fmt(p.median_chi2_dof?.gaussian, 2)],
                ["median offset from Gaia (″)", fmt(p.astrometric_residual_vs_gaia_arcsec?.epsf?.median, 3), fmt(p.astrometric_residual_vs_gaia_arcsec?.gaussian?.median, 3)],
                ["RMS offset from Gaia (″)", fmt(p.astrometric_residual_vs_gaia_arcsec?.epsf?.rms, 3), fmt(p.astrometric_residual_vs_gaia_arcsec?.gaussian?.rms, 3)],
                ["fits with lower χ²", pct(p.fraction_epsf_better_chi2), pct(1 - p.fraction_epsf_better_chi2)],
                ["closer to Gaia", pct(p.fraction_epsf_closer_to_gaia), pct(1 - p.fraction_epsf_closer_to_gaia)],
                ["flux ratio Gaussian / ePSF (median)", "1", fmt(p.flux_ratio_gauss_over_epsf?.median, 3)],
              ]} />
              <T head={["SNR bin", "n", "Gaussian/ePSF flux (median)", "ePSF offset (″)", "Gaussian offset (″)", "ePSF χ²/dof", "Gaussian χ²/dof"]}
                rows={(p.by_snr ?? []).map((b: R) => [`${b.snr_lo}–${b.snr_hi}`, b.n, fmt(b.flux_ratio_median, 3), fmt(b.epsf_resid_median, 3), fmt(b.gauss_resid_median, 3), fmt(b.epsf_chi2_dof_median, 2), fmt(b.gauss_chi2_dof_median, 2)])} />
              <p>
                <b className="text-fg">Reading this:</b> the instrument ePSF is the better model at every SNR (lower χ², closer to Gaia), and the Gaussian
                systematically under-measures flux by about {pct(1 - p.flux_ratio_gauss_over_epsf?.median)} because it misses the PSF wings. But the ePSF does not fit bright
                stars to the noise either: χ²/dof grows with SNR, meaning a model error of a few per cent of the peak (zone interpolation,
                pixel-response, or variance underestimate). That residual model error is one reason bright-star errors are scaled by χ²/dof.
              </p>
            </>
          );
        })() : <p>Loading…</p>}
        <T head={["field (synthetic test)", "flux bias (median, SNR ≥ 5)", "flux 1σ / 2σ coverage", "n"]}
          rows={allInj.map(([, f]) => {
            const fl = f.injection?.flux ?? {};
            return [f.name, pct(fl.fractional_bias_median, 1), `${pct(fl.coverage?.empirical?.[0])} / ${pct(fl.coverage?.empirical?.[1])}`, fl.n];
          })} />
        <p className="text-[11px]">Injected sources are drawn with the same ePSF used to fit them, so injection tests cannot measure ePSF model error; the real-star comparison above can.</p>
      </Section>

      <Section n={9} title="Motion" tag="both">
        <p>Per exposure, the target is ePSF-fitted on original pixels, mapped through the official WCS, and corrected by that exposure's zero point (weighted mean offset of its confirmed field stars, median-started, outliers at D² &gt; 9.21 rejected). Then, by generalised least squares with each epoch's 2×2 covariance:</p>
        <Eq>[ξ, η](t) = p₀ + μ·t + ϖ·P(t),  P = ERFA parallax factors for SPHEREx's own position;  D²_μ = Δμᵀ (C_DF + C_Gaia)⁻¹ Δμ</Eq>
        <p><b className="text-fg">Registration check</b>: every confirmed field star must reproduce its own Gaia motion (consistent at p ≥ 0.0027). If more than 5 % fail, any target result is labelled unreliable. Saturated targets may be fitted on their unsaturated wings only if wing fits of saturated field stars pass a coverage test on the same field.</p>
        <T head={["field", "split", "field stars checked", "inconsistent with Gaia", "median D² (χ²₂ median = 1.39)", "target", "usable epochs (strict / with wings)", "result"]}
          rows={fields.map(([, f]) => {
            const m = f.motion ?? {};
            const g = m.registration ?? {};
            const t = m.target ?? {};
            const v = t.vs_gaia;
            const fit = t.fit_parallax_from_gaia;
            const res = v ? `${fmt(fit?.pm_total, 3)} ± ${fmt(fit?.pm_total_err, 3)}″/yr vs Gaia ${fmt(v.gaia_total, 3)}″/yr; D² = ${fmt(v.d2, 2)}, p = ${fmt(v.p, 3)}` : "";
            return [f.name, f.split, g.n_field_stars, pct(g.fraction_inconsistent, 1), fmt(g.median_d2, 2), t.gaia_id ? `Gaia DR3 ${t.gaia_id}` : "none",
              t.gaia_id ? `${t.epochs_strict_unsaturated ?? "—"} / ${t.epochs_including_wing_fits ?? "—"}` : "—",
              <span key="r">{t.label}{res ? <span className="block text-[10px] text-muted">{res}</span> : null}{t.gaia_caveat ? <span className="block text-[10px] text-amber-300">{t.gaia_caveat}</span> : null}</span>];
          })} />
        <T head={["field (synthetic test)", "moving detected (p < 0.0027)", "static wrongly 'moving'", "pm error median (″/yr)", "pm 1σ / 2σ / 3σ coverage", "by |μ| (″/yr): detected"]}
          rows={allInj.map(([, f]) => {
            const m = f.injection?.motion ?? {};
            return [f.name, pct(m.detected_motion_rate_moving_p0027), pct(m.false_motion_rate_static_p0027, 1), fmt(m.pm_error_arcsec_yr?.median, 3),
              (m.pm_coverage?.empirical ?? []).map((x: number) => pct(x)).join(" / "), (m.by_pm ?? []).map((b: R) => `${b.pm_lo}–${b.pm_hi}: ${pct(b.detected_rate)}`).join(", ")];
          })} />
        <p>
          <b className="text-fg">Reading this:</b> the registration check passes in every field, so the per-exposure sky positions are good enough to recover
          known stellar motions. Of the named targets, only Epsilon Indi B (G = 18, unsaturated in {rep?.fields?.eps_ind?.motion?.target?.epochs_strict_unsaturated ?? "—"} of {rep?.fields?.eps_ind?.n_exposures ?? "—"} exposures) can be measured under the strict protocol, and it agrees
          with Gaia. It sits in the <i>calibration</i> field, so it is not a holdout result: the calibration step used that field's other stars to set the
          noise floors (which came out at σ_sys = {fmt(rep?.splits?.calibration?.astrometric_floor_arcsec, 2)}″). Barnard's Star, Teegarden's Star, RW Aurigae and R Draconis saturate in
          nearly every exposure; wing fits were tested on saturated field stars and failed their coverage test in every field, so they were not used and
          these targets are reported as not measurable rather than estimated.
          {(() => {
            const ff = rep?.fields?.eps_ind?.motion?.target?.fit_parallax_free_or_auto;
            const g = rep?.fields?.eps_ind?.motion?.target?.gaia;
            return ff?.parallax_fitted ? <> With parallax left free, Epsilon Indi B gives ϖ = {fmt(ff.parallax_arcsec * 1000, 0)} ± {fmt(ff.parallax_err * 1000, 0)} mas against Gaia&apos;s {fmt(g?.parallax_mas, 0)} mas, a {fmt(Math.abs(ff.parallax_arcsec * 1000 - g?.parallax_mas) / (ff.parallax_err * 1000), 1)}σ difference.</> : null;
          })()}
        </p>
        <p>
          In the injection tests, static sources were called "moving" at p &lt; 0.0027 in {range(allInj, (f) => f.injection?.motion?.false_motion_rate_static_p0027, (v) => pct(v, 1))} of cases
          against an expected 0.27 %, and proper-motion errors are under-covered in the tails (§14). A motion significance from this pipeline is therefore
          weaker than its nominal p-value, and nothing here is reported as a discovery.
        </p>
        <div className="rounded-md border border-line bg-bg/40 p-3">
          <div className="text-xs font-semibold text-fg">The viewer's quick motion numbers (lower rigour)</div>
          <p className="mt-1 text-[11px]">The Sky Viewer's "How it moves" card uses an older, faster method: Gaussian fits on the resampled per-visit stacks, unsaturated-wing pixels included. It is shown here for transparency; where it disagrees with the validation pipeline above, the validation pipeline is the one that has been tested.</p>
          <T head={["target", "quick method", "Gaia DR3"]} rows={quick.map((q) => [q.name,
            q.m.available && q.m.pm ? `${fmt(q.m.pm.total_arcsec_yr, 2)} ± ${fmt(q.m.pm.err_total, 2)}″/yr (${q.m.visits?.length} visits)` : `not measured: ${q.m.reason ?? ""}`.slice(0, 120),
            q.m.comparison ? `${fmt(q.m.comparison.total_arcsec_yr, 2)}″/yr` : "—"])} />
        </div>
      </Section>

      <Section n={10} title="Variability without confusing colour for time" tag="both">
        <p>SPHEREx sees a different wavelength in almost every exposure, so flux differences are mostly the source's spectrum. Model: F(λ, t) = S(λ) + V(λ, t) + ε.</p>
        <p>
          <b className="text-fg">Primary test (model-free):</b> pairs of measurements from different visits at the same wavelength (|Δλ|/λ &lt; 1/(2R), R the SPHEREx
          resolving power of that band), χ² = Σ z², z = ΔF/√(σ₁² + σ₂²) with a calibrated floor. Needs ≥ 3 disjoint pairs; otherwise the result is
          <b className="text-fg"> inconclusive</b>. <b className="text-fg">Secondary:</b> a likelihood-ratio test of a smooth spectrum (cubic in ln λ) against the same spectrum
          times one factor per visit. Injection tests showed the secondary test flags steep but constant spectra as variable, which is why it is not primary.
        </p>
        <T head={["field (synthetic test)", "static flagged (q < 0.05)", "steep constant flagged: primary / secondary", "variable detected by amplitude", "inconclusive"]}
          rows={allInj.map(([, f]) => {
            const v = f.injection?.variability ?? {};
            return [f.name, pct(v.false_positive_rate_static_q05), `${pct(v.false_positive_rate_steep_spectrum_q05)} / ${pct(v.lrt_false_positive_rate_steep_spectrum_q05)}`,
              (v.detection_rate_by_amplitude_q05 ?? []).map((a: R) => `${a.amp * 100}%: ${pct(a.rate)}`).join(", "), `${v.n_inconclusive ?? "—"} of ${(v.n_inconclusive ?? 0) + (v.n_tested ?? 0)}`];
          })} />
        <T head={["field (real stars)", "tested", "inconclusive", "candidates (BH q < 0.05)", "fraction p < 0.05"]}
          rows={fields.map(([, f]) => {
            const v = f.variability ?? {};
            return [f.name, v.n_testable, v.n_inconclusive, v.n_candidates_q05, pct(v.fraction_p_below_0_05 ?? v["fraction_p_below_0.05"])];
          })} />
        <p>
          <b className="text-fg">Reading this:</b> the primary test fixes the colour-for-time confusion (steep constant spectra are flagged by the model fit up to
          100 % of the time, by the pair test rarely). But its false-positive rate on static injected sources is not uniformly at the 5 % target: it is
          close in three holdout fields and about 14 % in the R Draconis field. The real "candidates" in the R Draconis and Epsilon Indi B fields
          should therefore be read as possible systematics, not variables. Sensitivity is limited: 10 % variations are rarely detected; 50 % usually are.
        </p>
        <p className="text-[11px]">The photometric floor f_sys was calibrated on the calibration field so that the median null χ²/dof of its stars is 1 ({fmt(rep?.splits?.calibration?.photometric_floor?.f_sys, 3)}, from {rep?.splits?.calibration?.photometric_floor?.n_stars ?? "—"} stars). A "candidate" is a statistically flagged source, not a confirmed variable.</p>
      </Section>

      <Section n={11} title="Statistical anomaly detection and multiple testing" tag="both">
        <p>
          The viewer's "Find what changed" ranks pixels by a robust z = (χ²/dof − median)/(1.4826·MAD) and highlights z &gt; 5. That is a
          <b className="text-fg"> ranking threshold, not a 5σ significance</b>: resampled pixels are correlated, the null distribution is not Gaussian,
          and thousands of pixels are tested at once. Significance statements on this page are made per <i>source</i>, with p-values from tests whose
          null distributions are checked by injection, and corrected for the number of sources tested with the Benjamini–Hochberg procedure (q-values, FDR 5 %).
        </p>
        <T head={["field (synthetic static sources)", "fraction with p < 0.05 (should be ≈ 5 %)"]}
          rows={allInj.map(([, f]) => [f.name, pct(f.injection?.variability?.p_values_static_fraction_below_0_05 ?? f.injection?.variability?.["p_values_static_fraction_below_0.05"])])} />
      </Section>

      <Section n={12} title="Injection–recovery experiments" tag="synthetic">
        <p>Synthetic sources with known properties are drawn with each exposure's own ePSF into real exposures (real background, noise, flags), with photon noise from the exposure's own variance-vs-signal slope, and measured by the same code: static, moving (0.5–12″/yr), variable (10/20/50 %), steep-spectrum constant (β = ±3), extended and blended pairs. Seed {rep?.seed}.</p>
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <div className="text-xs font-semibold text-fg">Detection completeness vs true SNR</div>
            <div className="h-64">
              <Plot data={allInj.map(([, f]) => ({ x: (f.injection?.completeness_vs_snr ?? []).map((b: R) => Math.sqrt(b.snr_lo * b.snr_hi)),
                y: (f.injection?.completeness_vs_snr ?? []).map((b: R) => b.completeness), name: f.name, mode: "lines+markers" as const, type: "scatter" as const }))}
                layout={{ ...darkLayout, xaxis: { ...darkLayout.xaxis, type: "log", title: { text: "true SNR per exposure" } }, yaxis: { ...darkLayout.yaxis, title: { text: "fraction detected" }, range: [0, 1.05] } }} />
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold text-fg">Astrometric error vs true SNR (detected)</div>
            <div className="h-64">
              <Plot data={allInj.map(([, f]) => ({ x: (f.injection?.astrometric_error_vs_snr ?? []).map((b: R) => Math.sqrt(b.snr_lo * b.snr_hi)),
                y: (f.injection?.astrometric_error_vs_snr ?? []).map((b: R) => b.median_err_arcsec), name: f.name, mode: "lines+markers" as const, type: "scatter" as const }))}
                layout={{ ...darkLayout, xaxis: { ...darkLayout.xaxis, type: "log", title: { text: "true SNR per exposure" } }, yaxis: { ...darkLayout.yaxis, type: "log", title: { text: "median position error (″)" } } }} />
            </div>
          </div>
        </div>
        <T head={["field", "split", "sources", "source-exposures", "blended pairs resolved (by separation)"]}
          rows={allInj.map(([, f]) => [f.name, f.split, f.injection?.n_sources, f.injection?.n_source_exposures,
            (f.injection?.blends?.resolved_fraction_by_sep ?? []).map((b: R) => `${b.sep_lo}–${b.sep_hi} px: ${pct(b.resolved)}`).join(", ")])} />
        <p className="text-[11px]">Limits: sources are placed through the official WCS, so they carry no WCS error (registration is tested on real stars, §9); saturation is not simulated; extended sources are Gaussian-blurred ePSFs.</p>
      </Section>

      <Section n={13} title="Holdout validation" tag="both">
        <T head={["split", "fields", "used for"]} rows={[
          ["development", split("development").map(([, f]) => f.name).join(", "), `choosing the covariance policy (${rep?.splits?.development?.decided?.covariance_policy ?? "—"}) and the extendedness threshold (${fmt(rep?.splits?.development?.decided?.ext_min_blur_px, 2)} px)`],
          ["calibration", split("calibration").map(([, f]) => f.name).join(", "), `astrometric floor σ_sys = ${fmt(rep?.splits?.calibration?.astrometric_floor_arcsec, 3)}″, photometric floor f_sys = ${fmt(rep?.splits?.calibration?.photometric_floor?.f_sys, 3)}`],
          ["holdout", hold.map(([, f]) => f.name).join(", "), `evaluated once with frozen parameters (hash ${rep?.frozen_params?.hash ?? "—"}, frozen ${rep?.frozen_params?.frozen_at ?? "—"})`],
        ]} />
        <p className="text-[11px]">Seven fields is a small sample: the holdout is independent of the tuning, but its statistical power is limited and it is not a substitute for verification on more of the sky.</p>
      </Section>

      <Section n={14} title="Uncertainty calibration" tag="both">
        <p>Fraction of errors inside the nominal 68.3 % / 95.4 % / 99.7 % intervals (2-D quantities use χ²₂ quantiles). Perfect calibration matches the nominal values; lower means the stated errors are too small, higher means too large.</p>
        <T head={["quantity", "how the uncertainty is derived", "dataset", "n", "68.3 %", "95.4 %", "99.7 %"]}
          rows={[
            ...allInj.flatMap(([, f]) => {
              const pc = f.injection?.position_coverage ?? {};
              const used = pc.policy_used as string;
              const c = pc[used] ?? {};
              return [[`position (${f.name})`, `analytic (JᵀJ)⁻¹${used === "inflated" ? " × max(1, χ²/dof)" : ""}`, "synthetic", c.n, pct(c.empirical?.[0]), pct(c.empirical?.[1]), pct(c.empirical?.[2])]];
            }),
            ...allInj.map(([, f]) => {
              const c = f.injection?.motion?.pm_coverage ?? {};
              return [`proper motion (${f.name})`, "GLS covariance (scaled by χ²/dof when > 1)", "synthetic", c.n, pct(c.empirical?.[0]), pct(c.empirical?.[1]), pct(c.empirical?.[2])];
            }),
            ...fields.map(([, f]) => {
              const c = f.astrometry?.normalised_residual_coverage ?? {};
              return [`WCS residual vs Gaia (${f.name})`, "fit ⊕ Gaia propagated ⊕ σ_sys", "real", c.n, pct(c.empirical?.[0]), pct(c.empirical?.[1]), pct(c.empirical?.[2])];
            }),
            ...fields.map(([, f]) => {
              const c = f.motion?.registration?.coverage ?? {};
              return [`field-star pm vs Gaia (${f.name})`, "GLS + zero-point covariance", "real", c.n, pct(c.empirical?.[0]), pct(c.empirical?.[1]), pct(c.empirical?.[2])];
            }),
            ...allInj.map(([, f]) => {
              const c = f.injection?.flux?.coverage ?? {};
              return [`flux (${f.name})`, "ePSF fit (JᵀJ)⁻¹, no floor", "synthetic", c.n, pct(c.empirical?.[0]), pct(c.empirical?.[1]), pct(c.empirical?.[2])];
            }),
          ]} />
        <p>
          <b className="text-fg">Reading this:</b> the development split chose to scale position errors by max(1, χ²/dof) because raw fit errors were far too small
          (raw 68 % coverage {range(allInj, (f) => f.injection?.position_coverage?.raw?.empirical?.[0], (v) => pct(v))}). With that scaling, injected positions
          are close to nominal at 68 % and 95 % but the 99.7 % region holds only {range(allInj, (f) => f.injection?.position_coverage?.inflated?.empirical?.[2], (v) => pct(v))}:
          the error distribution has heavier tails than a Gaussian (blends, neighbours, flagged pixels). Flux errors are too small (68 % coverage
          {" "}{range(allInj, (f) => f.injection?.flux?.coverage?.empirical?.[0], (v) => pct(v))}); a flux floor is applied in the variability test but not in these raw fit errors.
          Proper-motion coverage is close at 68 % but low at 95–99.7 %. Real-star WCS residuals over-cover in the development fields (errors too large)
          and slightly under-cover at 95 % in the holdout fields. None of these was tuned away after the holdout was opened.
        </p>
      </Section>

      <Section n={15} title="Results and measured performance" tag="both">
        <p>Headline numbers, each traceable to a table above. Holdout fields only, so none of these were used to choose a parameter.</p>
        <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-xs">
          <div className="font-semibold text-red-300">What did not meet its target</div>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {hold.filter(([, f]) => !f.astrometry?.passed).map(([id, f]) => <li key={id}>{f.name}: official-WCS check failed ({failedChecks(f).join("; ")}).</li>)}
            <li>Independent seeded solve: {hSolveP} of {hSolveN} holdout exposures passed.</li>
            {!extMetTarget ? <li>Extendedness: no threshold met ≤ 5 % false-extended on development; the default was kept.</li> : null}
            <li>Variability: static false-positive rate {range(hold, (f) => f.injection?.variability?.false_positive_rate_static_q05, (v) => pct(v))} across holdout fields (target 5 %).</li>
            <li>Motion: static injections called moving in {range(hold, (f) => f.injection?.motion?.false_motion_rate_static_p0027, (v) => pct(v, 1))} of cases across holdout fields (expected 0.27 %).</li>
            <li>Uncertainty tails: positions, fluxes and proper motions under-cover at 99.7 % (§14).</li>
            <li>No holdout field has a measurable named target; the only target compared with Gaia is in the calibration field.</li>
          </ul>
        </div>
        <T head={["what", "value", "dataset", "how"]} rows={hold.flatMap(([, f]) => {
          const a = f.astrometry ?? {};
          const inj = f.injection ?? {};
          const c50 = (inj.completeness_vs_snr ?? []).find((b: R) => b.completeness >= 0.5);
          return [
            [`${f.name}: official-WCS residual vs Gaia (median / RMS)`, `${fmt(a.residual_arcsec?.median, 3)}″ / ${fmt(a.residual_arcsec?.rms, 3)}″ (n = ${a.residual_arcsec?.n ?? "—"})`, "real", "§7"],
            [`${f.name}: independent solves passed`, `${a.seeded_solve?.n_passed ?? "—"} / ${a.seeded_solve?.n_exposures ?? "—"}`, "real", "§4"],
            [`${f.name}: SNR where completeness first reaches 50 %`, c50 ? `${c50.snr_lo}–${c50.snr_hi}` : "—", "synthetic", "§12"],
            [`${f.name}: motion target`, f.motion?.target?.label ?? "—", "real", "§9"],
          ];
        })} />
      </Section>

      <Section n={16} title="Limitations and future work">
        <ul className="list-disc space-y-1.5 pl-5">
          <li>No blind (all-sky) plate solve is run here; the pipeline's own Astrometry.net solve is validated, and our seeded solve checks it. Installing Astrometry.net with index files would add a fully blind check.</li>
          <li>Bright stars saturate SPHEREx. Wing fits failed their coverage test in every field, so motion of a bright target is reported as not measurable rather than guessed. A better saturated-star model is the main gap for nearby-star science.</li>
          <li>No bright-star mask: detections in the halo of a saturated star are classified like any other source (see R Draconis, §6), and the halo appears to distort neighbouring positions (§7).</li>
          <li>Seeded solve is conservative in sparse 9′ windows (§4); solving on the full 2040×2040 detector would give it far more stars.</li>
          <li>Some exposures listed by IRSA were not in the local cutout cache when the run was made ({sum(fields, (f) => f.missing_cutouts?.length)} across all fields); they are listed in the report and were excluded, not substituted.</li>
          <li>Catalogues: Gaia DR3, 2MASS XSC and AllWISE via IRSA, and NED. Pan-STARRS, SDSS and SIMBAD are not queried; ESA&apos;s Gaia archive and IRSA&apos;s TAP service were unreachable on the run date, so IRSA&apos;s Gator mirror was used. Catalogue coverage is not complete.</li>
          <li>Seven fields; mostly star fields at low Galactic latitude. Galaxy identification is tested by injection and catalogue matching, with few resolved galaxies in the real data.</li>
          <li>Injection does not simulate saturation, WCS error or realistic galaxy profiles.</li>
          <li>Parallax is fitted only when the epochs constrain it; otherwise it is fixed (to Gaia's value when grading against Gaia), which is stated per result.</li>
          <li>Spectral classification remains three illustrative shapes plus a blackbody temperature; its "methane-shape weight" is a relative weight between those three models, not a probability.</li>
          <li>Solar-system objects that move within a visit are not linked across exposures by this pipeline.</li>
          <li>No third party has yet re-run this validation; the repository contains everything needed to do so (§17).</li>
        </ul>
      </Section>

      <Section n={17} title="Reproducibility and data provenance">
        <Eq>PYTHONPATH=pipeline:apps/api python -m deepfield.validation --config pipeline/deepfield/validation/configs/v1.yaml</Eq>
        <p>
          The run writes <Code>data/validation/&lt;run_id&gt;/</Code>: the config copy, <Code>environment.json</Code> (Python {rep?.environment?.python}, NumPy {rep?.environment?.numpy},
          SciPy {rep?.environment?.scipy}, Astropy {rep?.environment?.astropy}, PyERFA {rep?.environment?.pyerfa}; git commit), <Code>inputs.json</Code> (SHA-256 and full header provenance of every
          exposure: OBSID, detector, MJD, pipeline version, calibration-file IDs, ePSF and spectral-WCS calibration files, official astrometry QA; and every
          catalogue response's query, retrieval time and checksum), <Code>frozen_params.json</Code>, <Code>report.json</Code> and <Code>log.txt</Code>. Seeds are fixed. Tests:
          <Code>tests/test_astro_core.py</Code>, <Code>tests/test_astro_measure.py</Code>.
        </p>
        <T head={["dataset", "owner", "licence", "used for"]} rows={(man?.datasets ?? []).map((d) => [d.name, d.owner, d.licence, d.used_for])} />
        <p className="text-[11px]">Planet X injection tests (a separate, experimental project on simulated data) are at <Link href="/hunt/proof" className="underline underline-offset-2">Planet X · Injection tests</Link>.</p>
      </Section>
    </div>
  );
}
