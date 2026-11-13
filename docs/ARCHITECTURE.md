# Deep Field: Planet X × SPHEREx — System Architecture

Nov 13, 2026 · @zenith

## Overview

Deep Field searches for Planet X where single images cannot see. It stacks SPHEREx and WISE images along gravity-predicted orbits, checks each candidate's 102-colour spectrum, lets AI and the public vet the results, and publishes a live map of where Planet X can no longer hide.

**Pitch line:** Everyone else looked at the pictures. We searched where the pictures can't see.

The system has five layers, each owned by its own agent team:

1. **Data** pulls NASA-first, openly licensed datasets and records where each one came from.
2. **Science engine** turns the Planet Nine probability cloud into a target list, runs the stacking search, and measures its own sensitivity.
3. **AI** ranks candidates with a small model trained from scratch, and a team of AI agents writes a dossier on each one.
4. **Crowd** lets the public classify the cases the AI is least sure about, with skill-weighted voting.
5. **Experience** is the web app: the living exclusion map, the candidate lab, the orbit lab and the proof page.

**Design rule: precompute heavy, serve light.** All GPU work runs offline as batch jobs and writes static files. The web app only reads those files plus a small database for votes. That keeps the demo fast, cheap to host, and safe if a NASA service goes down during judging.

## Architecture at a glance

&#91;embedded content: Deep Field architecture · 5 layers, 1 feedback loop\]

Data flows down into the offline science engine, which hands candidates to the AI and the crowd; their verdicts flow back up to rule out orbits, and everything surfaces in the web app.

## Layer 1: Data

Every dataset is open, mostly NASA, and listed in a provenance manifest that the build checks against an allowlist.

| Dataset | Owner | Access | Used for |
| --- | --- | --- | --- |
| SPHEREx Level 2 images and spectral images | NASA / JPL / Caltech-IPAC | IRSA image search (pyvo) and the public `nasa-irsa-spherex` S3 bucket | Core search data, 102 bands, multiple epochs |
| unWISE / NEOWISE images | NASA | IRSA | Decade-long infrared baseline for slow movers |
| JPL Horizons | NASA JPL | REST API (SPHEREx spacecraft ID −163182) | SPHEREx position at each exposure, planet and eTNO positions |
| JPL Small-Body Identification (SBIdent) and SBDB | NASA JPL | REST API | Known asteroids and comets in each field |
| Planet Nine reference population (latest version) | Caltech (CaltechDATA) | CSV download, about 13 MB | 100,000 gravity-predicted orbits and survey exclusions |
| 2MASS point sources | NASA / NSF (IRSA) | TAP query | Static stars to mask |
| Minor Planet Center orbits | Smithsonian / IAU | Bulk download | eTNO orbits for the Orbit Lab |
| Gaia DR3 (optional) | European Space Agency | TAP query | Precise astrometry for image alignment |

**Ingestion.** One Python package (`deepfield.data`) wraps each source behind the same interface: `query(region, time_range) → records`. Results are cached on disk as Parquet (tables) and FITS (images), keyed by HEALPix cell, so no source is called twice.

**Storage for the app.** Image cutouts become PNG tiles in object storage. Tables become Parquet files read through DuckDB. Nothing in the web app calls a NASA service live except one optional "refresh this patch" button.

**China-rule compliance.**

- `manifest.yaml` lists every dataset with owner, licence, URL and country of the owning institution.
- A CI check fails the build if code fetches from a domain not in the manifest.
- The ML model is trained from scratch, so no pretrained weights from any third party enter the system.
- Open check: confirm with the organisers whether the rule also covers software libraries and AI services.

## Layer 2: Science engine

The engine runs offline on a GPU and produces four files the app reads: a target list, candidates, completeness curves and the exclusion map.

1. **Prior map.** Load the 100,000 synthetic Planet Nines and drop the ones ZTF, DES and Pan-STARRS already ruled out. Propagate each survivor to every SPHEREx and WISE epoch, using SPHEREx's own position from Horizons. Bin them on a HEALPix grid to get a probability map of where Planet X could still be.
2. **Target selection.** Intersect the map with SPHEREx coverage and rank sky patches by surviving probability × number of epochs. The top patches get searched first.
3. **Shift-and-stack (the core).** For each patch, build a grid of trial motions. For distant objects, motion is mostly parallax from Earth's orbit, so the grid is distance plus small proper-motion terms. Shift every epoch along each trial and stack. A real object adds up; noise averages away. Written in PyTorch so it runs batched on GPU.
4. **Spectral filter.** For each stacked candidate, extract flux in the SPHEREx bands and fit three templates: reflected sunlight with methane absorption near 3.3 µm (cold giant planet), plain reflected sunlight (asteroid), and stellar. Output a methane score.
5. **Injection tests.** Insert synthetic Planet Nines from the reference population into real images, run the full search, and record which are recovered. This gives completeness by brightness and distance, and supplies training data for the AI and secret test cases for the crowd.
6. **Exclusion update.** Any reference-population planet that crossed a searched patch, at a brightness we proved we could recover, is marked ruled out. The map is recomputed and the "% of Planet Nine space excluded" counter updates.

**Honest limits to show on the Proof page.** SPHEREx pixels are about 6 arcseconds, so crowded fields cause confusion. SPHEREx's time baseline is short, which is why WISE epochs are added. The injection tests report exactly how deep we reach, whatever the answer turns out to be.

## Layer 3: AI

The AI layer has three parts: a small classifier that ranks candidates, a loop that learns from the crowd, and a team of AI agents that explains each candidate.

**Real/bogus classifier.**

- Input: a small stack of image stamps of one candidate across epochs, plus its stacked stamp.
- Model: a small CNN in PyTorch, trained from scratch. Output: probability that it is a real moving object.
- Training labels come free: injected fakes and JPL-known asteroids are positives; empty sky, stars, cosmic rays and detector artifacts are negatives.
- Export to ONNX and run it in the browser with ONNX Runtime Web, so the demo can classify a patch live with no server.
- Each prediction ships with a saliency map (Grad-CAM) showing which pixels drove the score.

**Active learning loop.** Candidates scored between roughly 0.3 and 0.7 go to the crowd first, because that is where human attention teaches the model most. Crowd consensus labels are added to the training set and the model retrains on a schedule. The Proof page charts model accuracy against the number of crowd labels.

**AI astronomer team.** A set of Claude-powered agents, each with one job and its own tools:

| Agent | Job | Tools |
| --- | --- | --- |
| Scout | Pulls the candidate's data and summarises it | Data layer, image stamps |
| Linker | Checks whether detections across epochs fit one orbit | Orbit fitter |
| Skeptic | Tries to debunk it: known object, artifact, star, cosmic ray | SBIdent, 2MASS, artifact flags |
| Spectroscopist | Reads the spectral fit and methane score | Spectral filter output |
| Reporter | Writes the plain-language dossier and a standard Minor Planet Center report | All of the above |

The dossier shows each agent's reasoning, so judges and users can see how a candidate survived or failed. Dossiers are generated in batch and cached; one "run live" button demonstrates the team on a fresh candidate.

## Layer 4: Crowd

The public classifies candidates in a fast, game-like flow, and votes are weighted by each person's proven skill.

1. **Task queue.** The server picks the next candidate for a user: mostly AI-uncertain cases, plus about 1 in 10 secret test cases (injected fakes or empty fields).
2. **Classify.** The user sees the blink, the stacked stamp and the AI saliency map, then answers Real mover, Artifact or Nothing, and can click the exact spot.
3. **Skill tracking.** Answers on test cases update each user's reliability score, in the style of the SWAP method used by Zooniverse's Space Warps project.
4. **Consensus.** Each candidate's probability is updated from weighted votes. Clicks from several reliable users on the same spot raise its priority.
5. **Promotion.** A candidate with high consensus and enough votes moves to the Expert queue and gets a full agent dossier.

**Points** reward being right, not clicking a lot: points scale with correctness on test cases and agreement with final consensus. A leaderboard and "you helped rule out X% of the sky" badges tie each user to the exclusion map.

**Accounts.** Anonymous play by default, optional sign-in to keep points. Rate limits and the skill weighting together blunt spam and vote brigading.

**Local impact.** The interface ships in English, Sinhala and Tamil, with a classroom mode for Sri Lankan schools.

## Layer 5: Experience

The web app has six screens, one clean dark theme, and a three-minute demo path through them.

| Screen | What the user sees | Key components |
| --- | --- | --- |
| The Hunt (home) | A 3D sky globe with the living exclusion map shrinking, and a large "% of Planet Nine space ruled out" counter | react-three-fiber globe, HEALPix overlay |
| Sky Explorer | Pan and zoom the real infrared sky, toggle the probability map and searched patches | Aladin Lite v3 with SPHEREx tiles |
| Candidate Lab | Blink, stacked stamp, 102-band spectrum with methane fit, AI score and saliency, agent dossier | Canvas blink viewer, spectrum chart, dossier panel |
| Classify | The citizen science game: one candidate at a time, three buttons, instant feedback on test cases | Mobile-first card UI |
| Orbit Lab | 3D solar system with the clustered eTNOs and the cloud of possible Planet Nine orbits; drop in a new object and see the map shift | three.js scene, precomputed scenarios |
| Proof | Completeness curves, injection results, model accuracy vs crowd labels, data provenance | Charts, manifest table |

**Design system.**

- Near-black background, one accent colour for anything "live" or "candidate", neutral greys elsewhere.
- Inter for text, JetBrains Mono for numbers and coordinates.
- Tailwind CSS with shadcn/ui components; every screen works on a phone.
- Every image and number has a source label, and simulated objects are always visibly tagged as simulated.

**Three-minute demo path.**

1. The Hunt: the counter and shrinking map (the hook).
2. Orbit Lab: why we think Planet Nine exists, in 20 seconds.
3. Candidate Lab: one injected planet invisible in single frames, then bright in the stack, then the methane fit.
4. Classify: a judge plays three cards on their phone.
5. Proof: how deep we reached and what we ruled out.

## Tech stack and deployment

One monorepo, one `docker compose up` for local work, and four hosted services in production.

| Part | Choice | Why |
| --- | --- | --- |
| Frontend | Next.js (App Router), TypeScript, Tailwind CSS, shadcn/ui | Fast to build, deploys in one click |
| 3D and sky | react-three-fiber (three.js), Aladin Lite v3 | Globe and Orbit Lab; real sky browsing |
| Charts | Plotly.js | Spectra and completeness curves with zoom |
| In-browser ML | ONNX Runtime Web | Live classification with no server |
| API | FastAPI (Python) | Same language as the science code |
| Science pipeline | Python, astropy, astroquery, pyvo, healpy, NumPy, PyTorch | Standard astronomy tools plus GPU stacking |
| Batch compute | Modal or Lambda GPU instances | Pay per run, scale out for stacking |
| Science outputs | Parquet files read through DuckDB | No database server needed |
| Crowd data | Supabase (Postgres, auth, row-level security) | Votes, users, points, realtime counter |
| Image tiles | Cloudflare R2 (or AWS S3) | Cheap static hosting for cutouts |
| Agents | Claude API with tool use | AI astronomer team and dossiers |
| CI | GitHub Actions | Tests, manifest allowlist check, deploys |
| Hosting | Vercel (frontend), Fly.io (API) | Free tiers cover the hackathon |

**Repo layout.**

```
deepfield/
  apps/web/            Next.js app (six screens)
  apps/api/            FastAPI: candidates, tasks, votes, map
  pipeline/
    data/              source wrappers + cache
    prior/             Planet Nine map + target selection
    stack/             GPU shift-and-stack
    spectral/          template fits, methane score
    inject/            injection tests, completeness
    ml/                CNN training, ONNX export
    agents/            Claude agent team, dossiers
  manifest.yaml        dataset provenance allowlist
  docker-compose.yml
```

**Core API.**

- `GET /map` returns the current exclusion map and the % ruled out.
- `GET /candidates?patch=` returns ranked candidates with scores and dossier links.
- `GET /task` returns the next classification card for a user.
- `POST /vote` records an answer and updates consensus and points.
- `POST /refresh/{patch}` (optional, admin) reruns one patch live.

**Demo safety.** A `DEMO_MODE` flag serves everything from frozen files in object storage, so the demo works even with no API, no GPU and no NASA services reachable.

## Agent work breakdown and timeline

Eight agent workstreams run in parallel against fixed file contracts, so no stream waits on another's code.

| Stream | Builds | Delivers (contract) |
| --- | --- | --- |
| A. Data | Source wrappers, cache, manifest, CI allowlist check | `cache/` FITS + Parquet per HEALPix cell |
| B. Prior and targets | Planet Nine map, SPHEREx coverage, target ranking | `prior_map.parquet`, `targets.parquet` |
| C. Stacking | GPU shift-and-stack, candidate extraction | `candidates.parquet` + stamps |
| D. Spectral and injection | Template fits, methane score, injection tests | `spectra.parquet`, `completeness.parquet` |
| E. ML | CNN training, saliency, ONNX export, retrain job | `model.onnx`, scores in candidates |
| F. Agents | Claude agent team, dossier generator | `dossiers/*.json` |
| G. Crowd backend | Supabase schema, FastAPI routes, SWAP consensus | Live `/task`, `/vote`, `/map` |
| H. Frontend | Six screens, design system, i18n, demo mode | Deployed web app |

The file contracts are written first, with fake sample data, so streams E to H can build against them from hour one.

**Phases (Nov 14–15).**

1. **Tonight:** repo, contracts, sample data, accounts on Vercel, Fly.io, Supabase and the GPU provider; download the Planet Nine population and a first SPHEREx field.
2. **Day 1 morning:** each stream ships a working version against sample data; the app shows fake data end to end.
3. **Day 1 afternoon and night:** real data flows through prior map, stacking and spectral filter on a few top patches; model trains on injections.
4. **Day 2 morning:** integration, real candidates and dossiers in the app, crowd loop live, exclusion map updating.
5. **Day 2 afternoon:** freeze demo data, polish, record the demo video, write the project page, submit before the local deadline.

**Risks and fallbacks.**

| Risk | Fallback |
| --- | --- |
| SPHEREx coverage too thin for stacking in target patches | Add WISE epochs; demonstrate on injected planets and report true depth |
| GPU stacking too slow | Coarser trial grid, fewer patches, precompute overnight |
| NASA service outage during build or judging | Disk cache and `DEMO_MODE` |
| Model underperforms | Ship rule-based scoring; show the model as an experiment on the Proof page |
| Scope too large | Cut order: Orbit Lab sandbox, then multilingual UI, then live agent button |

**Open checks before starting:** the exact submission requirements and deadline for our local event, and how far the China-related rule reaches.
