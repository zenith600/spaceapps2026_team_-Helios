"""Write the Python reference spectra that the browser decoder is tested against.

The web app computes spectra in the browser from a quantised uint16 cube; the API
computes them in Python from the float32 cube. Those two answers must agree, or the
same click gives different science depending on how the app is deployed.

This script freezes the Python answer for a few pixels of a real baked bundle into a
fixture, which apps/web/lib/sky.cube.test.ts then reproduces in TypeScript.

    python scripts/make_spectrum_fixture.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))

from deepfield.sky.service import SKY_DIR, load_bundle, spectrum_at  # noqa: E402

SLUG = "ra133.7951-dec-7.2451-fov0.100"          # WISE 0855, the brief's own test target
OUT = Path(__file__).resolve().parents[1] / "apps" / "web" / "lib" / "__fixtures__" / "spectrum.json"


def main() -> int:
    src = SKY_DIR / SLUG
    if not (src / "cube.npz").exists():
        print(f"no built bundle at {src}; run: python -m deepfield.cli sky bake", file=sys.stderr)
        return 1
    meta = load_bundle(src)
    n = meta["npix"]
    cases = []
    for (x, y, r) in [(n // 2, n // 2, 0), (n // 2, n // 2, 1), (n // 2, n // 2, 2),
                      (3, 3, 1), (n - 4, n - 4, 0), (10, 40, 1)]:
        s = spectrum_at(src, x, y, r)
        cases.append({
            "x": s["x"], "y": s["y"], "r": s["r"],
            "ra_deg": s["ra_deg"], "dec_deg": s["dec_deg"],
            "n_points": s["n_points"], "n_bands": s["n_bands"],
            "points": [{k: p[k] for k in ("wave_um", "flux_mjysr", "flux_err_mjysr",
                                          "detector", "visit", "n_pixels", "obs_id")}
                       for p in s["points"]],
        })
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "generated_by": "scripts/make_spectrum_fixture.py",
        "slug": SLUG,
        "note": "Python reference. apps/web/lib/sky.cube.test.ts must reproduce these from cube.u16.",
        "cases": cases,
    }, indent=1))
    print(f"wrote {OUT} ({len(cases)} cases, {sum(c['n_points'] for c in cases)} points)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
