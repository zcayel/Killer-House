"""
THE HEART PIP, as a texture rather than a glyph.

    python tools/bake_heart_icon.py

WHY. The pips were text: U+2665 for a heart still held, U+2661 for one spent.
On the mobile client the hollow one draws and the FILLED one does not — U+2665
sits in the emoji range and gets routed to an emoji font the client has not
loaded, while U+2661 does not and falls through to the normal atlas. The visible
result is that a full health bar renders as nothing at all and only turns up
once you have started losing hearts, which is precisely backwards.

A texture has no atlas to miss. One shape, tinted at the use site: WAX for a
heart still held, ASH for one spent.

Same writer as tools/bake_tap_icon.py — white, shape carried in alpha, SDF
union supersampled 4x. No PIL on this machine.
"""

import math
import os
import struct
import sys
import zlib

SIZE = 128
SS = 4
OUT = os.path.join('assets', 'scene', 'Textures', 'heart_pip.png')


def sd_circle(px, py, cx, cy, r):
    return math.hypot(px - cx, py - cy) - r


def sd_triangle(px, py, ax, ay, bx, by, cx, cy):
    """Negative inside. Sign of the three edge cross-products, wound consistently."""
    d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
    d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
    d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
    neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return -1.0 if not (neg and pos) else 1.0


def glyph(px, py):
    """
    Two lobes and a wedge — the shape everyone draws when they draw a heart.

    The lobe centres sit slightly above the wedge's top edge so the union has no
    waist, and the wedge apex runs to 0.92 rather than 1.0 to leave the point
    inside the texture instead of flush against its edge.
    """
    d = sd_circle(px, py, 0.305, 0.345, 0.205)
    d = min(d, sd_circle(px, py, 0.695, 0.345, 0.205))
    d = min(d, sd_triangle(px, py, 0.108, 0.395, 0.892, 0.395, 0.500, 0.920))
    return d


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else OUT
    step = 1.0 / (SIZE * SS)
    rows, preview, covered = [], [], 0
    for y in range(SIZE):
        row, prow = bytearray(), bytearray()
        for x in range(SIZE):
            hits = 0
            for sy in range(SS):
                py = (y * SS + sy + 0.5) * step
                for sx in range(SS):
                    px = (x * SS + sx + 0.5) * step
                    if glyph(px, py) <= 0.0:
                        hits += 1
            a = int(round(255 * hits / (SS * SS)))
            if a:
                covered += 1
            row.extend((255, 255, 255, a))
            v = int(round(30 + 225 * (hits / (SS * SS))))
            prow.extend((v, v, v, 255))
        rows.append(row)
        preview.append(prow)

    write_png(out, SIZE, SIZE, rows)
    write_png(os.path.join(os.environ.get('TEMP', '.'), 'heart_pip_preview.png'), SIZE, SIZE, preview)
    frac = covered / (SIZE * SIZE)
    print(f'wrote {out}  {SIZE}x{SIZE}  {frac*100:.1f}% inked')
    if not (0.30 < frac < 0.65):
        raise SystemExit('coverage out of range — the shape is wrong')


def write_png(path, w, h, pixels):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw.extend(pixels[y])

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = bytes([137, 80, 78, 71, 13, 10, 26, 10])
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as fh:
        fh.write(png)


if __name__ == '__main__':
    main()
