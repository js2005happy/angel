#!/usr/bin/env python3
"""Generate every desktop app icon from the official Nyra logo.

Sources (both checked in):
  docs/assets/nyra-mark.svg              official logo, used for 48 px and up
  desktop/icon-src/nyra-mark-small.svg   same mark, bolder cursor and fuller
                                         circle, used for 16/24/32 px so the
                                         cursor stays readable in title bars,
                                         the taskbar and Explorer lists

Writes desktop/src-tauri/icons/:
  icon.ico     16, 24, 32 (small mark) + 48, 64, 256 (logo), PNG entries
               -> exe resource, installer, desktop / Start menu shortcuts,
                  taskbar, window icon on Windows
  icon.icns    16, 32, 64 (16@2x/32 use small mark where 1x) + 128..1024
               -> macOS .app / Dock / Finder
  32x32.png, 128x128.png, 128x128@2x.png, icon.png (512)
and a preview sheet with every size (default ./nyra-icon-preview.png, or the
path given as the first argument).

Needs `rsvg-convert` (librsvg) and Pillow. Run from anywhere:
  python3 desktop/scripts/make_icons.py [preview.png]
"""

import io
import re
import struct
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
LOGO = ROOT / "docs" / "assets" / "nyra-mark.svg"
SMALL = ROOT / "desktop" / "icon-src" / "nyra-mark-small.svg"
OUT = ROOT / "desktop" / "src-tauri" / "icons"
SMALL_MAX = 32  # sizes <= this use the bold small mark


def app_icon_svg(src: Path) -> str:
    """The logo with its cursor filled white instead of see-through.

    The logo is a dark disc with the cursor cut out. On a dark Dock, taskbar
    or Start menu a see-through cursor vanishes, so app icons put a white
    disc (slightly smaller, so no white fringe at the rim) under the mark.
    On light backgrounds it looks exactly like the logo.
    """
    svg = src.read_text(encoding="utf-8")
    m = re.search(r'<circle cx="50" cy="50" r="([0-9.]+)"', svg)
    if not m:
        raise SystemExit(f"unexpected logo markup in {src}")
    under = f'<circle cx="50" cy="50" r="{float(m.group(1)) - 2:g}" fill="#FFFFFF"/>'
    return svg.replace(m.group(0), under + m.group(0), 1)


def render(size: int) -> bytes:
    src = SMALL if size <= SMALL_MAX else LOGO
    return subprocess.run(
        ["rsvg-convert", "-w", str(size), "-h", str(size)],
        input=app_icon_svg(src).encode("utf-8"), check=True, capture_output=True,
    ).stdout


def write_ico(path: Path, sizes) -> None:
    pngs = [render(s) for s in sizes]
    header = struct.pack("<HHH", 0, 1, len(sizes))
    offset = 6 + 16 * len(sizes)
    entries, blobs = b"", b""
    for s, data in zip(sizes, pngs):
        dim = 0 if s >= 256 else s
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    path.write_bytes(header + entries + blobs)


# (type, pixel size): https://en.wikipedia.org/wiki/Apple_Icon_Image_format
ICNS_TYPES = [
    (b"icp4", 16), (b"icp5", 32), (b"icp6", 64), (b"ic07", 128),
    (b"ic08", 256), (b"ic09", 512), (b"ic10", 1024),
    (b"ic11", 32), (b"ic12", 64), (b"ic13", 256), (b"ic14", 512),
]


def write_icns(path: Path) -> None:
    body = b""
    for kind, size in ICNS_TYPES:
        data = render(size)
        body += kind + struct.pack(">I", len(data) + 8) + data
    path.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)


def preview(path: Path) -> None:
    """Every shipped size at 1:1 on light and dark, plus 8x zoom of the small ones."""
    sizes = [16, 24, 32, 48, 64, 128, 256]
    pad, label_h = 24, 18
    width = sum(sizes) + pad * (len(sizes) + 1)
    zoom = [16, 24, 32]
    zoom_w = sum(s * 8 for s in zoom) + pad * (len(zoom) + 1)
    width = max(width, zoom_w)
    row_h = 256 + label_h + pad
    height = pad + row_h * 2 + 32 * 8 + label_h + pad * 2
    sheet = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(sheet)
    for row, bg in enumerate(["#FFFFFF", "#1F1F22"]):
        y0 = pad + row * row_h
        draw.rectangle([0, y0 - pad // 2, width, y0 + row_h - pad // 2], fill=bg)
        x = pad
        for s in sizes:
            icon = Image.open(io.BytesIO(render(s))).convert("RGBA")
            sheet.paste(icon, (x, y0 + 256 - s), icon)
            draw.text((x, y0 + 258), f"{s}", fill="#888888")
            x += s + pad
    y0 = pad + row_h * 2 + pad
    x = pad
    for s in zoom:
        icon = Image.open(io.BytesIO(render(s))).convert("RGBA").resize((s * 8, s * 8), Image.NEAREST)
        tile = Image.new("RGBA", icon.size, "#D9D9D9")
        tile.alpha_composite(icon)
        sheet.paste(tile, (x, y0))
        draw.text((x, y0 + s * 8 + 2), f"{s} px (8x)", fill="#555555")
        x += s * 8 + pad
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    write_ico(OUT / "icon.ico", [16, 24, 32, 48, 64, 256])
    write_icns(OUT / "icon.icns")
    for name, size in [("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256), ("icon.png", 512)]:
        (OUT / name).write_bytes(render(size))
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("nyra-icon-preview.png")
    preview(target)
    print(f"icons written to {OUT}; preview {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
