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
            "n_exposures": s["n_exposures"], "n_excluded": s["n_excluded"],
            "quality": {k: s["quality"][k] for k in ("n_usable", "n_exposures", "flags", "saturated")},
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
    write_classify_fixture()
    write_change_fixture(src)
    return 0


def write_change_fixture(src: Path) -> None:
    """Reference output of change_map on the real bundle, for the browser port to match."""
    import numpy as np

    from deepfield.sky.analyse import change_map, change_peaks
    with np.load(src / "cube.npz", allow_pickle=True) as z:
        cm = change_map(z["flux"], z["var"], z["good"], z["wave_um"])
    out = Path(__file__).resolve().parents[1] / "apps" / "web" / "lib" / "__fixtures__" / "change.json"
    out.write_text(json.dumps({
        "generated_by": "scripts/make_spectrum_fixture.py",
        "slug": SLUG,
        "note": "Python change_map on float32 flux. The browser runs on the uint16 cube, so "
                "values agree to quantisation; peak positions must agree exactly.",
        "median": cm["median"], "mad": cm["mad"], "n_significant": cm["n_significant"],
        "peaks": change_peaks(cm, max_peaks=12),
    }, indent=1))
    print(f"wrote {out}")


def write_classify_fixture() -> None:
    """Reference values for the template fit, which the browser reimplements in TypeScript."""
    import numpy as np

    from deepfield.sky.analyse import classify_point
    from deepfield.spectral.templates import template_fnu

    out = Path(__file__).resolve().parents[1] / "apps" / "web" / "lib" / "__fixtures__" / "classify.json"
    rng = np.random.default_rng(7)
    waves = np.array([0.80, 0.95, 1.10, 1.25, 1.45, 1.70, 2.00, 2.35, 2.80, 3.30, 4.10, 4.80])
    cases = []
    for kind, scale, noise in (("planet", 3.0, 0.02), ("asteroid", 2.0, 0.02),
                               ("star", 5.0, 0.03), ("star", 5.0, 0.30)):
        flux = scale * template_fnu(kind, waves) + rng.normal(0, noise, waves.size)
        err = np.full(waves.size, max(noise, 1e-3))
        pts = [{"wave_um": float(w), "flux_mjysr": float(f), "flux_err_mjysr": float(e),
                "bandwidth_um": 0.01, "mjd": 60800.0, "detector": 1, "visit": 0,
                "obs_id": "SYN", "n_pixels": 1}
               for w, f, e in zip(waves, flux, err)]
        res = classify_point(pts)
        cases.append({
            "truth": kind, "noise": noise,
            "points": [{k: p[k] for k in ("wave_um", "flux_mjysr", "flux_err_mjysr")} for p in pts],
            "expect": {k: res[k] for k in ("available", "best", "label", "confident", "n_bands")},
            "methane_score": res.get("methane_score"),
            "temperature_k": (res.get("temperature") or {}).get("temperature_k"),
            "ranking": res.get("ranking"),
        })
    # and the "too few colours" refusal
    few = [{"wave_um": 1.0 + 0.001 * i, "flux_mjysr": 1.0, "flux_err_mjysr": 0.1,
            "bandwidth_um": 0.01, "mjd": 1.0, "detector": 1, "visit": 0, "obs_id": "S",
            "n_pixels": 1} for i in range(4)]
    cases.append({"truth": "too-few-bands", "noise": 0.0,
                  "points": [{k: p[k] for k in ("wave_um", "flux_mjysr", "flux_err_mjysr")} for p in few],
                  "expect": {k: classify_point(few).get(k) for k in ("available",)},
                  "methane_score": None, "temperature_k": None, "ranking": None})
    out.write_text(json.dumps({
        "generated_by": "scripts/make_spectrum_fixture.py",
        "note": "Python reference for the template fit. apps/web/lib/spectralFit.test.ts must match.",
        "cases": cases}, indent=1))
    print(f"wrote {out} ({len(cases)} classification cases)")


if __name__ == "__main__":
    raise SystemExit(main())
