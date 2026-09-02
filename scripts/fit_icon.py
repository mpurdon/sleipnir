"""Fit artwork to the macOS icon grid.

    python3 scripts/fit_icon.py in.png out.png

Scales and centres a squircle icon so its body is 824px on a 1024 canvas —
the Big Sur grid — leaving the 100px margin that makes it optically the same
size as every other icon in the Dock.

The body is found by thresholding alpha hard, because a soft drop shadow
reaches the canvas edge at low alpha and would otherwise be measured as part
of the icon. The shadow is kept: scaling the whole image by the body's factor
lands it in the margin, which is what the margin is for.
"""

import sys
from pathlib import Path

from PIL import Image

CANVAS = 1024
BODY = 824
SOLID_ALPHA = 200  # above the shadow, below the body


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    im = Image.open(src).convert("RGBA")

    solid = im.getchannel("A").point([0] * (SOLID_ALPHA + 1) + [255] * (255 - SOLID_ALPHA))
    bb = solid.getbbox()
    if bb is None:
        print("no solid body found — is the image fully transparent?")
        return 1
    bw, bh = bb[2] - bb[0], bb[3] - bb[1]
    print(f"source {im.size[0]}x{im.size[1]}, solid body {bw}x{bh} at {bb}")

    scale = BODY / max(bw, bh)
    new_size = (round(im.width * scale), round(im.height * scale))
    scaled = im.resize(new_size, Image.Resampling.LANCZOS)

    # Centre on the body's midpoint, not the source canvas's — the artwork may
    # be off-centre inside its own canvas, as this one was by 15px.
    cx = (bb[0] + bb[2]) / 2 * scale
    cy = (bb[1] + bb[3]) / 2 * scale
    out = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    out.alpha_composite(scaled, (round(CANVAS / 2 - cx), round(CANVAS / 2 - cy)))

    out.save(dst)
    check = out.getchannel("A").point([0] * (SOLID_ALPHA + 1) + [255] * (255 - SOLID_ALPHA)).getbbox()
    print(f"wrote {dst}")
    if check is not None:
        cw, ch = check[2] - check[0], check[3] - check[1]
        print(f"  body now {cw}x{ch} ({max(cw, ch) / CANVAS * 100:.1f}% of canvas, target 80.5%)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
