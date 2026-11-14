"""AI astronomer dossiers: Scout, Skeptic and Reporter roles in one batch pipeline.

With ANTHROPIC_API_KEY set and DEMO_MODE=0, each dossier is written by the Claude API (tool-free, structured
JSON prompt, one call per candidate, cached). Without a key, the deterministic offline template generator
produces the same JSON shape from the measured numbers; the `generator` field says which one ran.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from deepfield.contracts import now_iso

SYSTEM = """You are three astronomers reviewing one candidate from a shift-and-stack search for Planet Nine in NASA SPHEREx
images. Scout summarises the measurements. Skeptic tries to debunk it (known object, static residual, artifact, noise).
Reporter writes a plain-language dossier for the public. Rules: never call anything a discovery; if is_simulated is true
say clearly that it is an injected simulation and produce no MPC report; cite only the numbers given; be concise.
Answer with JSON only, matching the schema given."""

SCHEMA = {
    "scout": {"summary": "2-3 sentences", "facts": ["short fact strings"]},
    "skeptic": {"checks": [{"name": "known_object|single_frame_visible|stationary|artifact_flags|spectrum|noise", "result": "text"}],
                "verdict": "text"},
    "reporter": {"headline": "<= 12 words", "dossier_md": "3 short paragraphs, markdown", "mpc_report": "null unless a real candidate with >=5 sigma"},
    "verdict": "simulated|candidate|artifact|known|empty", "confidence": 0.0,
}


def _facts(c: dict, spectrum: list[dict] | None) -> dict:
    keep = ("candidate_id", "patch_id", "ra_deg", "dec_deg", "is_simulated", "injected_mag", "injected_distance_au",
            "snr_stack", "snr_single_max", "best_distance_au", "best_rate_ra_arcsec_day", "best_rate_dec_arcsec_day",
            "n_epochs", "n_bands", "methane_score", "template_best", "ml_score", "rule_score", "status", "known_object", "source")
    f = {k: c.get(k) for k in keep}
    if spectrum:
        f["spectrum_n_points"] = len(spectrum)
        f["wavelength_range_um"] = [min(s["wavelength_um"] for s in spectrum), max(s["wavelength_um"] for s in spectrum)]
    return f


def offline_dossier(c: dict, spectrum: list[dict] | None = None) -> dict:
    sim = bool(c.get("is_simulated"))
    snr, single = float(c.get("snr_stack") or 0), float(c.get("snr_single_max") or 0)
    stationary = c.get("best_distance_au") is None
    known = c.get("known_object")
    status = c.get("status", "candidate")
    facts = [
        f"patch {c.get('patch_id')} at RA {c.get('ra_deg'):.4f}, Dec {c.get('dec_deg'):.4f} (SPHEREx DR1)",
        f"stacked SNR {snr:.1f} over {c.get('n_epochs')} exposures; best single-frame SNR {single:.1f}",
        ("best trial: stationary (no parallax)" if stationary else
         f"best trial distance {c.get('best_distance_au'):.0f} AU, extra rate ({c.get('best_rate_ra_arcsec_day'):+.1f}, "
         f"{c.get('best_rate_dec_arcsec_day'):+.1f}) arcsec/day"),
        f"{c.get('n_bands')} SPHEREx bands measured; methane score {float(c.get('methane_score') or 0):.2f} (toy template fit)",
    ]
    if sim:
        facts.insert(0, f"SIMULATED injection of reference planet {c.get('injection_id')}: V={c.get('injected_mag'):.1f} at "
                        f"{c.get('injected_distance_au'):.0f} AU")
    checks = [
        {"name": "known_object", "result": f"matches {known} in JPL SBIdent" if known else "no JPL SBIdent match within 30 arcsec"},
        {"name": "single_frame_visible", "result": ("yes: visible in a single frame (SNR %.1f), so a static residual is likely" % single)
         if single > 4 else "no: below 4 sigma in every single frame, as expected for a faint mover"},
        {"name": "stationary", "result": "best trial has no parallax: not a distant mover" if stationary else "best trial requires parallax motion"},
        {"name": "spectrum", "result": f"best of three toy templates: {c.get('template_best')}; with {c.get('n_bands')} noisy points this is weak evidence"},
        {"name": "noise", "result": "below the 5-sigma detection threshold" if snr < 5 else "above the 5-sigma threshold in the stack"},
    ]
    if sim:
        verdict = "simulated"
        skeptic_verdict = ("Injected planet; recovered in the stack." if snr >= 5 else
                           "Injected planet that the search did NOT recover: below our completeness limit.")
        headline = f"Simulated Planet Nine at V {c.get('injected_mag'):.1f}: " + ("recovered in the stack" if snr >= 5 else "not recovered")
        body = (f"This is a synthetic planet from the Caltech reference population, injected into real SPHEREx frames along its "
                f"true parallax track at {c.get('injected_distance_au'):.0f} AU. It is invisible in any single frame "
                f"(best single-frame SNR {single:.1f}) and reaches SNR {snr:.1f} when the frames are shifted along the correct "
                f"trial motion and stacked.\n\n" +
                ("The search recovered it with the right distance bin, which is the point of the injection test: it measures how "
                 "deep the search reaches. " if snr >= 5 else
                 "The search did not reach it. Failures like this one set the completeness limit shown on the Proof page. ") +
                "\n\nNothing about this object is real. It exists to calibrate the search and to train the classifier and the crowd.")
        conf = 1.0
    elif known:
        verdict, skeptic_verdict, headline = "known", f"Position matches {known}.", f"Known asteroid {known}, not a candidate"
        body = f"The stacked peak sits on the predicted position of {known} from the JPL Small-Body Identification service."
        conf = 0.9
    elif status == "artifact" or stationary:
        verdict, skeptic_verdict = "artifact", "Peak prefers the stationary trial: static sky residual or detector artifact."
        headline = "Stationary residual, not a mover"
        body = ("The stack is brightest with no parallax shift, so this is a residual of a static source (a star whose brightness "
                "changes between SPHEREx bands) or a detector artifact, not a distant moving object.")
        conf = 0.8
    elif status == "empty":
        verdict, skeptic_verdict, headline = "empty", "Nothing above noise at this position.", "Empty field (test card)"
        body = "A random position with no significant signal, used as a secret test for the crowd."
        conf = 0.9
    else:
        verdict = "candidate"
        skeptic_verdict = ("Survives the simple checks, but a single-visit stack at this SNR is not a detection; needs a second visit." if snr >= 5
                           else "Below threshold.")
        headline = f"Stack peak at SNR {snr:.1f} preferring {c.get('best_distance_au'):.0f} AU, unconfirmed"
        body = (f"A peak appears when SPHEREx frames are stacked along a trial motion for an object at about {c.get('best_distance_au'):.0f} AU. "
                f"It is not visible in single frames. It has not been linked across visits, has no second-epoch confirmation, "
                f"and the spectrum ({c.get('n_bands')} bands) is too noisy to distinguish templates.\n\n"
                "This is a candidate for follow-up, not a discovery.")
        conf = float(min(0.6, max(0.1, (snr - 4) / 6)))
    return {
        "candidate_id": c["candidate_id"], "generated_at": now_iso(), "generator": "offline-template", "is_simulated": sim,
        "scout": {"summary": f"{'SIMULATED injection. ' if sim else ''}Stacked SNR {snr:.1f} over {c.get('n_epochs')} SPHEREx exposures "
                             f"in patch {c.get('patch_id')}; best single-frame SNR {single:.1f}.", "facts": facts},
        "skeptic": {"checks": checks, "verdict": skeptic_verdict},
        "reporter": {"headline": headline, "dossier_md": body, "mpc_report": None},
        "verdict": verdict, "confidence": conf,
        "sources": [c.get("source"), "Caltech Planet Nine reference population v3", "JPL SBIdent", "JPL Horizons"],
    }


def claude_dossier(c: dict, spectrum: list[dict] | None, model: str) -> dict:
    import anthropic  # pinned 2.3.0
    client = anthropic.Anthropic()
    prompt = ("Candidate facts (JSON):\n" + json.dumps(_facts(c, spectrum), indent=1) +
              "\n\nRespond with JSON only using this schema:\n" + json.dumps(SCHEMA, indent=1))
    msg = client.messages.create(model=model, max_tokens=1200, system=SYSTEM,
                                 messages=[{"role": "user", "content": prompt}])
    text = "".join(getattr(b, "text", "") for b in msg.content)
    start, end = text.find("{"), text.rfind("}")
    data = json.loads(text[start:end + 1])
    data.update({"candidate_id": c["candidate_id"], "generated_at": now_iso(), "generator": f"claude:{model}",
                 "is_simulated": bool(c.get("is_simulated")),
                 "sources": [c.get("source"), "Caltech Planet Nine reference population v3", "JPL SBIdent", "JPL Horizons"]})
    if data["is_simulated"]:
        data.setdefault("reporter", {})["mpc_report"] = None
        data["verdict"] = "simulated"
    return data


def generate_dossiers(candidates: list[dict], spectra_by_id: dict[str, list[dict]], out_dir: Path,
                      use_claude: bool | None = None) -> dict:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    key = os.environ.get("ANTHROPIC_API_KEY")
    demo = os.environ.get("DEMO_MODE", "1") == "1"
    if use_claude is None:
        use_claude = bool(key) and not demo
    model = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-5")
    n_claude = n_offline = 0
    for c in candidates:
        p = out_dir / f"{c['candidate_id']}.json"
        d = None
        if use_claude:
            try:
                d = claude_dossier(c, spectra_by_id.get(c["candidate_id"]), model)
                n_claude += 1
            except Exception as exc:  # fall back, never block the batch
                d = offline_dossier(c, spectra_by_id.get(c["candidate_id"]))
                d["generator_note"] = f"claude failed: {type(exc).__name__}"
                n_offline += 1
        else:
            d = offline_dossier(c, spectra_by_id.get(c["candidate_id"]))
            n_offline += 1
        p.write_text(json.dumps(d, indent=1))
    return {"claude": n_claude, "offline": n_offline, "model": model if use_claude else None}
