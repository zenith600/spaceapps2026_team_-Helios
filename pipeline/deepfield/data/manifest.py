"""Runtime allowlist for every network call in the pipeline.

Every HTTP request made by `deepfield` goes through `fetch()` here, which refuses
any host that is not listed in manifest.yaml. The CI check in
scripts/check_manifest_domains.py enforces the same rule statically.
"""
from __future__ import annotations

import functools
import hashlib
from pathlib import Path
from urllib.parse import urlparse

import requests
import yaml

from deepfield.config import REPO_ROOT

MANIFEST_PATH = REPO_ROOT / "manifest.yaml"


class DisallowedDomain(RuntimeError):
    pass


@functools.lru_cache(maxsize=1)
def load_manifest() -> dict:
    with open(MANIFEST_PATH, "r", encoding="utf-8") as fh:
        return yaml.safe_load(fh)


@functools.lru_cache(maxsize=1)
def allowed_domains() -> frozenset[str]:
    m = load_manifest()
    doms: set[str] = set()
    for ds in m.get("datasets", []):
        doms.update(ds.get("domains", []))
    doms.update(m.get("infrastructure_domains", []))
    return frozenset(d.lower() for d in doms)


def dataset(dataset_id: str) -> dict:
    for ds in load_manifest()["datasets"]:
        if ds["id"] == dataset_id:
            return ds
    raise KeyError(dataset_id)


def host_allowed(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    if not host:
        return False
    allowed = allowed_domains()
    return host in allowed or any(host.endswith("." + d) for d in allowed)


def assert_allowed(url: str) -> None:
    if not host_allowed(url):
        raise DisallowedDomain(
            f"Refusing to fetch {url!r}: host not in manifest.yaml allowlist"
        )


def fetch(url: str, *, params: dict | None = None, timeout: float = 180.0,
          stream: bool = False, headers: dict | None = None, retries: int = 4) -> requests.Response:
    """GET with the allowlist enforced and exponential backoff on 5xx / connection errors. Raises for HTTP errors."""
    import time
    assert_allowed(url)
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            resp = requests.get(url, params=params, timeout=timeout, stream=stream,
                                headers={"User-Agent": "DeepField/0.1 (NASA Space Apps 2026)", **(headers or {})})
            if resp.status_code >= 500 and attempt < retries:
                last = requests.HTTPError(f"{resp.status_code} from {url}")
                time.sleep(2.0 * 2 ** attempt)
                continue
            resp.raise_for_status()
            return resp
        except (requests.ConnectionError, requests.Timeout) as exc:
            last = exc
            if attempt < retries:
                time.sleep(2.0 * 2 ** attempt)
                continue
            raise
    raise last  # pragma: no cover


def download(url: str, dest: Path, *, params: dict | None = None,
             expected_md5: str | None = None, timeout: float = 600.0) -> Path:
    """Stream a file to disk (atomic rename), verifying md5 when given."""
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    h = hashlib.md5()
    with fetch(url, params=params, timeout=timeout, stream=True) as r, open(tmp, "wb") as fh:
        for chunk in r.iter_content(chunk_size=1 << 20):
            fh.write(chunk)
            h.update(chunk)
    if expected_md5 and h.hexdigest() != expected_md5:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"md5 mismatch for {url}: {h.hexdigest()} != {expected_md5}")
    tmp.replace(dest)
    return dest
