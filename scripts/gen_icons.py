"""Generate the Tauri icon set from icons/app-icon-source.png without
needing the Tauri CLI (which needs `bun install` to finish first)."""
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "src-tauri" / "icons"
src = Image.open(ICONS / "app-icon-source.png").convert("RGBA")

# Plain PNGs referenced directly in tauri.conf.json's bundle.icon list.
for name, size in [("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256)]:
    src.resize((size, size), Image.Resampling.LANCZOS).save(ICONS / name)

# icon.ico (Windows) — Pillow writes a proper multi-resolution ICO.
src.save(ICONS / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

# icon.icns (macOS) via iconutil, which needs a .iconset directory.
iconset_sizes = [16, 32, 64, 128, 256, 512, 1024]
with tempfile.TemporaryDirectory() as tmp:
    iconset = Path(tmp) / "icon.iconset"
    iconset.mkdir()
    for size in iconset_sizes:
        src.resize((size, size), Image.Resampling.LANCZOS).save(iconset / f"icon_{size}x{size}.png")
        if size <= 512:
            src.resize((size * 2, size * 2), Image.Resampling.LANCZOS).save(iconset / f"icon_{size}x{size}@2x.png")
    subprocess.run(["iconutil", "-c", "icns", "-o", str(ICONS / "icon.icns"), str(iconset)], check=True)

print("wrote 32x32.png, 128x128.png, 128x128@2x.png, icon.ico, icon.icns")
