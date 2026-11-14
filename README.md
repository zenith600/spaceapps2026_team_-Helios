# Deep Field — Planet X × SPHEREx

NASA Space Apps 2026 entry. *Everyone else looked at the pictures. We searched where the pictures can't see.*

Deep Field stacks NASA SPHEREx exposures along gravity-predicted Planet Nine motions (shift-and-stack), checks
each candidate's SPHEREx spectrum, lets the public vet the results with skill-weighted voting, and publishes a live
"% of Planet Nine space ruled out" counter. Everything simulated is labelled **Simulated**; nothing here is a discovery.

Docs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/PLAN.md](docs/PLAN.md) · [docs/STATUS.md](docs/STATUS.md) (what works, what is faked, what is blocked).

## One-command local run (DEMO_MODE, no network needed)

```bash
docker compose up --build
# web  http://localhost:3000   (reads frozen files in apps/web/public/demo)
# api  http://localhost:8000   (/map /candidates /task /vote /completeness /manifest, serves data/release)
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
npm test                                    # vitest: TS consensus port == Python fixture
```

## Pipeline (real NASA data)

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
- **Tiles / stamps:** small enough to ship inside the web bundle (`apps/web/public/demo`, ~2 MB); for larger
  releases upload `data/release/stamps` to R2/S3 and point `fileUrl()` in `apps/web/lib/api.ts` at it.

## Data and rules

Only the datasets in [`manifest.yaml`](manifest.yaml) are used (SPHEREx DR1 at IRSA, JPL Horizons, JPL SBIdent, the
Caltech Planet Nine reference population). `scripts/check_manifest_domains.py` fails CI if code references any other
host, and the runtime guard refuses to fetch from it. The classifier is trained from scratch on our own injections;
no third-party weights. Dependency versions are pinned and were all released on or before 2026-10-30.

## Repo layout

```
apps/web/        Next.js 16 (The Hunt, Candidate Lab, Classify, Proof)
apps/api/        FastAPI (map, candidates, task, vote) + SQLite/Supabase store
pipeline/        deepfield: data wrappers, prior map, stacking, injection, spectral, ml, agents, crowd maths
data/samples/    committed fake bundle;  data/release/  frozen real-data bundle;  data/cache/  FITS cache (ignored)
tests/           pytest;  apps/web/lib/*.test.ts  vitest
```
