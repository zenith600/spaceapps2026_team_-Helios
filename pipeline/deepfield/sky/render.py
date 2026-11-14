"""Arrays -> PNGs for the sky viewer.

Two rules that matter for a blink movie:

1. **One stretch for every frame.** Limits are computed once from the whole set and
   reused, so a frame does not flicker brighter just because its own noise was higher.
   A per-frame stretch makes everything look like it is varying.
2. **Native resolution.** A 0.1 deg field is 59 SPHEREx pixels across; the PNG is 59 px
   and the browser scales it with `image-rendering: pixelated`. Upscaling here would
   multiply the payload by ~36 for no extra information, and the frames have to load
   fast enough to play as video.

FITS rows run bottom-up and PNG rows run top-down, so every array is flipped on write.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from deepfield.data.spherex import FLAG_BITS


def robust_limits(arrays, lo_pct: float = 1.0, hi_pct: float = 99.5) -> tuple[float, float]:
    """Percentile limits over a set of frames, ignoring NaN. Falls back to (0, 1) if empty."""
    vals = np.concatenate([np.asarray(a, dtype=np.float32).ravel() for a in arrays]) if len(arrays) else np.array([])
    vals = vals[np.isfinite(vals)]
    if vals.size == 0:
        return 0.0, 1.0
    lo, hi = float(np.percentile(vals, lo_pct)), float(np.percentile(vals, hi_pct))
    if not np.isfinite(lo) or not np.isfinite(hi) or hi <= lo:
        lo, hi = float(np.nanmin(vals)), float(np.nanmax(vals))
    if hi <= lo:
        hi = lo + 1e-6
    return lo, hi


def stretch(arr: np.ndarray, vmin: float, vmax: float, mode: str = "asinh") -> np.ndarray:
    """Scale to 0..1. asinh keeps faint structure visible without blowing out bright stars."""
    a = (np.asarray(arr, dtype=np.float32) - vmin) / max(vmax - vmin, 1e-12)
    if mode == "asinh":
        a = np.arcsinh(np.clip(a, -0.05, None) * 8.0) / np.arcsinh(8.0)
    elif mode == "sqrt":
        a = np.sqrt(np.clip(a, 0, None))
    return np.clip(a, 0.0, 1.0)


def write_png(arr: np.ndarray, path: Path, *, source: str, vmin: float, vmax: float,
              mode: str = "asinh", is_simulated: bool = False, extra: dict | None = None) -> Path:
    """Grayscale PNG with provenance in a text chunk. NaN (no data) renders as pure black."""
    from PIL import Image, PngImagePlugin
    a = np.asarray(arr, dtype=np.float32)
    bad = ~np.isfinite(a)
    img = stretch(np.nan_to_num(a, nan=vmin), vmin, vmax, mode)
    img[bad] = 0.0
    img8 = (255 * img).astype(np.uint8)[::-1]
    info = PngImagePlugin.PngInfo()
    info.add_text("source", ("SIMULATED | " if is_simulated else "") + source)
    info.add_text("scale", f"{mode} vmin={vmin:.6g} vmax={vmax:.6g} unit=MJy/sr")
    for k, v in (extra or {}).items():
        info.add_text(str(k), str(v))
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(img8, mode="L").save(path, pnginfo=info, optimize=True)
    return path


#: Flag classes drawn in the contamination overlay, in painting order.
#: Red = the pixel is unusable, amber = a known static source, blue = a transient event.
OVERLAY_CLASSES: tuple[tuple[str, tuple[int, int, int], tuple[str, ...]], ...] = (
    ("source", (245, 158, 11), ("SOURCE",)),
    ("transient", (96, 165, 250), ("TRANSIENT", "SNOWBALL")),
    ("artifact", (248, 113, 113), ("GHOST", "GHOST_FPA", "GHOST_EXT", "STREAK", "BLOOM", "HALO",
                                   "CROSSTALK", "PERSIST", "DICHROIC")),
    ("bad_pixel", (239, 68, 68), ("NONFUNC", "HOT", "COLD", "MISSING_DATA", "SUR_ERROR",
                                  "OVERFLOW", "NONLINEAR", "OUTLIER", "PHANMISS")),
)


def flag_summary(flags: np.ndarray) -> dict[str, float]:
    """Fraction of pixels carrying each flag bit. Only bits that actually appear."""
    f = np.asarray(flags, dtype=np.int64)
    n = max(f.size, 1)
    out = {}
    for name, bit in FLAG_BITS.items():
        frac = float(np.count_nonzero(f & bit) / n)
        if frac > 0:
            out[name] = round(frac, 5)
    return dict(sorted(out.items(), key=lambda kv: -kv[1]))


def write_flag_png(flags: np.ndarray, path: Path, *, source: str) -> Path:
    """Transparent RGBA overlay of the FLAGS bitmask, coloured by flag class."""
    from PIL import Image, PngImagePlugin
    f = np.asarray(flags, dtype=np.int64)
    rgba = np.zeros((*f.shape, 4), dtype=np.uint8)
    for _name, colour, bits in OVERLAY_CLASSES:
        mask = np.zeros(f.shape, dtype=bool)
        for b in bits:
            mask |= (f & FLAG_BITS[b]) != 0
        rgba[mask, 0:3] = colour
        rgba[mask, 3] = 150
    info = PngImagePlugin.PngInfo()
    info.add_text("source", source)
    info.add_text("legend", "; ".join(f"{n}={','.join(b)}" for n, _c, b in OVERLAY_CLASSES))
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba[::-1], mode="RGBA").save(path, pnginfo=info, optimize=True)
    return path


def write_rgb_png(r: np.ndarray, g: np.ndarray, b: np.ndarray, path: Path, *, source: str,
                  limits: list[tuple[float, float]], mode: str = "asinh",
                  extra: dict | None = None) -> Path:
    """False-colour composite: three wavelength groups into red, green and blue.

    SPHEREx sees in 102 infrared bands that no eye can perceive, so the honest way to show
    colour is to map the longest wavelengths to red and the shortest to blue, exactly as
    infrared images are conventionally presented. Each channel gets its own stretch, so a
    detector that happens to be more sensitive does not simply tint the whole field.

    Anything missing in a channel renders black there, which is why a saturated core can
    come out strongly coloured rather than white -- worth knowing before reading colour as
    composition.
    """
    from PIL import Image, PngImagePlugin
    planes = []
    for arr, (lo, hi) in zip((r, g, b), limits):
        a = np.asarray(arr, dtype=np.float32)
        img = stretch(np.nan_to_num(a, nan=lo), lo, hi, mode)
        img[~np.isfinite(a)] = 0.0
        planes.append((255 * img).astype(np.uint8))
    rgb = np.dstack(planes)[::-1]
    info = PngImagePlugin.PngInfo()
    info.add_text("source", source)
    info.add_text("mapping", "R = longest wavelengths, G = middle, B = shortest")
    for k, v in (extra or {}).items():
        info.add_text(str(k), str(v))
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgb, mode="RGB").save(path, pnginfo=info, optimize=True)
    return path


def overlay_legend() -> list[dict]:
    return [{"id": n, "colour": "#%02x%02x%02x" % c, "flags": list(b)} for n, c, b in OVERLAY_CLASSES]
