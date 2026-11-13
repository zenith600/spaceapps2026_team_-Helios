import json
from pathlib import Path

import pytest

from deepfield.crowd import consensus as C

FIXTURE = Path(__file__).parent / "fixtures" / "consensus.json"


def test_prior_skill_is_0_6():
    s = C.Skill()
    assert s.p_real == pytest.approx(0.6)
    assert s.p_bogus == pytest.approx(0.6)
    assert s.reliability == pytest.approx(0.6)


def test_skill_updates_only_matching_side():
    s = C.update_skill(C.Skill(), "real", "real")
    assert s.real_seen == 1 and s.real_correct == 1 and s.bogus_seen == 0
    s = C.update_skill(s, "nothing", "real")
    assert s.real_seen == 2 and s.real_correct == 1
    s = C.update_skill(s, "artifact", "bogus")
    assert s.bogus_seen == 1 and s.bogus_correct == 1


def test_probability_moves_in_right_direction():
    skilled = C.Skill(real_correct=20, real_seen=20, bogus_correct=20, bogus_seen=20)
    p = C.update_probability(0.5, "real", skilled)
    assert p > 0.5
    p2 = C.update_probability(p, "artifact", skilled)
    assert p2 < p
    # a coin-flipper barely moves it
    flipper = C.Skill(real_correct=0, real_seen=20, bogus_correct=0, bogus_seen=20)  # worse than chance -> clipped to 0.05
    assert C.vote_weight(flipper) == 0.0
    neutral = C.Skill(real_correct=10, real_seen=20, bogus_correct=10, bogus_seen=20)
    assert abs(C.update_probability(0.5, "real", neutral) - 0.5) < 0.1


def test_bayes_formula_exact():
    s = C.Skill(real_correct=7, real_seen=7, bogus_correct=7, bogus_seen=7)  # p_real = p_bogus = 10/12
    pr = 10 / 12
    p = C.update_probability(0.3, "real", s)
    assert p == pytest.approx(0.3 * pr / (0.3 * pr + 0.7 * (1 - pr)))


def test_probability_clipped():
    perfect = C.Skill(real_correct=1000, real_seen=1000, bogus_correct=1000, bogus_seen=1000)
    p = 0.5
    for _ in range(50):
        p = C.update_probability(p, "real", perfect)
    assert p == C.P_MAX


def test_points_and_credit():
    assert C.points_for("real", "real") == C.POINTS_TEST_CORRECT
    assert C.points_for("nothing", "real") == C.POINTS_TEST_WRONG
    assert C.points_for("real", None) == C.POINTS_VOTE
    assert C.patch_credit(5) == 0.5 and C.patch_credit(50) == 1.0
    assert C.is_test_card(0.05) and not C.is_test_card(0.5)


def test_bad_answer_rejected():
    with pytest.raises(ValueError):
        C.normalise_answer("maybe")


def test_shared_fixture_matches_typescript_port():
    """Fixture consumed by both pytest and vitest: identical numbers on both sides."""
    cases = json.loads(FIXTURE.read_text())
    for case in cases["probability"]:
        s = C.Skill(**case["skill"])
        got = C.update_probability(case["p"], case["answer"], s)
        assert got == pytest.approx(case["expected"], rel=1e-9), case
    for case in cases["skill"]:
        s = C.Skill(**case["skill"])
        s2 = C.update_skill(s, case["answer"], case["truth"])
        assert s2.p_real == pytest.approx(case["p_real"], rel=1e-9)
        assert s2.p_bogus == pytest.approx(case["p_bogus"], rel=1e-9)
