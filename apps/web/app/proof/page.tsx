"use client";
import { useEffect, useState } from "react";
import { Plot, darkLayout } from "@/components/Plot";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BundleTag, SourceTag } from "@/components/Tags";
import { getCompleteness, getManifest, getMap, getCandidates } from "@/lib/api";
import type { CompletenessRow, Manifest, MapSummary, Candidate } from "@/lib/types";
import { pct } from "@/lib/utils";

export default function Proof() {
  const [rows, setRows] = useState<CompletenessRow[]>([]);
  const [src, setSrc] = useState("");
  const [man, setMan] = useState<Manifest | null>(null);
  const [map, setMap] = useState<MapSummary | null>(null);
  const [cands, setCands] = useState<Candidate[]>([]);
  useEffect(() => {
    getCompleteness().then((r) => { setRows(r.rows); setSrc(r.source); });
    getManifest().then(setMan);
    getMap().then(setMap);
    getCandidates().then((r) => setCands(r.candidates));
  }, []);
  const mag = rows.filter((r) => r.axis === "mag" && r.patch_id === "ALL");
  const dist = rows.filter((r) => r.axis === "distance_au" && r.patch_id === "ALL");
  const nInj = cands.filter((c) => c.is_simulated).length;
  const recovered = cands.filter((c) => c.is_simulated && c.snr_stack >= 5).length;
  const mag50 = mag.find((r) => r.fraction < 0.5);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold">Proof: how deep we reached, and what we did not</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">Injection tests put synthetic Planet Nines from the Caltech reference population into real SPHEREx frames and run the full search.
          The curves show what fraction we got back. Nothing on this page is a discovery claim.</p>
        <div className="mt-2 flex gap-2"><BundleTag kind={map?.bundle_kind} /><SourceTag source={src} /></div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Completeness vs brightness (injected V mag)</CardTitle></CardHeader>
          <CardContent><div className="h-64">
            <Plot data={[{ x: mag.map((r) => (r.bin_lo + r.bin_hi) / 2), y: mag.map((r) => r.fraction), type: "bar", marker: { color: "#f59e0b" }, name: "recovered fraction",
              text: mag.map((r) => `${r.n_recovered}/${r.n_injected}`), textposition: "outside" }]}
              layout={{ ...darkLayout, xaxis: { ...darkLayout.xaxis, title: { text: "injected V magnitude" } }, yaxis: { ...darkLayout.yaxis, title: { text: "fraction recovered" }, range: [0, 1.15] } }} />
          </div>
          <p className="mt-1 text-[11px] text-muted">SNR ≥ {mag[0]?.snr_threshold ?? 5} in the stack counts as recovered. 50 % limit ≈ V {mag50 ? mag50.bin_lo.toFixed(1) : "—"}.</p></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Completeness vs distance (AU)</CardTitle></CardHeader>
          <CardContent><div className="h-64">
            <Plot data={[{ x: dist.map((r) => (r.bin_lo + r.bin_hi) / 2), y: dist.map((r) => r.fraction), type: "bar", marker: { color: "#60a5fa" }, name: "recovered fraction",
              text: dist.map((r) => `${r.n_recovered}/${r.n_injected}`), textposition: "outside" }]}
              layout={{ ...darkLayout, xaxis: { ...darkLayout.xaxis, title: { text: "injected heliocentric distance (AU)" } }, yaxis: { ...darkLayout.yaxis, title: { text: "fraction recovered" }, range: [0, 1.15] } }} />
          </div></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Honest limits</CardTitle></CardHeader>
        <CardContent className="text-sm">
          <ul className="list-disc space-y-1 pl-5 text-muted">
            <li>SPHEREx pixels are 6.15″ and the PSF is ~7.5″: crowded fields confuse the stack, and a planet sitting on a star is lost.</li>
            <li>We stack inside a single ~12-day SPHEREx visit. Parallax of a 500 AU object over that window is ~84″ (~14 px), so distance is only coarsely constrained; cross-visit linking is not done.</li>
            <li>Only {map?.n_patches_searched ?? "—"} patches of 0.25° have been searched. The Deep Field contribution to the exclusion counter is {map ? pct(map.frac_excluded_deepfield_potential, 4) : "—"} at full crowd verification, which is small by design and stated as such.</li>
            <li>Of {nInj} injected planets shown in the Lab, {recovered} reach stacked SNR ≥ 5. The faint ones are failures and are kept on purpose.</li>
            <li>Spectral template fit uses three toy templates; a methane score is indicative, not a classification.</li>
            <li>The CNN is trained from scratch on our own injections only. If it underperforms the rule-based score, the rule score is what ranks candidates.</li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Data provenance (manifest.yaml)</CardTitle></CardHeader>
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
    </div>
  );
}
