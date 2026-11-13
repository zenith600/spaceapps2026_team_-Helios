"""Loads the frozen pipeline bundle (parquet + json + stamps) from DATA_DIR into memory."""
from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

from deepfield.config import DATA_DIR, SAMPLES_DIR, REPO_ROOT


def resolve_data_dir() -> Path:
    d = Path(os.environ.get("DATA_DIR", str(DATA_DIR)))
    if not d.is_absolute():
        d = (REPO_ROOT / d).resolve()
    if (d / "candidates.parquet").exists():
        return d
    return SAMPLES_DIR


def _read(path: Path) -> tuple[pd.DataFrame, dict]:
    t = pq.read_table(path)
    meta = {k.decode(): v.decode() for k, v in (t.schema.metadata or {}).items()}
    return t.to_pandas(), meta


def _clean(v):
    if isinstance(v, (np.floating, float)):
        return None if np.isnan(v) else float(v)
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.bool_,)):
        return bool(v)
    if v is pd.NA or v is None:
        return None
    return v


def records(df: pd.DataFrame) -> list[dict]:
    return [{k: _clean(v) for k, v in row.items()} for row in df.to_dict(orient="records")]


class Bundle:
    def __init__(self, root: Path):
        self.root = root
        self.prior_map, self.prior_meta = _read(root / "prior_map.parquet")
        self.targets, self.targets_meta = _read(root / "targets.parquet")
        self.candidates, self.candidates_meta = _read(root / "candidates.parquet")
        self.spectra, self.spectra_meta = _read(root / "spectra.parquet")
        self.completeness, self.completeness_meta = _read(root / "completeness.parquet")
        bj = root / "bundle.json"
        self.info = json.loads(bj.read_text()) if bj.exists() else {}
        self.kind = self.info.get("kind", "UNKNOWN")

    def dossier(self, candidate_id: str) -> dict | None:
        p = self.root / "dossiers" / f"{candidate_id}.json"
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None

    def candidate(self, candidate_id: str) -> dict | None:
        rows = self.candidates[self.candidates.candidate_id == candidate_id]
        return records(rows)[0] if len(rows) else None

    def spectrum(self, candidate_id: str) -> list[dict]:
        rows = self.spectra[self.spectra.candidate_id == candidate_id].sort_values("wavelength_um")
        return records(rows)

    def stamp_files(self, candidate_id: str) -> dict:
        d = self.root / "stamps" / candidate_id
        if not d.exists():
            return {"singles": [], "stack": None, "static": None}
        singles = sorted(p.name for p in d.glob("single_*.png"))
        meta = json.loads((d / "meta.json").read_text()) if (d / "meta.json").exists() else {}
        return {"singles": [f"stamps/{candidate_id}/{s}" for s in singles],
                "stack": f"stamps/{candidate_id}/stack.png", "static": f"stamps/{candidate_id}/static.png",
                "meta": meta}

    def manifest(self) -> dict:
        import yaml
        return yaml.safe_load((REPO_ROOT / "manifest.yaml").read_text(encoding="utf-8"))

    def test_truth(self, candidate_id: str) -> str | None:
        """Secret-test truth for a candidate, or None if it is a live (unknown) card."""
        c = self.candidate(candidate_id)
        if c is None:
            return None
        if c["is_simulated"] and c.get("injection_id"):
            return "real"
        if c["status"] in ("artifact", "empty"):
            return "bogus"
        return None


@lru_cache(maxsize=1)
def get_bundle() -> Bundle:
    return Bundle(resolve_data_dir())
