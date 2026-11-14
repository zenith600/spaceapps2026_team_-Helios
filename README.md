# Deep Field — SPHEREx Sky Viewer + Planet X search

NASA Space Apps 2026 entry.

**Type a position, watch that patch of sky change.** The Sky Viewer at `/sky` is the
answer to the challenge objective: enter Right Ascension and declination (or a name),
and every SPHEREx visit to that patch plays back as a little video, so anything that
moves or varies stands out against everything that does not.

Behind it sits the second act — *everyone else looked at the pictures, we searched where
the pictures can't see* — stacking SPHEREx exposures along gravity-predicted Planet Nine
motions, checking each candidate's spectrum, and letting the public vet the results.

Everything simulated is labelled **Simulated**; nothing here is a discovery.

```
/sky?q=Barnard%27s+Star
/sky?ra=133.79513&dec=-7.24515&fov=0.1&mode=visits
```

The five targets named in the challenge brief are pre-built from real IRSA data and open
instantly, with no API and no network:

| Target | frames | visits | baseline | bands |
| --- | --- | --- | --- | --- |
| Barnard's Star | 42 | 16 | 403 d | 39 / 102 |
| Epsilon Indi Ba/Bb | 55 | 19 | 526 d | 49 / 102 |
| WISE 0855−0714 | 44 | 11 | 374 d | 41 / 102 |
| RW Aurigae | 42 | 7 | 380 d | 42 / 102 |
| R Draconis | 91 | 31 | 426 d | 81 / 102 |

Any other coordinate is fetched live from IRSA when the API is running.

Docs: [docs/SKY.md](docs/SKY.md) (how the viewer works) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
[docs/PLAN.md](docs/PLAN.md) · [docs/STATUS.md](docs/STATUS.md) (what works, what is faked, what is blocked).

## One-command local run (DEMO_MODE, no network needed)

```bash
docker compose up --build
# web  http://localhost:3000   (reads frozen files in apps/web/public/demo)
# api  http://localhost:8000   (/sky/* /map /candidates /task /vote /completeness /manifest)
#      the Sky Viewer opens the five pre-built targets with no API and no network
```

## Development

```bash
# python (3.12) — pipeline + api
uv venv --python 3.12 .venv && uv pip install --python .venv/Scripts/python.exe -r pipeline/requirements.txt -r apps/api/requirements.txt
export PYTHONPATH="pipeline;apps/api"       # ":" on Linux/macOS
python -m pytest tests -q                   # coordinates/time, stacking recovery, consensus, API routes
python scripts/check_manifest_domains.py    # allowlist check (also runs in CI)
uvicorn deepfield_api.main:app --reload     # API on :8000 (DEMO_MODE=1 by default; DATA_DIR=data/release)

# web
cd apps/web && npm ci && npm run dev        # http://localhost:3000, NEXT_PUBLIC_DEMO_MODE=1 by default
npm test                                    # vitest: the TS ports must match their Python originals
npx tsc --noEmit && npm run build
```

Two of those tests exist to stop the TypeScript and Python halves drifting apart:
`lib/sky.test.ts` pins the coordinate parser and slug to the exact strings the Python
tests assert, and `lib/sky.cube.test.ts` runs the browser's spectrum decoder over the
real baked WISE 0855 cube and compares it to a Python-generated fixture
(`python scripts/make_spectrum_fixture.py`). Regenerate that fixture whenever the baked
bundles change.

## Sky Viewer (real NASA data)

```bash
python -m deepfield.cli sky releases              # which SPHEREx collections IRSA publishes today
python -m deepfield.cli sky search "WISE 0855"    # what SPHEREx has there — no downloads
python -m deepfield.cli sky build "R Dra" --fov 0.1   # fetch, stack, render -> data/sky/<slug>/
python -m deepfield.cli sky bake                  # build + export the five challenge targets
python -m deepfield.cli sky bake --refresh        # rebuild only where new data has landed
python -m deepfield.cli sky fresh                 # has anything changed since each view was built?
```

A cutout is ~4 MB and ~12 s from IRSA, fetched `SKY_FETCH_WORKERS` (6) at a time and
cached on disk, so a 44-frame view takes about a minute the first time and is instant
afterwards. Knobs: `SKY_FETCH_WORKERS`, `SKY_REFRESH_MINUTES` (30, background freshness
sweeps), `SKY_AUTO_REBUILD` (0), `SKY_ALLOW_LIVE` (1), `SKY_MAX_ACTIVE_JOBS` (2),
`SPHEREX_COLLECTIONS` (override discovery). See [docs/SKY.md](docs/SKY.md).

**Keeping up with new releases.** Nothing is hardcoded to DR1. The collection list comes
from IRSA ObsTAP, each view records what coverage it was built from, and
`.github/workflows/sky-refresh.yml` re-bakes the committed demo weekly and opens a PR
when it changes.

## Planet X pipeline

```bash
cp .env.example .env   # set DEMO_MODE=0 for live NASA access; ANTHROPIC_API_KEY optional for Claude dossiers
python -m deepfield.cli sample     # fake SAMPLE bundle -> data/samples + apps/web/public/demo
python -m deepfield.cli targets    # rank HEALPix cells (Caltech ref. population) x SPHEREx DR1 coverage
python -m deepfield.cli run        # fetch cutouts, shift-and-stack, injection tests -> data/work/<patch>/
python -m deepfield.cli build      # completeness, CNN->ONNX, dossiers, exclusion map -> data/release/
python -m deepfield.cli export     # data/release -> apps/web/public/demo (frozen demo bundle)
```

Knobs (env): `PATCH_COUNT` (default 3), `PATCH_MAX_EXPOSURES` (40), `PATCH_RADIUS_DEG` (0.125), `NSIDE` (32).
GPU: install the CUDA wheel (`pip install torch==2.15.0 --index-url https://download.pytorch.org/whl/cu128`); the
stack uses it automatically, else CPU.

## Deploy

- **Frontend (Vercel):** import `apps/web` as the project root; env `NEXT_PUBLIC_DEMO_MODE=1` (frozen files) or
  `NEXT_PUBLIC_DEMO_MODE=0` + `NEXT_PUBLIC_API_URL=https://<api>.fly.dev` for the live crowd. `vercel.json` is included.
- **API (Fly.io):** from the repo root: `fly launch --no-deploy --copy-config --config apps/api/fly.toml` then
  `fly deploy --config apps/api/fly.toml`. Set `DEMO_MODE=0 SUPABASE_URL=… SUPABASE_SERVICE_KEY=…` with `fly secrets set`
  to persist votes in Supabase; otherwise votes live in SQLite inside the machine.
- **Crowd DB (Supabase):** run `supabase/migrations/0001_init.sql` in the SQL editor.
- **Tiles / stamps:** small enough to ship inside the web bundle (`apps/web/public/demo`, ~7 MB including the five
  baked sky views); for larger releases upload `data/release/stamps` to R2/S3 and point `fileUrl()` in
  `apps/web/lib/api.ts` at it.
- **Sky Viewer on a static host:** `NEXT_PUBLIC_DEMO_MODE=1` serves the five baked targets with no API at all —
  including spectra, which the browser decodes from each bundle's `cube.u16`. Live views of arbitrary coordinates
  need the API; set `SKY_ALLOW_LIVE=0` there if you want a frozen deployment that refuses to fetch.

## Data and rules

Only the datasets in [`manifest.yaml`](manifest.yaml) are used: SPHEREx DR1/QR3 and ObsTAP at IRSA, JPL Horizons,
JPL SBIdent, the Caltech Planet Nine reference population, and CDS Sesame (optional name resolution).
`scripts/check_manifest_domains.py` fails CI if code references any other host, and the runtime guard refuses to
fetch from it — **including redirect targets**, which matters because CDS load-balances Sesame across VizieR mirrors
and one of them is `vizier.china-vo.org`. The allowlist names the mirrors we accept; a redirect anywhere else is
refused and name resolution falls back to the offline catalogue.

The classifier is trained from scratch on our own injections; no third-party weights. Dependency versions are pinned
and were all released on or before 2026-10-30.

## Repo layout

```
apps/web/        Next.js 16 (Sky Viewer, The Hunt, Candidate Lab, Classify, Proof)
apps/api/        FastAPI (sky, map, candidates, task, vote) + SQLite/Supabase store
pipeline/        deepfield: data wrappers, sky viewer, prior map, stacking, injection, spectral, ml, agents, crowd
data/sky/        built sky-viewer bundles (ignored);  data/samples/  committed fake bundle
data/release/    frozen real-data bundle;  data/cache/  FITS cache (ignored)
tests/           pytest;  apps/web/lib/*.test.ts  vitest
```
