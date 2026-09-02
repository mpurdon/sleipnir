"""Check a candidate app icon against the macOS grid, and show it at every
size it will actually be rendered at.

    python3 scripts/check_icon.py path/to/icon.png

Exits non-zero if a hard requirement fails. The soft checks are advice, not
gates — an icon that deliberately breaks the grid (a shape that protrudes,
say) is a decision, not a bug.

Writes a contact sheet next to the input as <name>-contact.png: every real
size on three backgrounds, because an icon that reads on the Dock's dark
grey can still disappear in a white Finder list.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

# Apple's macOS grid, Big Sur onwards. On a 1024 canvas the icon body is an
# 824 square with a 185.4px continuous ("squircle") corner radius, leaving a
# 100px margin. The margin is not padding to be reclaimed: it is what makes
# your icon optically the same size as every other icon in the Dock. Filling
# the canvas edge to edge — which the current artwork does — renders visibly
# larger and squarer than its neighbours.
CANVAS = 1024
BODY = 824
CORNER_RADIUS = 185.4
BODY_RATIO = BODY / CANVAS          # 0.8047
RADIUS_RATIO = CORNER_RADIUS / BODY  # 0.225

# Every size gen_icons.py emits, from the .icns iconset, the .ico, and the
# loose PNGs. 16px is the one that decides whether the design works.
RENDER_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024]

# Above a soft shadow, below the icon body.
SOLID_ALPHA = 200

BACKGROUNDS = [
    ("dock", (46, 48, 54)),
    ("light", (245, 245, 247)),
    ("mid", (128, 128, 128)),
]


def fail(msg: str) -> None:
    print(f"  FAIL  {msg}")


def warn(msg: str) -> None:
    print(f"  warn  {msg}")


def ok(msg: str) -> None:
    print(f"  ok    {msg}")


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    path = Path(sys.argv[1])
    if not path.exists():
        print(f"no such file: {path}")
        return 2

    im = Image.open(path).convert("RGBA")
    w, h = im.size
    hard_failures = 0

    print(f"\n{path.name} — {w}x{h}\n")

    print("Hard requirements")
    if w != h:
        fail(f"not square ({w}x{h}); every output is a square resize")
        hard_failures += 1
    else:
        ok("square")

    if min(w, h) < CANVAS:
        fail(f"smaller than {CANVAS}px; the .icns needs a {CANVAS}px rendition")
        hard_failures += 1
    else:
        ok(f"at least {CANVAS}px")

    alpha = im.getchannel("A")
    if alpha.getextrema()[0] == 255:
        fail("fully opaque; the corners outside the squircle must be transparent")
        hard_failures += 1
    else:
        ok("has transparency")

    print("\nmacOS grid")
    # Threshold hard before measuring: a soft drop shadow reaches the canvas
    # edge at low alpha, and measuring it as part of the body reports ~98% for
    # artwork that is actually on the grid.
    solid = alpha.point([0] * (SOLID_ALPHA + 1) + [255] * (255 - SOLID_ALPHA))
    bbox = solid.getbbox()
    if bbox is None:
        fail("image is entirely transparent")
        return 1
    bw, bh = bbox[2] - bbox[0], bbox[3] - bbox[1]
    body_frac = max(bw, bh) / w
    print(f"        content spans {bw}x{bh} = {body_frac * 100:.1f}% of the canvas")
    if abs(body_frac - BODY_RATIO) <= 0.02:
        ok(f"matches the {BODY}/{CANVAS} body ratio ({BODY_RATIO * 100:.1f}%)")
    elif body_frac > BODY_RATIO + 0.02:
        warn(
            f"larger than the grid — will look oversized beside other icons. "
            f"Target {BODY_RATIO * 100:.1f}% (a {round(w * BODY_RATIO)}px body on this canvas)"
        )
    else:
        warn(f"smaller than the grid — will look undersized. Target {BODY_RATIO * 100:.1f}%")

    cx = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
    off = abs(cx[0] - w / 2), abs(cx[1] - h / 2)
    if max(off) > w * 0.01:
        warn(f"content is off-centre by ({off[0]:.0f}, {off[1]:.0f})px")
    else:
        ok("centred")

    print(f"\n        corner radius for this canvas: {w * BODY_RATIO * RADIUS_RATIO:.1f}px "
          f"on a {w * BODY_RATIO:.0f}px body ({RADIUS_RATIO * 100:.1f}% of the body)")
    print("        use a CONTINUOUS corner (squircle), not a plain rounded rectangle")

    print("\nLegibility")
    # Two different things, and conflating them cries wolf. Tonal spread is
    # whether the SUBJECT reads; mean-vs-background is whether the SILHOUETTE
    # separates. A deliberately dark icon with a bright subject scores low on
    # the second and is perfectly legible — so a strong spread excuses it.
    small = im.resize((16, 16), Image.Resampling.LANCZOS)
    for name, bg in BACKGROUNDS[:2]:
        comp = Image.alpha_composite(Image.new("RGBA", (16, 16), bg + (255,)), small).convert("L")
        vals = list(comp.tobytes())
        spread = max(vals) - min(vals)
        bg_lum = int(0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2])
        mean_delta = abs(sum(vals) / len(vals) - bg_lum)
        (ok if spread >= 90 else warn)(f"at 16px on {name}: subject contrast {spread} (want 90+)")
        if mean_delta < 25 and spread < 140:
            warn(f"  and the silhouette barely separates from {name} (mean delta {mean_delta:.0f})")

    # Contact sheet.
    pad, label_w = 18, 70
    row_h = 128 + pad
    sheet_w = label_w + sum(min(s, 128) + pad for s in RENDER_SIZES) + pad
    sheet = Image.new("RGB", (sheet_w, pad + len(BACKGROUNDS) * row_h), (30, 30, 32))
    d = ImageDraw.Draw(sheet)
    y = pad
    for name, bg in BACKGROUNDS:
        d.rectangle([label_w, y, sheet_w, y + 128], fill=bg)
        d.text((10, y + 58), name, fill=(220, 220, 220))
        x = label_w + pad
        for s in RENDER_SIZES:
            shown = min(s, 128)
            r = im.resize((shown, shown), Image.Resampling.LANCZOS)
            sheet.paste(
                Image.alpha_composite(Image.new("RGBA", (shown, shown), bg + (255,)), r).convert("RGB"),
                (x, y + (128 - shown) // 2),
            )
            x += shown + pad
        y += row_h
    out = path.with_name(path.stem + "-contact.png")
    sheet.save(out)
    print(f"\ncontact sheet: {out}")
    print(f"sizes shown:   {', '.join(str(s) for s in RENDER_SIZES)} (capped at 128 for the sheet)")

    if hard_failures:
        print(f"\n{hard_failures} hard requirement(s) failed\n")
        return 1
    print("\nhard requirements passed\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
