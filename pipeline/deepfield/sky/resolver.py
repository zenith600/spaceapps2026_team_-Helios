"""Turn whatever the user typed into (RA, Dec).

Order of attempts:
  1. the built-in catalogue  — works offline, covers the five challenge test targets
  2. a coordinate string     — decimal degrees or sexagesimal, several spellings
  3. CDS Sesame              — optional network call, allowlisted in manifest.yaml

The built-in coordinates are checked against Sesame by tests/test_sky_resolver.py
(network test, skipped when offline), so the offline path cannot silently drift.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import asdict, dataclass
from urllib.parse import quote

SESAME_URL = "https://cds.unistra.fr/cgi-bin/nph-sesame/-oI/SNV"


@dataclass(frozen=True)
class Target:
    query: str          # what the user typed
    name: str           # display name
    ra_deg: float
    dec_deg: float
    resolver: str       # builtin | coords | sesame
    note: str = ""
    slug: str = ""
    look_for: str = ""  # plain-language "what to watch for", shown above the player
    kind: str = ""      # short human label, e.g. "moving star"

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class _Known:
    slug: str
    name: str
    ra_deg: float
    dec_deg: float
    note: str
    aliases: tuple[str, ...]
    featured: bool = False
    #: One plain sentence telling a first-time viewer what to actually watch for. The whole
    #: point of the tool is spotting change, and "here are 93 images" does not help anyone
    #: who does not already know what they are looking at.
    look_for: str = ""
    kind: str = ""          # short human label: "moving star", "variable star", ...


# ---------------------------------------------------------------------------
# Built-in catalogue. The five featured entries are the challenge's test targets.
# Coordinates are ICRS/J2000 degrees. Where the challenge brief states a position
# (WISE 0855) that is the value used, verbatim.
# ---------------------------------------------------------------------------
CATALOGUE: tuple[_Known, ...] = (
    _Known(
        "barnards-star", "Barnard's Star", 269.45207696, 4.69336497,
        "The fastest-moving star on the sky: 10.3 arcsec per year, about 1.7 SPHEREx pixels "
        "per year. Six light years away. The classic proper-motion target.",
        ("barnard", "barnards star", "barnard's star", "barnard star", "gj 699", "gl 699",
         "hip 87937", "v2500 oph"), featured=True,
        kind="moving star",
        look_for="Watch the bright star at the centre creep against the fixed background. "
                 "It shifts about one SPHEREx pixel per year — the fastest motion of any star "
                 "in the sky."),
    _Known(
        # Position decoded from the 2MASS designation 2MASS J22041052-5646577, which is
        # the discovery identifier for this pair: 22h04m10.52s, -56d46m57.7s.
        # Note this is Epsilon Indi *B*, about 400 arcsec from Epsilon Indi A -- far enough
        # that pointing at A would miss the brown dwarfs entirely at our default 0.1 deg field.
        "epsilon-indi-b", "Epsilon Indi Ba/Bb", 331.043833, -56.782694,
        "A pair of brown dwarfs (T1 + T6) orbiting the nearby star Epsilon Indi A, about "
        "400 arcsec away from it. Cold, methane-rich, and bright in the near infrared.",
        ("eps ind b", "epsilon indi b", "eps ind ba", "epsilon indi ba", "eps indi b",
         "epsilon ind b", "eps ind bab", "2mass j22041052-5646577"), featured=True,
        kind="brown dwarf pair",
        look_for="Two failed stars too small to burn, orbiting each other. They are cold and "
                 "methane-rich, so they are far brighter in infrared than in visible light — "
                 "click the centre to see that in the spectrum."),
    _Known(
        "wise-0855", "WISE 0855-0714", 133.795129, -7.245147,
        "The coldest known brown dwarf, 250 K, 7.5 light years away. Moves about 8 arcsec "
        "per year. Water-ice clouds. Position as given in the challenge brief.",
        ("wise 0855", "wise0855", "wise j0855", "wise 0855-0714", "wise j0855-0714",
         "wise j085510.83-071442.5", "w0855"), featured=True,
        kind="coldest brown dwarf",
        look_for="The coldest object of its kind ever found — about -23 C, cold enough for "
                 "water-ice clouds. It is 7.5 light years away and drifts roughly one SPHEREx "
                 "pixel every nine months, so watch the centre across the full time-lapse."),
    _Known(
        "rw-aurigae", "RW Aurigae", 76.95652603, 30.40143817,
        "A young binary T Tauri star that dims by magnitudes for months at a time when its "
        "tidally disrupted disc passes in front of it. Brightness, not position, is the story.",
        ("rw aur", "rw aurigae", "rw aur a", "hd 240764"), featured=True,
        kind="young star with a torn disc",
        look_for="This one does not move — it blinks. A newborn star whose dusty disc has been "
                 "torn by a passing companion; when a streamer of that dust drifts across our "
                 "line of sight the star fades for months. Watch its brightness, not its position."),
    _Known(
        "r-draconis", "R Draconis", 248.16761083, 66.75497942,
        "A Mira variable: a pulsating red giant that swings about 8 magnitudes over a "
        "245-day period. Enormous in the near infrared.",
        ("r dra", "r draconis", "hip 80488"), featured=True,
        kind="pulsating giant",
        look_for="A dying red giant that swells and shrinks over about 245 days, changing "
                 "brightness by a factor of a thousand. It is so bright here that its core "
                 "saturates the detector — click slightly off-centre for a spectrum."),
    # A few extras that make good demos.
    _Known(
        "proxima-centauri", "Proxima Centauri", 217.42895, -62.67948,
        "The nearest star. 3.85 arcsec per year of proper motion plus a large parallax wobble.",
        ("proxima", "proxima cen", "proxima centauri", "alpha cen c", "gj 551"),
        kind="nearest star",
        look_for="The closest star to the Sun, with a known planet in its habitable zone. "
                 "It both drifts and wobbles, because it is near enough that Earth's own orbit "
                 "shifts its apparent position."),
    _Known(
        "luhman-16", "Luhman 16 AB", 162.32883, -53.31944,
        "The nearest brown dwarf binary, 6.5 light years away, moving 2.8 arcsec per year.",
        ("luhman 16", "luhman16", "wise 1049-5319", "wise j1049-5319"),
        kind="brown dwarf pair",
        look_for="The nearest pair of brown dwarfs, 6.5 light years away, with weather: one of "
                 "them has clouds that change its brightness as it rotates."),
    _Known(
        "teegardens-star", "Teegarden's Star", 43.25371, 16.88128,
        "A nearby red dwarf with two temperate planets and 5 arcsec per year of proper motion.",
        ("teegarden", "teegardens star", "teegarden's star", "2mass j02530084+1652532"),
        kind="moving star",
        look_for="A small, cool red dwarf 12 light years away with two planets that could hold "
                 "liquid water. It moves noticeably against the background."),
)

_BY_KEY: dict[str, _Known] = {}
for _k in CATALOGUE:
    for _a in (_k.slug, _k.name, *_k.aliases):
        _BY_KEY[_a.lower().replace("'", "").replace("-", " ").strip()] = _k


def _entry(k: _Known) -> dict:
    return {"slug": k.slug, "name": k.name, "ra_deg": k.ra_deg, "dec_deg": k.dec_deg,
            "note": k.note, "look_for": k.look_for, "kind": k.kind, "featured": k.featured}


def featured() -> list[dict]:
    """The challenge test targets, for the viewer's quick-pick row."""
    return [_entry(k) for k in CATALOGUE if k.featured]


def catalogue() -> list[dict]:
    return [_entry(k) for k in CATALOGUE]


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).strip()
    return re.sub(r"\s+", " ", s.lower().replace("'", "").replace("-", " ")).strip()


def slugify(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return s or "target"


# ---------------------------------------------------------------------------
# Coordinate strings
# ---------------------------------------------------------------------------
_NUM = r"[-+]?\d+(?:\.\d+)?"
_DECIMAL_PAIR = re.compile(rf"^\s*({_NUM})\s*[,\s]\s*({_NUM})\s*$")


def parse_coords(text: str) -> tuple[float, float] | None:
    """Parse a coordinate string. Returns (ra_deg, dec_deg), or None if it is not one.

    Accepted:
      133.795 -7.245            decimal degrees
      133.795, -7.245
      08 55 10.831 -07 14 42.53 sexagesimal (RA in hours)
      08h55m10.831s -07d14m42.53s
      08:55:10.831 -07:14:42.53
    """
    s = text.strip()
    if not s:
        return None

    m = _DECIMAL_PAIR.match(s)
    if m:
        ra, dec = float(m.group(1)), float(m.group(2))
        if not (0.0 <= ra <= 360.0 and -90.0 <= dec <= 90.0):
            raise ValueError(f"coordinates out of range: RA {ra}, Dec {dec}")
        return ra, dec

    if not re.search(r"[hdms:]|\s\d+\s+\d", s, re.IGNORECASE):
        return None

    from astropy import units as u
    from astropy.coordinates import SkyCoord

    cleaned = s.replace(",", " ")
    for attempt in (cleaned, _split_six(cleaned)):
        if attempt is None:
            continue
        try:
            c = SkyCoord(attempt, unit=(u.hourangle, u.deg), frame="icrs")
            return float(c.ra.deg), float(c.dec.deg)
        except Exception:
            continue
    return None


def _split_six(s: str) -> str | None:
    """`08 55 10.831 -07 14 42.53` -> `08 55 10.831 -07 14 42.53` split into two halves."""
    parts = re.split(r"\s+", s.strip())
    if len(parts) != 6:
        return None
    return " ".join(parts[:3]) + " " + " ".join(parts[3:])


# ---------------------------------------------------------------------------
# Sesame
# ---------------------------------------------------------------------------
def resolve_sesame(name: str, timeout: float = 25.0) -> tuple[float, float, str] | None:
    """Ask CDS Sesame. Returns (ra, dec, resolved_name) or None. Never raises on network trouble.

    CDS redirects to whichever VizieR mirror its load balancer picks; `fetch` validates
    every hop against the allowlist, so a redirect to a disallowed mirror lands here as
    a refusal and we simply report "not resolved" rather than fetching it.
    """
    from deepfield.data.manifest import fetch
    try:
        r = fetch(f"{SESAME_URL}?{quote(name)}", timeout=timeout, retries=0)
    except Exception:
        return None
    ra = dec = None
    resolved = name
    for line in r.text.splitlines():
        if line.startswith("%J ") and ra is None:
            bits = line[3:].split()
            try:
                ra, dec = float(bits[0]), float(bits[1])
            except (IndexError, ValueError):
                return None
        elif line.startswith("%I ") and resolved == name:
            resolved = line[3:].strip()
    if ra is None:
        return None
    return ra, dec, resolved


# ---------------------------------------------------------------------------
# The entry point
# ---------------------------------------------------------------------------
def resolve(query: str, *, allow_network: bool = True) -> Target:
    """Resolve a name or coordinate string to a Target. Raises LookupError if nothing works."""
    q = (query or "").strip()
    if not q:
        raise LookupError("empty query")

    known = _BY_KEY.get(_norm(q))
    if known is not None:
        return Target(q, known.name, known.ra_deg, known.dec_deg, "builtin", known.note, known.slug,
                      known.look_for, known.kind)

    try:
        coords = parse_coords(q)
    except ValueError as exc:
        raise LookupError(str(exc)) from exc
    if coords is not None:
        ra, dec = coords
        name = f"RA {ra:.5f} Dec {dec:+.5f}"
        return Target(q, name, ra, dec, "coords", "", slugify(f"{ra:.5f}{dec:+.5f}"))

    if allow_network:
        hit = resolve_sesame(q)
        if hit is not None:
            ra, dec, resolved = hit
            return Target(q, resolved, ra, dec, "sesame",
                          "Resolved by CDS Sesame (SIMBAD/NED/VizieR).", slugify(resolved))

    raise LookupError(
        f"could not resolve {q!r}. Try coordinates like '08 55 10.831 -07 14 42.53' "
        f"or '133.795 -7.245', or one of: " + ", ".join(k.name for k in CATALOGUE if k.featured))
