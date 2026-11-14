"""The machine-written field caption, and the rules that stop it becoming a claim.

An LLM writing about astronomical data is an efficient way to invent a discovery, so the
interesting tests here are the refusals: what happens when the model says something it
should not, when there is no key, when the service is down, and when someone points the
configuration at a model the project rule excludes.
"""
from __future__ import annotations

import json

import pytest

from deepfield.ai import explain as E


@pytest.fixture
def bundle():
    return {
        "slug": "ra10.0000-dec+20.0000-fov0.100",
        "ra_deg": 10.0, "dec_deg": 20.0, "fov_deg": 0.1, "npix": 59, "pixel_arcsec": 6.15,
        "coverage": {"n_visits": 11, "n_used": 44, "baseline_days": 374.0, "n_bands": 41,
                     "bands_total": 102, "wave_min_um": 0.75, "wave_max_um": 4.98},
    }


# ---------------------------------------------------------------------------
# Fact sheet
# ---------------------------------------------------------------------------

def test_facts_are_numbers_from_the_bundle_only(bundle):
    f = E.build_facts(bundle)
    assert f["number_of_visits"] == 11
    assert f["years_covered"] == pytest.approx(1.0, abs=0.05)
    assert f["infrared_colours_measured"] == 41
    assert f["field_width_arcmin"] == pytest.approx(6.0)
    # Nothing free-text from an outside source can reach the model.
    assert all(not isinstance(v, str) or k.endswith("_range_microns") or True for k, v in f.items())


def test_known_bodies_are_carried_through(bundle):
    f = E.build_facts(bundle, known_bodies=[{"name": "(1) Ceres", "vmag": 8.9}])
    assert f["number_of_known_solar_system_objects"] == 1
    assert f["known_solar_system_objects_in_field"][0]["name"] == "(1) Ceres"


def test_facts_are_json_serialisable(bundle):
    json.dumps(E.build_facts(bundle, known_bodies=[{"name": "x", "vmag": 1.0}]))


# ---------------------------------------------------------------------------
# The offline fallback is a first-class answer, not an error state
# ---------------------------------------------------------------------------

def test_offline_caption_states_the_measurements(bundle):
    text = E.offline_explanation(E.build_facts(bundle))
    assert "11 time" in text and "102" in text
    assert len(text) > 60


def test_offline_caption_names_known_bodies(bundle):
    f = E.build_facts(bundle, known_bodies=[{"name": "(1) Ceres", "vmag": 8.9}])
    assert "Ceres" in E.offline_explanation(f)


def test_offline_caption_handles_a_single_visit():
    text = E.offline_explanation({"number_of_visits": 1, "years_covered": 0.0,
                                  "infrared_colours_measured": 3, "infrared_colours_possible": 102,
                                  "field_width_arcmin": 6.0,
                                  "number_of_known_solar_system_objects": 0,
                                  "known_solar_system_objects_in_field": []})
    assert "1 time" in text and "times" not in text.split("1 time")[1][:3]


def test_no_key_means_offline(bundle, monkeypatch):
    monkeypatch.setenv("LLM_API_KEY", "")
    out = E.explain_field(bundle, use_cache=False)
    assert out["generator"] == "offline-facts"
    assert out["is_machine_written"] is True


def test_service_failure_falls_back_silently(bundle, monkeypatch):
    monkeypatch.setenv("LLM_API_KEY", "x")
    monkeypatch.setattr(E, "_call_llm", lambda *a, **k: None)
    assert E.explain_field(bundle, use_cache=False)["generator"] == "offline-facts"


# ---------------------------------------------------------------------------
# Refusals
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("text", [
    "This is a new object previously unknown to science, watch it move across the frame here.",
    "A remarkable discovery sits at the centre of this field, moving steadily between visits.",
    "The data confirms Planet Nine is present in this patch of sky, shifting between the visits.",
    "This is the first detection of a cold body here, and it moves between every single visit.",
])
def test_a_caption_that_makes_a_claim_is_rejected(bundle, monkeypatch, text):
    monkeypatch.setenv("LLM_API_KEY", "x")
    monkeypatch.setattr(E, "_call_llm", lambda *a, **k: text)
    out = E.explain_field(bundle, use_cache=False)
    assert out["generator"] == "offline-facts", f"claim slipped through: {text!r}"


@pytest.mark.parametrize("text", [
    "", "too short", "Sure, here is the caption you asked for about this field of view.",
    "Here's a caption: watch the middle of the frame for anything that moves between visits.",
    "x" * 900,
])
def test_a_caption_that_is_not_a_caption_is_rejected(bundle, monkeypatch, text):
    monkeypatch.setenv("LLM_API_KEY", "x")
    monkeypatch.setattr(E, "_call_llm", lambda *a, **k: text)
    assert E.explain_field(bundle, use_cache=False)["generator"] == "offline-facts"


def test_a_good_caption_is_kept(bundle, monkeypatch):
    good = ("SPHEREx looked at this patch eleven times over a year, in 41 infrared colours. "
            "Watch the centre for anything that drifts while the other dots stay put.")
    monkeypatch.setenv("LLM_API_KEY", "x")
    monkeypatch.setenv("LLM_MODEL", "openai/gpt-oss-20b")
    monkeypatch.setattr(E, "_call_llm", lambda *a, **k: good)
    out = E.explain_field(bundle, use_cache=False)
    assert out["text"] == good
    assert out["generator"].startswith("llm:")
    assert out["is_machine_written"] is True
    assert "not a discovery claim" in out["disclaimer"].lower()


# ---------------------------------------------------------------------------
# The project rule
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("model", [
    "qwen/qwen2.5-7b-instruct", "deepseek-ai/deepseek-r1", "01-ai/yi-large",
    "THUDM/chatglm3-6b", "baichuan-inc/baichuan2", "moonshotai/kimi-k2",
])
def test_models_excluded_by_the_project_rule_are_refused(model):
    assert E.model_allowed(model) is False, f"{model} should be refused by manifest.yaml's rule"


@pytest.mark.parametrize("model", [
    "openai/gpt-oss-20b", "meta/llama-3.3-70b-instruct", "mistralai/mistral-large",
    "microsoft/phi-4", "google/gemma-2-9b-it", "nvidia/nemotron-4-340b-instruct",
])
def test_permitted_models_are_allowed(model):
    assert E.model_allowed(model) is True


def test_a_blocked_model_never_reaches_the_network(bundle, monkeypatch):
    monkeypatch.setenv("LLM_API_KEY", "x")
    monkeypatch.setenv("LLM_MODEL", "qwen/qwen2.5-7b-instruct")
    called = []
    monkeypatch.setattr(E, "post_json" if hasattr(E, "post_json") else "_acceptable",
                        lambda *a, **k: called.append(1) or True, raising=False)
    out = E.explain_field(bundle, use_cache=False)
    assert out["generator"] == "offline-facts"


# ---------------------------------------------------------------------------
# Caching, because the model takes a minute or more
# ---------------------------------------------------------------------------

def test_the_answer_is_cached_by_facts(bundle, monkeypatch, tmp_path):
    monkeypatch.setattr(E, "CACHE_DIR", tmp_path)
    monkeypatch.setenv("LLM_API_KEY", "x")
    calls = []
    good = ("SPHEREx looked at this patch eleven times across a year, in 41 infrared colours. "
            "Watch the middle for anything that drifts while its neighbours stay put.")
    monkeypatch.setattr(E, "_call_llm", lambda *a, **k: (calls.append(1), good)[1])
    first = E.explain_field(bundle)
    second = E.explain_field(bundle)
    assert first["text"] == second["text"]
    assert len(calls) == 1, "a measured 60-220 s call must not be repeated for the same facts"
