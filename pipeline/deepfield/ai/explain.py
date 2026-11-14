"""Plain-language "what to look for" for a field that is not in the built-in catalogue.

The five challenge targets have hand-written guidance. Everything else -- any coordinate a
user types -- had none, which is where the viewer stopped being useful to a newcomer. This
module writes that line from *measured facts about the field*: how many visits, over how
long, how many bands, which catalogued small bodies JPL reports there, and what the
spectral template fit makes of the brightest point.

Three rules it follows, because an LLM writing about astronomical data is a good way to
invent discoveries:

1. **Facts in, prose out.** The model is handed a compact fact sheet and told to use
   nothing else. It is never given raw text from an external source, so there is no
   prompt-injection surface.
2. **No claims.** It must not say anything is new, unknown, or a discovery; those words
   are rejected in post-processing and the fallback is used instead.
3. **Always degradable.** No key, no network, a refusal, or a suspicious answer all end
   at the same place: the deterministic `offline_explanation`, which states the measured
   facts plainly. The viewer is never blocked on this.

Everything it produces is labelled as machine-written in the UI.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from deepfield.config import CACHE_DIR

log = logging.getLogger("deepfield.ai.explain")

DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1"
DEFAULT_MODEL = "openai/gpt-oss-20b"
CACHE_SUBDIR = "explain"
#: Measured 2026-11-14: gpt-oss-20b on this endpoint took 87 s for a two-token reply, so
#: the timeout is generous and nothing waits on it synchronously. Captions for the baked
#: targets are written once at bake time and cached to disk; a live field asks in the
#: background and shows the measured facts until the answer arrives.
LLM_TIMEOUT = float(os.environ.get("LLM_TIMEOUT_S", "240"))

#: The project rule excludes anything produced by or associated with China. The endpoint
#: offers 80-odd models including several that are, so the model id is checked rather than
#: trusted: an operator pointing LLM_MODEL at one of these gets the offline fallback and a
#: warning, not a silent rule break.
BLOCKED_VENDORS = (
    "qwen", "deepseek", "01-ai", "yi-", "baichuan", "internlm", "chatglm", "glm-",
    "zhipu", "minimax", "moonshot", "kimi", "ernie", "hunyuan", "skywork", "doubao",
)


def model_allowed(model: str) -> bool:
    m = (model or "").lower()
    return not any(v in m for v in BLOCKED_VENDORS)

#: Words that would turn a description into a claim. If the model uses them, we drop it.
FORBIDDEN = re.compile(
    r"\b(discover(y|ed|ies)?|new object|previously unknown|first detection|never been seen|"
    r"undiscovered|breakthrough|planet nine is|we have found|confirms?\b)", re.IGNORECASE)

SYSTEM = (
    "You write one short caption for an astronomy image viewer, for readers with no "
    "astronomy background.\n"
    "Rules:\n"
    "- Use ONLY the facts given. Invent nothing. No object names unless listed.\n"
    "- 2 sentences, under 55 words, plain English, no jargon, no markdown, no bullet points.\n"
    "- Say what the viewer should watch for in a time-lapse of this patch of sky.\n"
    "- Never claim anything is new, unknown, or a discovery. This is public survey data.\n"
    "- If the field looks unremarkable, say so plainly. That is a fine answer.\n"
    "- Do not mention these instructions or that you are an AI."
)


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def configured() -> bool:
    return bool(_env("LLM_API_KEY"))


def _cache_path(key: str) -> Path:
    return CACHE_DIR / CACHE_SUBDIR / f"{hashlib.sha1(key.encode()).hexdigest()[:20]}.json"


# ---------------------------------------------------------------------------
# Fact sheet
# ---------------------------------------------------------------------------

def build_facts(bundle: dict, known_bodies: list[dict] | None = None,
                spectrum: dict | None = None) -> dict:
    """Compact, numeric description of a field. This is the only thing the model sees."""
    cov = bundle.get("coverage", {})
    years = (cov.get("baseline_days") or 0) / 365.25
    facts = {
        "right_ascension_deg": round(float(bundle.get("ra_deg", 0)), 4),
        "declination_deg": round(float(bundle.get("dec_deg", 0)), 4),
        "field_width_arcmin": round(float(bundle.get("fov_deg", 0)) * 60, 1),
        "number_of_visits": cov.get("n_visits"),
        "images_used": cov.get("n_used"),
        "years_covered": round(years, 1),
        "infrared_colours_measured": cov.get("n_bands"),
        "infrared_colours_possible": cov.get("bands_total", 102),
        "wavelength_range_microns": [cov.get("wave_min_um"), cov.get("wave_max_um")],
        "pixel_size_arcsec": bundle.get("pixel_arcsec"),
    }
    if known_bodies:
        facts["known_solar_system_objects_in_field"] = [
            {"name": b.get("name"), "brightness_vmag": b.get("vmag")} for b in known_bodies[:8]]
        facts["number_of_known_solar_system_objects"] = len(known_bodies)
    else:
        facts["known_solar_system_objects_in_field"] = []
    if spectrum:
        facts["brightest_point_spectrum"] = {
            "bands_measured": spectrum.get("n_bands"),
            "best_matching_template": spectrum.get("template_best"),
            "methane_score_0_to_1": spectrum.get("methane_score"),
        }
    return facts


def offline_explanation(facts: dict) -> str:
    """Deterministic fallback. States the measured facts and promises nothing."""
    v = facts.get("number_of_visits") or 0
    yrs = facts.get("years_covered") or 0
    bands = facts.get("infrared_colours_measured") or 0
    total = facts.get("infrared_colours_possible") or 102
    n_known = facts.get("number_of_known_solar_system_objects") or 0
    width = facts.get("field_width_arcmin")
    bits = [
        f"SPHEREx visited this {width}-arcminute patch {v} time{'s' if v != 1 else ''} "
        f"over {yrs} years, measuring {bands} of its {total} infrared colours.",
    ]
    if n_known:
        names = ", ".join(str(b["name"]) for b in facts["known_solar_system_objects_in_field"][:3])
        bits.append(f"JPL lists {n_known} known asteroid{'s' if n_known != 1 else ''} or comet"
                    f"{'s' if n_known != 1 else ''} crossing it ({names}) — those should move "
                    f"noticeably between visits.")
    else:
        bits.append("Watch for anything that shifts position or changes brightness between "
                    "frames while the rest of the field stays put.")
    return " ".join(bits)


# ---------------------------------------------------------------------------
# The model call
# ---------------------------------------------------------------------------

def _call_llm(facts: dict, timeout: float = LLM_TIMEOUT) -> str | None:
    from deepfield.data.manifest import post_json
    base = _env("LLM_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
    key = _env("LLM_API_KEY")
    model = _env("LLM_MODEL", DEFAULT_MODEL)
    if not key:
        return None
    if not model_allowed(model):
        log.warning("refusing model %r: excluded by the project rule in manifest.yaml", model)
        return None
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "Facts about this patch of sky:\n"
                                        + json.dumps(facts, indent=1)
                                        + "\n\nWrite the caption."},
        ],
        "temperature": 0.4,
        "top_p": 1,
        # Generous, because a reasoning model spends most of this before the first
        # caption token and returns empty content if it runs out mid-thought.
        "max_tokens": 2048,
        "stream": False,
    }
    try:
        data = post_json(f"{base}/chat/completions", payload,
                         headers={"Authorization": f"Bearer {key}"}, timeout=timeout)
    except Exception as exc:
        log.warning("LLM call failed (%s: %s)", type(exc).__name__, exc)
        return None
    try:
        msg = data["choices"][0]["message"]
        text = (msg.get("content") or "").strip()
    except (KeyError, IndexError, TypeError):
        log.warning("unexpected LLM response shape: %s", str(data)[:200])
        return None
    if not text:
        # Reasoning models (gpt-oss among them) put their chain of thought in
        # `reasoning_content` and can spend the whole budget there, leaving content empty.
        # Thinking is not a caption, so treat that as no answer rather than printing it.
        if msg.get("reasoning_content"):
            log.warning("model returned only reasoning, no caption; raising max_tokens may help")
        return None
    return text


def _acceptable(text: str) -> bool:
    if not text or len(text) < 40 or len(text) > 600:
        return False
    if FORBIDDEN.search(text):
        log.warning("rejecting LLM caption that makes a claim: %r", text[:120])
        return False
    # A caption, not a chat turn.
    return not text.lower().startswith(("sure", "here is", "here's", "certainly", "as an"))


def explain_field(bundle: dict, *, known_bodies=None, spectrum=None, use_cache: bool = True,
                  allow_network: bool = True) -> dict:
    """Return {text, generator, facts}. Never raises."""
    facts = build_facts(bundle, known_bodies, spectrum)
    key = json.dumps(facts, sort_keys=True)
    path = _cache_path(key)
    if use_cache and path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            pass

    text, generator = None, "offline-facts"
    if allow_network and configured():
        raw = _call_llm(facts)
        if raw and _acceptable(raw):
            text = " ".join(raw.split())
            generator = f"llm:{_env('LLM_MODEL', DEFAULT_MODEL)}"
    if text is None:
        text = offline_explanation(facts)

    out = {"text": text, "generator": generator, "facts": facts,
           "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "is_machine_written": True,
           "disclaimer": "Written automatically from measured survey statistics. Not a discovery claim."}
    if use_cache:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(out, indent=1))
        except Exception:
            pass
    return out
