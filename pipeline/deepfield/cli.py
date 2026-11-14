"""Deep Field pipeline CLI.

  python -m deepfield.cli sample            write the fake SAMPLE bundle to data/samples and export it for the web app
  python -m deepfield.cli targets           rank HEALPix cells, check SPHEREx coverage, write data/work/targets.json
  python -m deepfield.cli run [--patches N] search the chosen patches (fetch, stack, inject) into data/work/
  python -m deepfield.cli build             assemble data/release from data/work (completeness, CNN, dossiers, map)
  python -m deepfield.cli export [dir]      export a bundle (default data/release) to apps/web/public/demo
  python -m deepfield.cli all               targets + run + build + export

Sky Viewer (the public coordinate-entry tool):
  python -m deepfield.cli sky releases          which SPHEREx collections IRSA publishes today
  python -m deepfield.cli sky search "<query>"  what SPHEREx has at a position (no downloads)
  python -m deepfield.cli sky build "<query>"   build one view -> data/sky/<slug>/
  python -m deepfield.cli sky bake [--refresh]  build + export the challenge test targets
  python -m deepfield.cli sky fresh <slug>      has new data landed since that view was built?
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from deepfield.config import DATA_DIR, PATCH_COUNT, PATCH_MAX_EXPOSURES, PATCH_RADIUS_DEG, SAMPLES_DIR, WORK_DIR

log = logging.getLogger("deepfield.cli")


def cmd_sample(_args):
    from deepfield.contracts import write_sample_bundle
    from deepfield.export_demo import export
    print(write_sample_bundle(SAMPLES_DIR))
    print(export(SAMPLES_DIR))


def choose_targets(n_patches: int, n_candidates: int = 12, map_mjd: float = 60900.0) -> list[dict]:
    """Rank cells by surviving probability, keep those with a usable SPHEREx DR1 visit, return the top n."""
    from deepfield.data.spherex import best_visit, sia_search
    from deepfield.prior.priormap import build_prior_map
    prior, meta = build_prior_map(map_mjd)
    top = prior.sort_values("n_surviving", ascending=False).head(n_candidates)
    out = []
    for _, r in top.iterrows():
        try:
            sia = sia_search(float(r.ra_deg), float(r.dec_deg), PATCH_RADIUS_DEG)
            if len(sia) == 0:
                log.info("cell %d: no DR1 coverage", r.hpix)
                continue
            v = best_visit(sia, 10_000)
            span = float(v.t_max.max() - v.t_min.min())
            n = int(len(v))
        except Exception as exc:
            log.warning("cell %d: coverage check failed: %s", r.hpix, exc)
            continue
        score = float(r.p_surviving) * min(n, PATCH_MAX_EXPOSURES) * (1.0 if span >= 3 else 0.3)
        out.append({"hpix": int(r.hpix), "ra_deg": float(r.ra_deg), "dec_deg": float(r.dec_deg), "p_surviving": float(r.p_surviving),
                    "n_surviving": int(r.n_surviving), "n_exposures_visit": n, "visit_span_days": span, "score": score})
        log.info("cell %d (%.2f, %.2f): %d exposures in best visit, span %.1f d, score %.4f", r.hpix, r.ra_deg, r.dec_deg, n, span, score)
    out.sort(key=lambda d: -d["score"])
    chosen = out[:n_patches]
    for i, c in enumerate(chosen):
        c["patch_id"] = f"P{i + 1:03d}"
    return chosen


def cmd_targets(args):
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    chosen = choose_targets(args.patches)
    (WORK_DIR / "targets.json").write_text(json.dumps(chosen, indent=1))
    print(json.dumps(chosen, indent=1))


def cmd_run(args):
    from deepfield.run_patch import search_patch
    tf = WORK_DIR / "targets.json"
    if not tf.exists():
        cmd_targets(args)
    targets = json.loads(tf.read_text())[: args.patches]
    for t in targets:
        if (WORK_DIR / t["patch_id"] / "summary.json").exists() and not args.force:
            log.info("%s already searched, skipping (use --force)", t["patch_id"])
            continue
        search_patch(t["patch_id"], t["ra_deg"], t["dec_deg"], WORK_DIR, n_inject_runs=args.inject_runs,
                     n_per_run=args.inject_per_run, seed=int(t["hpix"]), max_exposures=args.max_exposures)


def cmd_build(_args):
    from deepfield.build_bundle import build
    info = build(WORK_DIR, DATA_DIR)
    print(json.dumps({k: v for k, v in info.items() if k != "patches"}, indent=1, default=str))


def cmd_export(args):
    from deepfield.export_demo import export
    src = Path(args.dir) if args.dir else DATA_DIR
    print(export(src))


# ---------------------------------------------------------------------------
# Sky Viewer
# ---------------------------------------------------------------------------

def _progress_printer():
    def cb(done, total, msg):
        bar = f"[{done}/{total}]" if total else "[*]"
        print(f"  {bar} {msg}", flush=True)
    return cb


def cmd_sky_releases(args):
    from deepfield.sky import releases as REL
    info = REL.discover(force=args.force)
    print(json.dumps(info, indent=1))


def cmd_sky_search(args):
    from deepfield.sky.resolver import resolve
    from deepfield.sky.service import search_epochs, select_exposures, visit_table
    t = resolve(args.query, allow_network=not args.offline)
    print(f"{t.name}  RA {t.ra_deg:.5f}  Dec {t.dec_deg:+.5f}  (resolver: {t.resolver})")
    if t.note:
        print(f"  {t.note}")
    df, meta = search_epochs(t.ra_deg, t.dec_deg, args.fov)
    print(f"\ncollections searched: {', '.join(meta['collections_searched'])}")
    print(f"collections available: {', '.join(meta['collections_available'])}  [{meta['collection_source']}]")
    if len(df) == 0:
        print("\nno SPHEREx exposures cover this position yet")
        return
    print(f"\n{meta['n_exposures']} exposures, {meta['n_visits']} visits, "
          f"MJD {meta['mjd_min']:.2f} - {meta['mjd_max']:.2f} "
          f"({meta['mjd_max'] - meta['mjd_min']:.0f} day baseline), detectors {meta['detectors']}")
    for v in visit_table(df):
        print(f"  visit {v['visit']:>2}  {v['label']:<10} {v['n_exposures']:>4} exp  "
              f"MJD {v['mjd_start']:.2f}-{v['mjd_end']:.2f}  D{v['detectors']}")
    sel = select_exposures(df, args.max_frames, args.per_visit)
    print(f"\na build with --max-frames {args.max_frames} would fetch {len(sel)} exposures "
          f"(~{len(sel) * 4.3:.0f} MB, ~{len(sel) * 12 / 6 / 60:.1f} min at {6} workers)")


def cmd_sky_build(args):
    from deepfield.sky.resolver import resolve
    from deepfield.sky.service import SkyRequest, build_sky_bundle
    t = resolve(args.query, allow_network=not args.offline)
    req = SkyRequest(t.ra_deg, t.dec_deg, args.fov, max_frames=args.max_frames,
                     per_visit=args.per_visit, target=t)
    b = build_sky_bundle(req, progress=_progress_printer())
    c = b["coverage"]
    print(f"\n{b['slug']}")
    print(f"  {c['n_used']} frames from {c['n_exposures_available']} available, {c['n_visits']} visits, "
          f"{c['baseline_days']:.0f} day baseline")
    print(f"  {c['n_bands']} of {c['bands_total']} bands, {c['wave_min_um']:.2f}-{c['wave_max_um']:.2f} um, "
          f"detectors {c['detectors']}")
    print(f"  -> {SkyRequest(t.ra_deg, t.dec_deg, args.fov, target=t).slug}/sky.json")


def cmd_sky_bake(args):
    from deepfield.sky.bake import bake_featured
    res = bake_featured(fov_deg=args.fov, max_frames=args.max_frames, force=args.force,
                        refresh=args.refresh, queries=args.targets or None)
    for e in res["targets"]:
        print(f"  {e['status']:<7} {e['name']:<22} {e['n_frames']:>3} frames  "
              f"{e['n_visits']} visits  {e['n_bands']:>2}/{e['bands_total']} bands  "
              f"{e['baseline_days']:.0f} d")
    for f in res["failures"]:
        print(f"  FAILED  {f['query']}: {f['error']}")
    if res["failures"]:
        sys.exit(1)


def cmd_sky_fresh(args):
    from deepfield.sky.service import SKY_DIR, bundle_freshness
    slugs = [args.slug] if args.slug else [p.name for p in SKY_DIR.glob("*") if (p / "sky.json").exists()]
    for s in slugs:
        try:
            print(json.dumps(bundle_freshness(SKY_DIR / s), indent=1))
        except Exception as exc:
            print(f"{s}: {type(exc).__name__}: {exc}")


def _add_sky(sub):
    sky = sub.add_parser("sky", help="the public coordinate-entry sky viewer")
    s2 = sky.add_subparsers(dest="skycmd", required=True)

    p = s2.add_parser("releases"); p.add_argument("--force", action="store_true")
    p.set_defaults(fn=cmd_sky_releases)

    def common(p):
        p.add_argument("query", help="object name or coordinates")
        p.add_argument("--fov", type=float, default=0.1, help="field of view in degrees (0.02-0.5)")
        p.add_argument("--max-frames", type=int, default=48)
        p.add_argument("--per-visit", type=int, default=16)
        p.add_argument("--offline", action="store_true", help="built-in catalogue only, no Sesame")
        return p

    common(s2.add_parser("search")).set_defaults(fn=cmd_sky_search)
    common(s2.add_parser("build")).set_defaults(fn=cmd_sky_build)

    p = s2.add_parser("bake")
    p.add_argument("targets", nargs="*", help="default: the five challenge test targets")
    p.add_argument("--fov", type=float, default=0.1)
    p.add_argument("--max-frames", type=int, default=48)
    p.add_argument("--force", action="store_true", help="rebuild even if up to date")
    p.add_argument("--refresh", action="store_true", help="rebuild only where new data landed")
    p.set_defaults(fn=cmd_sky_bake)

    p = s2.add_parser("fresh"); p.add_argument("slug", nargs="?")
    p.set_defaults(fn=cmd_sky_fresh)


def main(argv=None):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    ap = argparse.ArgumentParser(prog="deepfield")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("sample").set_defaults(fn=cmd_sample)
    p = sub.add_parser("targets"); p.add_argument("--patches", type=int, default=PATCH_COUNT); p.set_defaults(fn=cmd_targets)
    p = sub.add_parser("run"); p.add_argument("--patches", type=int, default=PATCH_COUNT); p.add_argument("--force", action="store_true")
    p.add_argument("--inject-runs", type=int, default=4); p.add_argument("--inject-per-run", type=int, default=8)
    p.add_argument("--max-exposures", type=int, default=PATCH_MAX_EXPOSURES); p.set_defaults(fn=cmd_run)
    sub.add_parser("build").set_defaults(fn=cmd_build)
    p = sub.add_parser("export"); p.add_argument("dir", nargs="?"); p.set_defaults(fn=cmd_export)
    p = sub.add_parser("all"); p.add_argument("--patches", type=int, default=PATCH_COUNT); p.add_argument("--force", action="store_true")
    p.add_argument("--inject-runs", type=int, default=4); p.add_argument("--inject-per-run", type=int, default=8)
    p.add_argument("--max-exposures", type=int, default=PATCH_MAX_EXPOSURES); p.add_argument("dir", nargs="?")
    p.set_defaults(fn=lambda a: (cmd_targets(a), cmd_run(a), cmd_build(a), cmd_export(a)))
    _add_sky(sub)
    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
