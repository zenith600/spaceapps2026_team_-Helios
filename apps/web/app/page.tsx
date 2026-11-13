"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Globe } from "@/components/Globe";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BundleTag, SourceTag } from "@/components/Tags";
import { getMap, getTargets, fileUrl } from "@/lib/api";
import type { MapSummary, Target } from "@/lib/types";
import { pct } from "@/lib/utils";

export default function Hunt() {
  const [map, setMap] = useState<MapSummary | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    getMap().then(setMap).catch((e) => setErr(String(e)));
    getTargets().then((t) => setTargets(t.targets)).catch(() => {});
  }, []);

  return (
    <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
      <section>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Everyone else looked at the pictures.<br /><span className="text-accent">We searched where the pictures can&apos;t see.</span></h1>
        <p className="mt-3 max-w-prose text-sm text-muted">
          Deep Field stacks SPHEREx exposures along gravity-predicted Planet Nine motions, checks each candidate&apos;s spectrum,
          and lets you vet the results. The globe shows where Planet Nine could still be hiding; green is where we have looked.
        </p>
        <div className="mt-4 overflow-hidden rounded-lg border border-line bg-black">
          <Globe texture={fileUrl("map_equirect.png")} targets={targets} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <SourceTag source={map?.source ?? undefined} />
          <BundleTag kind={map?.bundle_kind} />
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <Card>
          <CardHeader><CardTitle>Planet Nine space ruled out</CardTitle></CardHeader>
          <CardContent>
            {err ? <p className="text-danger text-sm">{err}</p> : null}
            <div className="mono text-5xl font-bold text-accent sm:text-6xl">{map ? pct(map.frac_excluded_total) : "—"}</div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted">
              <dt>by ZTF + DES + Pan-STARRS</dt><dd className="mono text-right text-fg">{map ? pct(map.frac_excluded_prior) : "—"}</dd>
              <dt>by Deep Field (crowd-verified)</dt><dd className="mono text-right text-sim">{map ? pct(map.frac_excluded_deepfield, 4) : "—"}</dd>
              <dt>Deep Field potential at full verification</dt><dd className="mono text-right">{map ? pct(map.frac_excluded_deepfield_potential, 4) : "—"}</dd>
              <dt>patches searched</dt><dd className="mono text-right text-fg">{map?.n_patches_searched ?? "—"}</dd>
              <dt>votes so far</dt><dd className="mono text-right text-fg">{map?.n_votes ?? "—"}</dd>
            </dl>
            <p className="mt-3 text-[11px] leading-snug text-muted">{map?.explanation}</p>
            <p className="mt-1 text-[10px] text-muted mono">population: {map?.population_version ?? "—"} · map epoch MJD {map?.epoch_mjd ?? "—"} · HEALPix nside {map?.nside}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Searched patches</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-2">
            {(map?.patches ?? targets).map((t) => (
              <div key={t.patch_id} className="flex items-center justify-between rounded border border-line px-3 py-2 text-xs">
                <div>
                  <div className="font-semibold">{t.patch_id} <span className="text-muted">· {t.visit_label}</span></div>
                  <div className="mono text-muted">RA {t.ra_deg.toFixed(3)}° Dec {t.dec_deg.toFixed(3)}° · {t.n_exposures} exposures</div>
                </div>
                <div className="text-right">
                  <div className="mono">{t.status}</div>
                  {typeof t.crowd_credit === "number" ? <div className="mono text-sim">crowd {pct(t.crowd_credit, 0)}</div> : null}
                </div>
              </div>
            ))}
            {targets[0] ? <SourceTag source={targets[0].source} /> : null}
          </CardContent>
        </Card>

        <div className="flex gap-2">
          <Button asChild><Link href="/lab">Open the Candidate Lab</Link></Button>
          <Button asChild variant="outline"><Link href="/classify">Classify on your phone</Link></Button>
        </div>
      </section>
    </div>
  );
}
