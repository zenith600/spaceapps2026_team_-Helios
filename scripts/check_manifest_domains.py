#!/usr/bin/env python
"""CI check: fail if any source file references a network host that is not in manifest.yaml.

Scans .py, .ts, .tsx, .js, .yml, .yaml, .toml, .json, Dockerfile under the repo
(excluding node_modules, .venv, data/, .next) for http(s):// URLs and bare
hostnames inside quotes, and compares the hostnames against the manifest.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {"node_modules", ".venv", ".next", "data", ".git", "out", "__pycache__", ".pytest_cache"}
EXTS = {".py", ".ts", ".tsx", ".js", ".mjs", ".yml", ".yaml", ".toml", ".json", ".md", ".sql", ""}
URL_RE = re.compile(r"https?://([A-Za-z0-9.-]+\.[A-Za-z]{2,})(?::\d+)?")

# Hosts that are tooling, not data: package registries, docs, licences, schema URLs.
TOOLING_HOSTS = {
    "pypi.org", "download.pytorch.org", "registry.npmjs.org", "github.com",
    "json.schemastore.org", "nextjs.org", "fonts.googleapis.com", "fonts.gstatic.com",
    "ui.shadcn.com", "tailwindcss.com", "docs.astral.sh", "fly.io", "vercel.com",
    "supabase.com", "www.spaceappschallenge.org", "doi.org", "ivoa.net",
    "caltech-ipac.github.io", "registry.opendata.aws", "creativecommons.org",
    "opensource.org", "hermes-agent.nousresearch.com", "arxiv.org", "iopscience.iop.org",
    "ui.adsabs.harvard.edu", "www.zooniverse.org", "www.w3.org", "schemas.openapis.org",
}


def allowed() -> set[str]:
    m = yaml.safe_load((ROOT / "manifest.yaml").read_text(encoding="utf-8"))
    doms: set[str] = set()
    for ds in m["datasets"]:
        doms.update(ds.get("domains", []))
    doms.update(m.get("infrastructure_domains", []))
    return {d.lower() for d in doms}


def host_ok(host: str, allow: set[str]) -> bool:
    h = host.lower()
    if h in allow or h in TOOLING_HOSTS:
        return True
    return any(h.endswith("." + d) for d in allow | TOOLING_HOSTS)


def main() -> int:
    allow = allowed()
    bad: list[tuple[Path, int, str]] = []
    for path in ROOT.rglob("*"):
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if not path.is_file() or path.suffix not in EXTS:
            continue
        if path.name == "manifest.yaml" or path.name.endswith(".lock") or path.name == "package-lock.json":
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            for m in URL_RE.finditer(line):
                if not host_ok(m.group(1), allow):
                    bad.append((path.relative_to(ROOT), lineno, m.group(1)))
    if bad:
        print("Hosts referenced in code but not in manifest.yaml:")
        for p, n, h in bad:
            print(f"  {p}:{n}: {h}")
        return 1
    print(f"manifest check OK ({len(allow)} allowed domains)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
