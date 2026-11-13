"""Central configuration. Everything comes from environment / .env, nothing hardcoded."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(REPO_ROOT / ".env", override=False)


def _env_path(name: str, default: str) -> Path:
    p = Path(os.environ.get(name, default))
    return p if p.is_absolute() else (REPO_ROOT / p).resolve()


DEMO_MODE: bool = os.environ.get("DEMO_MODE", "1") == "1"
DATA_DIR: Path = _env_path("DATA_DIR", "data/release")
CACHE_DIR: Path = _env_path("CACHE_DIR", "data/cache")
WORK_DIR: Path = _env_path("WORK_DIR", "data/work")
SAMPLES_DIR: Path = REPO_ROOT / "data" / "samples"
PATCH_COUNT: int = int(os.environ.get("PATCH_COUNT", "3"))
PATCH_MAX_EXPOSURES: int = int(os.environ.get("PATCH_MAX_EXPOSURES", "40"))
PATCH_RADIUS_DEG: float = float(os.environ.get("PATCH_RADIUS_DEG", "0.125"))  # 0.25 deg cutouts
NSIDE: int = int(os.environ.get("NSIDE", "32"))

# Reference population epoch: JD 2458270.0 = 2018-06-01 (from the CSV header)
REFPOP_EPOCH_JD: float = 2458270.0
SPHEREX_HORIZONS_ID: str = "-163182"
SPHEREX_PIXEL_ARCSEC: float = 6.15
