"""Deep Field pipeline CLI.

  python -m deepfield.cli sample            write the fake SAMPLE bundle to data/samples and export it for the web app
  python -m deepfield.cli targets           rank HEALPix cells, check SPHEREx coverage, write data/work/targets.json
  python -m deepfield.cli run [--patches N] search the chosen patches (fetch, stack, inject) into data/work/
  python -m deepfield.cli build             assemble data/release from data/work (completeness, CNN, dossiers, map)
  python -m deepfield.cli export [dir]      export a bundle (default data/release) to apps/web/public/demo
  python -m deepfield.cli all               targets + run + build + export
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
    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
