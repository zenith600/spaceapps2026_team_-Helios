"""Resolver: coordinate parsing, the built-in catalogue, and a network check against CDS Sesame."""
from __future__ import annotations

import math

import pytest

from deepfield.sky import resolver as R


def sep_arcsec(ra1, dec1, ra2, dec2) -> float:
    d1, d2 = math.radians(dec1), math.radians(dec2)
    dra = math.radians(ra1 - ra2)
    cos_sep = math.sin(d1) * math.sin(d2) + math.cos(d1) * math.cos(d2) * math.cos(dra)
    return math.degrees(math.acos(min(1.0, max(-1.0, cos_sep)))) * 3600.0


# --- coordinate strings ----------------------------------------------------

@pytest.mark.parametrize("text", [
    "08 55 10.831 -07 14 42.53",
    "08h55m10.831s -07d14m42.53s",
    "08:55:10.831 -07:14:42.53",
    "08 55 10.831, -07 14 42.53",
])
def test_sexagesimal_spellings_agree(text):
    """Every spelling of the WISE 0855 position in the challenge brief parses the same."""
    ra, dec = R.parse_coords(text)
    assert sep_arcsec(ra, dec, 133.795129, -7.245147) < 0.1


@pytest.mark.parametrize("text,expect", [
    ("133.795129 -7.245147", (133.795129, -7.245147)),
    ("133.795129, -7.245147", (133.795129, -7.245147)),
    ("  269.45208   +4.69336 ", (269.45208, 4.69336)),
])
def test_decimal_degrees(text, expect):
    ra, dec = R.parse_coords(text)
    assert ra == pytest.approx(expect[0])
    assert dec == pytest.approx(expect[1])


def test_decimal_out_of_range_is_an_error():
    with pytest.raises(ValueError):
        R.parse_coords("400 -7.2")


def test_a_name_is_not_a_coordinate():
    assert R.parse_coords("Barnard's Star") is None
    assert R.parse_coords("R Dra") is None


# --- built-in catalogue ----------------------------------------------------

def test_the_five_challenge_targets_resolve_offline():
    wanted = {"barnards-star", "epsilon-indi-b", "wise-0855", "rw-aurigae", "r-draconis"}
    assert {f["slug"] for f in R.featured()} == wanted
    for f in R.featured():
        t = R.resolve(f["name"], allow_network=False)
        assert t.resolver == "builtin"
        assert t.slug == f["slug"]


def test_every_target_tells_the_viewer_what_to_look_for():
    """The copy is the UI's whole onboarding: a list of images helps nobody who does not
    already know what they are looking at. Treat it as data that must be present."""
    for entry in R.catalogue():
        name = entry["name"]
        assert entry["look_for"], f"{name} has no 'what to look for' text"
        assert entry["kind"], f"{name} has no short kind label"
        assert 60 < len(entry["look_for"]) < 320, f"{name}: look_for should be a sentence or two"
        assert len(entry["kind"]) < 32, f"{name}: kind label is a chip, keep it short"
        assert entry["kind"] == entry["kind"].lower(), f"{name}: kind is rendered as a label"


def test_look_for_text_reaches_a_resolved_target():
    t = R.resolve("R Dra", allow_network=False)
    assert "saturat" in t.look_for, "R Draconis should warn about its saturated core"
    assert t.kind == "pulsating giant"


def test_typed_coordinates_have_no_invented_description():
    """We know nothing about an arbitrary coordinate; do not pretend otherwise."""
    t = R.resolve("133.795 -7.245", allow_network=False)
    assert t.look_for == "" and t.kind == ""


@pytest.mark.parametrize("alias,slug", [
    ("barnard's star", "barnards-star"),
    ("BARNARD", "barnards-star"),
    ("gj 699", "barnards-star"),
    ("wise 0855", "wise-0855"),
    ("WISE J0855-0714", "wise-0855"),
    ("rw aur", "rw-aurigae"),
    ("R Dra", "r-draconis"),
    ("eps ind b", "epsilon-indi-b"),
])
def test_aliases(alias, slug):
    assert R.resolve(alias, allow_network=False).slug == slug


def test_wise_0855_uses_the_brief_position():
    """The brief states RA 08h55m10.831s, Dec -7d14m42.53s. Use exactly that."""
    t = R.resolve("WISE 0855", allow_network=False)
    ra, dec = R.parse_coords("08 55 10.831 -07 14 42.53")
    assert sep_arcsec(t.ra_deg, t.dec_deg, ra, dec) < 0.1


def test_epsilon_indi_b_matches_its_2mass_designation():
    """2MASS J22041052-5646577 encodes the position; the catalogue must agree with it.

    Epsilon Indi B is ~400 arcsec from Epsilon Indi A, which is more than two of our
    default 0.1 deg fields, so pointing at the wrong one of the pair shows empty sky.
    """
    t = R.resolve("eps Ind B", allow_network=False)
    ra, dec = R.parse_coords("22 04 10.52 -56 46 57.7")
    assert sep_arcsec(t.ra_deg, t.dec_deg, ra, dec) < 1.0
    a_ra, a_dec = R.parse_coords("22 03 21.65 -56 47 09.5")   # Epsilon Indi A
    assert sep_arcsec(t.ra_deg, t.dec_deg, a_ra, a_dec) > 300.0


def test_unresolvable_name_offline_raises_with_help():
    with pytest.raises(LookupError, match="Barnard"):
        R.resolve("not a real object xyzzy", allow_network=False)


# --- network -----------------------------------------------------------------

@pytest.mark.network
@pytest.mark.parametrize("name", ["Barnard's Star", "RW Aur", "R Dra", "eps Ind Ba", "Proxima Centauri"])
def test_builtin_coordinates_match_sesame(name):
    """Guard against the offline catalogue drifting from the real sky.

    SPHEREx pixels are 6.15 arcsec and the smallest field of view we offer is 0.05 deg
    (180 arcsec), so 30 arcsec is a generous but meaningful tolerance. Skipped if CDS is
    unreachable — this test must never fail the build because a server was down.
    """
    hit = R.resolve_sesame(name)
    if hit is None:
        pytest.skip("CDS Sesame unreachable")
    ra, dec, _ = hit
    ours = R.resolve(name, allow_network=False)
    assert sep_arcsec(ra, dec, ours.ra_deg, ours.dec_deg) < 30.0, f"{name}: builtin drifted from Sesame"
