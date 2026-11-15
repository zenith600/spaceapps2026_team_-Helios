"""Inject sources with known properties into real SPHEREx exposures.

Backgrounds, noise, flags and PSFs are the real ones; only the injected signal is synthetic.
Each injected source has a sky trajectory and a flux model:

    position(t) = (ra0, dec0) + μ·(t − t0)                     (tangent plane, no parallax)
    flux(t, λ)  = F0 · (λ / 2 µm)^β · (1 + A·sin(2π(t − t0)/P + φ))

and an optional extra Gaussian blur (an extended, galaxy-like source: an ePSF ⊗ Gaussian
profile, not a Sérsic profile). It is drawn with the exposure's own ePSF at its own detector
zone and placed through the official WCS. Photon noise for the added signal is drawn with the
exposure's own variance-vs-signal slope (`noise_gain`), and the variance plane is updated.

Known simplification: placing sources through the official WCS means injected sources carry
no WCS error. Astrometric recovery therefore measures fitting error, not registration error;
registration error is measured separately on real Gaia stars.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from deepfield.astro import astrometry as A
from deepfield.astro.psf import EPSFModel


@dataclass
class Injected:
    id: str
    kind: str                      # static | moving | variable | steep | extended | blend
    ra0: float
    dec0: float
    t0_mjd: float
    flux0: float                   # ePSF-model flux units at λ = 2 µm
    snr_target: float
    pm: tuple = (0.0, 0.0)         # arcsec/yr (α*, δ)
    beta: float = 0.0
    amp: float = 0.0
    period_days: float = 100.0
    phase: float = 0.0
    blur_px: float = 0.0
    partner: str | None = None
    meta: dict = field(default_factory=dict)

    def position(self, mjd: float) -> tuple[float, float]:
        dt = (mjd - self.t0_mjd) / A.DAYS_PER_JULIAN_YEAR
        ra, dec = A.from_tangent_arcsec(self.pm[0] * dt, self.pm[1] * dt, self.ra0, self.dec0)
        return float(ra), float(dec)

    def flux(self, mjd: float, lam_um: float) -> float:
        var = 1.0 + self.amp * math.sin(2 * math.pi * (mjd - self.t0_mjd) / self.period_days + self.phase)
        return self.flux0 * (lam_um / 2.0) ** self.beta * var


def noise_gain(ex) -> float | None:
    """Slope k of variance vs signal above background (MJy/sr per unit image), from bright pixels.
    Photon noise for injected signal s is then N(0, k·s)."""
    good = ~ex.bad
    img, var = ex.image[good], ex.variance[good]
    if img.size < 100:
        return None
    b = np.median(img)
    sb = 1.4826 * np.median(np.abs(img - b))
    vb = np.median(var)
    sel = (img - b) > 20 * sb
    if sel.sum() < 5:
        return None
    k = (var[sel] - vb) / (img[sel] - b)
    k = k[np.isfinite(k) & (k > 0)]
    return float(np.median(k)) if k.size >= 5 else None


def inject(ex, sources: list[Injected], rng: np.random.Generator, gain: float, margin: int = 6, half: int = 6):
    """Return (image, variance, placed) with every source drawn into a copy of the exposure."""
    img = ex.image.copy()
    var = ex.variance.copy()
    ny, nx = img.shape
    placed = []
    for s in sources:
        ra, dec = s.position(ex.mjd)
        x, y = ex.wcs.all_world2pix([[ra, dec]], 0)[0]
        if not (margin <= x < nx - margin and margin <= y < ny - margin):
            continue
        lam, _ = ex.wavelength_at(x, y)
        f = s.flux(ex.mjd, lam)
        m = EPSFModel(ex.epsf_at(x, y), ex.oversample, blur_px=s.blur_px)
        xi, yi = int(round(x)), int(round(y))
        ys = slice(max(yi - half, 0), min(yi + half + 1, ny))
        xs = slice(max(xi - half, 0), min(xi + half + 1, nx))
        Y, X = np.mgrid[ys, xs]
        sig = f * m(X.astype(float), Y.astype(float), x, y)
        pos = np.clip(sig, 0, None)
        img[ys, xs] += sig + rng.normal(0.0, 1.0, sig.shape) * np.sqrt(gain * pos)
        var[ys, xs] += gain * pos
        placed.append({"id": s.id, "x": float(x), "y": float(y), "ra": ra, "dec": dec, "flux": float(f), "lam": lam})
    return img, var, placed


def population(rng, centre, radius_arcsec, t0, flux_per_snr, counts: dict, cfg: dict, avoid_sky=()) -> list[Injected]:
    """Random sources for one field. Positions avoid bright real sources (`avoid_sky`, 10″) and
    other sources of the same batch (15 px); a new batch starts every `batch_size` sources."""
    out = []
    taken = []
    batch = int(cfg.get("batch_size", 12))
    n_done = [0]

    def pick_pos():
        if n_done[0] and n_done[0] % batch == 0:
            taken.clear()                        # new batch: the previous batch is injected separately
        n_done[0] += 1
        for _ in range(500):
            r = radius_arcsec * math.sqrt(rng.uniform(0, 1))
            th = rng.uniform(0, 2 * math.pi)
            xi, eta = r * math.sin(th), r * math.cos(th)
            ra, dec = A.from_tangent_arcsec(xi, eta, *centre)
            if any(A.angular_sep_arcsec(ra, dec, a, b) < 10 for a, b in avoid_sky):
                continue
            if any(math.hypot(xi - a, eta - b) < 15 * 6.15 for a, b in taken):
                continue
            taken.append((xi, eta))
            return float(ra), float(dec)
        return None

    lo, hi = cfg["snr_range"]

    def snr():
        return float(math.exp(rng.uniform(math.log(lo), math.log(hi))))

    k = 0
    for kind, n in counts.items():
        for _ in range(n):
            p = pick_pos()
            if p is None:
                break
            s_snr = snr() if kind not in ("extended", "blend") else float(math.exp(rng.uniform(math.log(20), math.log(hi))))
            base = Injected(id=f"{kind}-{k}", kind=kind, ra0=p[0], dec0=p[1], t0_mjd=t0, flux0=s_snr * flux_per_snr, snr_target=s_snr,
                            meta={"batch": (n_done[0] - 1) // batch})
            if kind == "moving":
                mu = rng.uniform(*cfg["pm_range_arcsec_yr"])
                pa = rng.uniform(0, 2 * math.pi)
                base.pm = (mu * math.sin(pa), mu * math.cos(pa))
            elif kind == "variable":
                base.amp = float(rng.choice(cfg["var_amplitudes"]))
                base.period_days = float(rng.uniform(*cfg["var_period_days"]))
                base.phase = float(rng.uniform(0, 2 * math.pi))
            elif kind == "steep":
                base.beta = float(rng.choice(cfg["steep_beta"]))
            elif kind == "extended":
                base.blur_px = float(rng.choice(cfg["blur_px"]))
            elif kind == "blend":
                sep = rng.uniform(*cfg["blend_sep_px"]) * 6.15
                th = rng.uniform(0, 2 * math.pi)
                xi0, eta0 = A.tangent_offsets_arcsec(p[0], p[1], *centre)
                ra2, dec2 = A.from_tangent_arcsec(xi0 + sep * math.sin(th), eta0 + sep * math.cos(th), *centre)
                ratio = float(rng.uniform(1, 5))
                partner = Injected(id=f"blend-{k}-b", kind="blend_partner", ra0=float(ra2), dec0=float(dec2), t0_mjd=t0,
                                   flux0=base.flux0 / ratio, snr_target=s_snr / ratio, partner=base.id,
                                   meta={"sep_px": sep / 6.15, "ratio": ratio, "batch": base.meta["batch"]})
                base.partner = partner.id
                base.meta.update({"sep_px": sep / 6.15, "ratio": ratio})
                out.append(partner)
            out.append(base)
            k += 1
    return out
