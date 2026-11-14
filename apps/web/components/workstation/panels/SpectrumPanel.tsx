"use client";
// The existing SkySpectrum component, unchanged, wired to the workstation's probe. It is
// memoised on its own inputs so playback and panning never re-run the plot.
import { memo } from "react";
import { Pipette } from "lucide-react";
import { SkySpectrum } from "@/components/SkySpectrum";
import type { SkyBundle } from "@/lib/sky";
import { type Pixel, useWS } from "../context";
import { Empty } from "../ui";

const Spectrum = memo(function Spectrum({ bundle, pixel, radius, onRadius, onJump }: {
  bundle: SkyBundle; pixel: Pixel | null; radius: number; onRadius: (r: number) => void; onJump: (p: Pixel) => void;
}) {
  return (
    <div className="ws-spectrum px-2 py-2">
      <SkySpectrum bundle={bundle} pixel={pixel} radius={radius} onRadius={onRadius} onJump={onJump} />
    </div>
  );
});

export function SpectrumPanel() {
  const ws = useWS();
  if (!ws.bundle) return <Empty icon={Pipette}>Open a field, then click a pixel with the spectral probe (I).</Empty>;
  return <Spectrum bundle={ws.bundle} pixel={ws.doc.pixel} radius={ws.doc.radius} onRadius={ws.setRadius} onJump={ws.pick} />;
}
