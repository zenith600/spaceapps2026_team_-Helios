"""Skill-weighted consensus in the style of Space Warps' SWAP.

Pure functions; no I/O. The TypeScript port in apps/web/lib/consensus.ts must
stay numerically identical (both are tested against tests/fixtures/consensus.json).

Model
-----
A user has two skills:
  p_real  = P(user says "real"  | subject is real)
  p_bogus = P(user says "bogus" | subject is bogus)
Both start from a Beta prior (PRIOR_A correct, PRIOR_B incorrect) and are updated
only by secret test cards, whose truth is known.

A candidate's probability of being real, P, is updated by Bayes with each vote.
"artifact" and "nothing" both count as "bogus".
"""
from __future__ import annotations

from dataclasses import dataclass

PRIOR_A = 3.0  # pseudo-count of correct answers
PRIOR_B = 2.0  # pseudo-count of wrong answers
SKILL_MIN, SKILL_MAX = 0.05, 0.95
P_MIN, P_MAX = 0.001, 0.999
TEST_CARD_FRACTION = 0.10
POINTS_TEST_CORRECT = 10
POINTS_TEST_WRONG = -2
POINTS_VOTE = 1
VOTES_TO_CREDIT_PATCH = 10.0

BOGUS_ANSWERS = ("artifact", "nothing", "bogus")
REAL_ANSWERS = ("real",)


@dataclass
class Skill:
    real_correct: float = 0.0
    real_seen: float = 0.0
    bogus_correct: float = 0.0
    bogus_seen: float = 0.0

    @property
    def p_real(self) -> float:
        return _clip((self.real_correct + PRIOR_A) / (self.real_seen + PRIOR_A + PRIOR_B), SKILL_MIN, SKILL_MAX)

    @property
    def p_bogus(self) -> float:
        return _clip((self.bogus_correct + PRIOR_A) / (self.bogus_seen + PRIOR_A + PRIOR_B), SKILL_MIN, SKILL_MAX)

    @property
    def reliability(self) -> float:
        """Single number for display: mean of the two skills, 0.5 = coin flip."""
        return 0.5 * (self.p_real + self.p_bogus)

    @property
    def n_test(self) -> int:
        return int(self.real_seen + self.bogus_seen)


def _clip(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x


def normalise_answer(answer: str) -> str:
    a = answer.strip().lower()
    if a in REAL_ANSWERS:
        return "real"
    if a in BOGUS_ANSWERS:
        return "bogus"
    raise ValueError(f"unknown answer {answer!r}")


def update_skill(skill: Skill, answer: str, truth: str) -> Skill:
    """Return a new Skill after a test card with known truth ('real' | 'bogus')."""
    a, t = normalise_answer(answer), normalise_answer(truth)
    s = Skill(skill.real_correct, skill.real_seen, skill.bogus_correct, skill.bogus_seen)
    if t == "real":
        s.real_seen += 1
        s.real_correct += 1 if a == "real" else 0
    else:
        s.bogus_seen += 1
        s.bogus_correct += 1 if a == "bogus" else 0
    return s


def update_probability(p: float, answer: str, skill: Skill) -> float:
    """Bayes update of P(real) given one vote from a user with the given skill."""
    a = normalise_answer(answer)
    pr, pb = skill.p_real, skill.p_bogus
    p = _clip(p, P_MIN, P_MAX)
    if a == "real":
        num = p * pr
        den = num + (1 - p) * (1 - pb)
    else:
        num = p * (1 - pr)
        den = num + (1 - p) * pb
    return _clip(num / den, P_MIN, P_MAX)


def vote_weight(skill: Skill) -> float:
    """How much a vote counts toward crediting a patch: 0 for a coin-flipper, 1 for perfect."""
    return _clip(2 * skill.reliability - 1, 0.0, 1.0)


def points_for(answer: str, truth: str | None) -> int:
    if truth is None:
        return POINTS_VOTE
    return POINTS_TEST_CORRECT if normalise_answer(answer) == normalise_answer(truth) else POINTS_TEST_WRONG


def patch_credit(weighted_votes: float, needed: float = VOTES_TO_CREDIT_PATCH) -> float:
    """Fraction of a searched patch's exclusion power that the crowd has verified."""
    return _clip(weighted_votes / needed, 0.0, 1.0)


def is_test_card(draw: float, fraction: float = TEST_CARD_FRACTION) -> bool:
    """Given a uniform draw in [0,1), decide whether the next card is a secret test."""
    return draw < fraction
