"use client";
import dynamic from "next/dynamic";
import type { PlotParams } from "react-plotly.js";

// plotly.js is browser-only; load it client side only.
const PlotInner = dynamic(async () => {
  const [{ default: createPlotlyComponent }, Plotly] = await Promise.all([
    import("react-plotly.js/factory"),
    import("plotly.js-dist-min"),
  ]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createPlotlyComponent(Plotly as any);
}, { ssr: false, loading: () => <div className="h-64 animate-pulse rounded bg-panel" /> });

export const darkLayout: Partial<Plotly.Layout> = {
  paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
  font: { color: "#8b91a3", family: "JetBrains Mono, ui-monospace, monospace", size: 11 },
  margin: { l: 50, r: 10, t: 10, b: 40 },
  xaxis: { gridcolor: "#1c2030", zerolinecolor: "#1c2030" },
  yaxis: { gridcolor: "#1c2030", zerolinecolor: "#1c2030" },
  legend: { orientation: "h", y: -0.25 },
};

export function Plot(props: PlotParams) {
  return <PlotInner useResizeHandler style={{ width: "100%", height: "100%" }} config={{ displayModeBar: false, responsive: true }} {...props} />;
}
