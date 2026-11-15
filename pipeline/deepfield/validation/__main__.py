"""python -m deepfield.validation --config pipeline/deepfield/validation/configs/v1.yaml [--only rw_aur,barnard]"""
from __future__ import annotations

import argparse
from pathlib import Path

from deepfield.validation.run import run


def main() -> None:
    ap = argparse.ArgumentParser(description="Deep Field validation run")
    ap.add_argument("--config", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=None, help="output root (default data/validation)")
    ap.add_argument("--only", type=str, default="", help="comma-separated field ids (debugging; breaks the split protocol)")
    a = ap.parse_args()
    run(a.config, a.out, [x for x in a.only.split(",") if x] or None)


if __name__ == "__main__":
    main()
