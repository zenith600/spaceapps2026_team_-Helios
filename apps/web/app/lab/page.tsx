"use client";
import { useEffect, useState } from "react";
import { BlinkViewer } from "@/components/BlinkViewer";
import { BrowserClassifier } from "@/components/BrowserClassifier";
import { Plot, darkLayout } from "@/components/Plot";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SimTag, SourceTag } from "@/components/Tags";
import { getCandidate, getCandidates } from "@/lib/api";
import type { Candidate, Dossier, SpectrumRow } from "@/lib/types";
import { cn, fmt } from "@/lib/utils";

export default function Lab() {
  const [cands, setCands] = useState<Candidate[]>([]);
  const [src, setSrc] = useState<string>("");
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ candidate: Candidate; spectrum: SpectrumRow[]; dossier: Dossier | null; spectrum_source: string } | null>(null);

  useEffect(() => {
    getCandidates().then((r) => { setCands(r.candidates); setSrc(r.source); if (r.candidates[0]) setSel(r.candidates[0].candidate_id); });
  }, []);
  useEffect(() => { if (sel) getCandidate(sel).then(setDetail); }, [sel]);

  const c = detail?.candidate;
  const sp = detail?.spectrum ?? [];

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <aside className="flex flex-col gap-1">
        <div className="mb-1 flex items-center justify-between text-xs text-muted"><span>{cands.length} candidates</span><SourceTag source={src} /></div>
        <div className="max-h-[70vh] overflow-auto rounded border border-line">
          {cands.map((k) => (
            <button key={k.candidate_id} onClick={() => setSel(k.candidate_id)}
              className={cn("flex w-full items-center justify-between border-b border-line px-3 py-2 text-left text-xs hover:bg-panel", sel === k.candidate_id && "bg-panel")}>
              <div>
                <div className="font-semibold">{k.candidate_id} <span className="text-muted">{k.patch_id}</span></div>
                <div className="mono text-muted">stack SNR {fmt(k.snr_stack, 1)} · single {fmt(k.snr_single_max, 1)}</div>
              </div>
              {k.is_simulated ? <Badge variant="sim">sim</Badge> : <Badge>{k.status}</Badge>}
            </button>
          ))}
        </div>
      </aside>

      <section className="flex flex-col gap-4">
        {c ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold">{c.candidate_id}</h1>
              <SimTag show={c.is_simulated} text="Simulated injection — not a discovery" />
              <Badge>{c.status}</Badge>
              {c.known_object ? <Badge variant="danger">known: {c.known_object}</Badge> : null}
              <span className="mono text-xs text-muted">RA {c.ra_deg.toFixed(4)}° Dec {c.dec_deg.toFixed(4)}° · patch {c.patch_id}</span>
            </div>

            <Card>
              <CardHeader><CardTitle>Invisible in single frames, recovered in the stack</CardTitle></CardHeader>
              <CardContent>
                <BlinkViewer stamps={c.stamps} isSimulated={c.is_simulated} source={c.source} />
                <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
                  <Stat k="best single-frame SNR" v={fmt(c.snr_single_max, 1)} />
                  <Stat k="stacked SNR" v={fmt(c.snr_stack, 1)} accent />
                  <Stat k="epochs stacked" v={String(c.n_epochs)} />
                  <Stat k="best trial distance" v={`${fmt(c.best_distance_au, 0)} AU`} />
                  <Stat k="trial rate RA" v={`${fmt(c.best_rate_ra_arcsec_day, 2)} ″/d`} />
                  <Stat k="trial rate Dec" v={`${fmt(c.best_rate_dec_arcsec_day, 2)} ″/d`} />
                  <Stat k="stacked flux" v={`${fmt(c.flux_mjysr * 1000, 2)} kJy/sr`} />
                  {c.is_simulated ? <Stat k="injected (truth)" v={`V≈${fmt(c.injected_mag, 1)} @ ${fmt(c.injected_distance_au, 0)} AU`} sim /> : <Stat k="injected" v="no" />}
                </dl>
              </CardContent>
            </Card>

            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader><CardTitle>Spectral check · {c.n_bands} of 102 SPHEREx bands</CardTitle></CardHeader>
                <CardContent>
                  <div className="h-64">
                    <Plot
                      data={[
                        { x: sp.map((r) => r.wavelength_um), y: sp.map((r) => r.flux_mjysr), error_y: { type: "data", array: sp.map((r) => r.flux_err_mjysr), visible: true, color: "#8b91a3" },
                          mode: "markers", type: "scatter", name: "measured", marker: { color: "#e6e8ee", size: 6 } },
                        { x: sp.map((r) => r.wavelength_um), y: sp.map((r) => r.model_planet), mode: "lines", type: "scatter", name: "cold planet (CH₄)", line: { color: "#f59e0b" } },
                        { x: sp.map((r) => r.wavelength_um), y: sp.map((r) => r.model_asteroid), mode: "lines", type: "scatter", name: "asteroid", line: { color: "#60a5fa", dash: "dot" } },
                        { x: sp.map((r) => r.wavelength_um), y: sp.map((r) => r.model_star), mode: "lines", type: "scatter", name: "star", line: { color: "#8b91a3", dash: "dash" } },
                      ]}
                      layout={{ ...darkLayout, xaxis: { ...darkLayout.xaxis, title: { text: "wavelength (µm)" } }, yaxis: { ...darkLayout.yaxis, title: { text: "flux (MJy/sr)" } } }}
                    />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                    <span>methane score <span className="mono text-accent">{fmt(c.methane_score, 2)}</span></span>
                    <span>best template <span className="mono">{c.template_best}</span></span>
                    <SourceTag source={detail?.spectrum_source} />
                  </div>
                  <p className="mt-1 text-[10px] text-muted">Simple three-template fit (reflected sunlight with 3.3 µm CH₄ absorption / plain reflected sunlight / stellar). Score = relative likelihood of the planet template. Indicative only.</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle>Scores</CardTitle></CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <dl className="grid grid-cols-2 gap-y-1 text-xs">
                    <Stat k="CNN (trained from scratch on injections)" v={c.ml_score == null ? "—" : fmt(c.ml_score, 2)} />
                    <Stat k="rule-based score" v={fmt(c.rule_score, 2)} />
                    <Stat k="crowd P(real)" v={fmt(c.crowd_p_real, 2)} />
                    <Stat k="votes" v={String(c.n_votes)} />
                  </dl>
                  <BrowserClassifier candidate={c} />
                  <SourceTag source={c.source} className="block" />
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader><CardTitle>AI astronomer dossier <span className="text-muted">· {detail?.dossier?.generator ?? "none"}</span></CardTitle></CardHeader>
              <CardContent>
                {detail?.dossier ? <DossierView d={detail.dossier} /> : <p className="text-xs text-muted">No dossier for this candidate.</p>}
              </CardContent>
            </Card>
          </>
        ) : <p className="text-sm text-muted">Loading…</p>}
      </section>
    </div>
  );
}

function Stat({ k, v, accent, sim }: { k: string; v: string; accent?: boolean; sim?: boolean }) {
  return (<><dt className="text-muted">{k}</dt><dd className={cn("mono", accent && "text-accent", sim && "text-sim")}>{v}</dd></>);
}

function DossierView({ d }: { d: Dossier }) {
  return (
    <div className="grid gap-3 text-xs md:grid-cols-3">
      <div><div className="mb-1 font-semibold text-accent">Scout</div><p>{d.scout.summary}</p>
        <ul className="mt-1 list-disc pl-4 text-muted">{d.scout.facts.map((f, i) => <li key={i}>{f}</li>)}</ul></div>
      <div><div className="mb-1 font-semibold text-accent">Skeptic</div>
        <ul className="space-y-1">{d.skeptic.checks.map((c) => <li key={c.name}><span className="mono text-muted">{c.name}:</span> {c.result}</li>)}</ul>
        <p className="mt-1">verdict: <span className="mono">{d.skeptic.verdict}</span></p></div>
      <div><div className="mb-1 font-semibold text-accent">Reporter</div><p className="font-semibold">{d.reporter.headline}</p>
        <p className="mt-1 whitespace-pre-wrap text-muted">{d.reporter.dossier_md}</p>
        {d.is_simulated ? <p className="mt-2 text-sim">SIMULATED — no MPC report is produced for injections.</p> : null}</div>
      <div className="md:col-span-3 text-[10px] text-muted mono">verdict {d.verdict} · confidence {d.confidence.toFixed(2)} · generated {d.generated_at} · sources: {d.sources.join("; ")}</div>
    </div>
  );
}
