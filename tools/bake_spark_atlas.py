"""Bake the lightning SPARK atlas — assets/scene/Textures/spark_arc.png.

WHAT AND WHY. The spark warning (lightning.ts) telegraphs where a bolt is about
to land. It started as plain untextured quads, which read as dots. The look
asked for is a curled electric arc: a white-hot filament hooking round on
itself, wrapped in a blue glow, with a few detached chips flung off it.

DRAWN HERE RATHER THAN DOWNLOADED, for the same reason the electrocution burst
is (see ELECTROCUTION_TEXTURE in config.ts): a generated texture carries no
licence and no attribution to lose track of. It also means the shapes can be
re-rolled with --seed until a set looks right, instead of being stuck with
whatever a stock pack happened to contain.

NO PIL IN THIS ENVIRONMENT, so this writes the PNG itself — zlib for the pixel
stream, struct for the chunk headers. That is about thirty lines and avoids a
dependency the project does not otherwise need.

    python tools/bake_spark_atlas.py            # 2x2 atlas, 256px cells
    python tools/bake_spark_atlas.py --seed 7   # a different set of four

The atlas is 2x2 because lightning.ts picks a cell per spark and re-picks each
time one re-seeds; four shapes plus the horizontal flip it also applies gives
eight apparent variants, which is past the point anyone counts.
"""
import math
import os
import struct
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets', 'scene', 'Textures', 'spark_arc.png')

CELL = 256
GRID = 2

# Matched to LIGHTNING_COLOR (0.72, 0.82, 1.0) at the core and driven into a
# saturated blue at the rim, so a spark reads as the same electricity as the
# bolt it is warning about rather than as a separate blue effect.
CORE = (1.00, 1.00, 1.00)
MID = (0.42, 0.66, 1.00)
RIM = (0.10, 0.28, 0.95)


class Rng:
    """Deterministic LCG, so a given --seed always bakes the same atlas."""

    def __init__(self, seed):
        self.s = (seed * 6364136223846793005 + 1442695040888963407) & ((1 << 64) - 1)

    def next(self):
        self.s = (self.s * 6364136223846793005 + 1442695040888963407) & ((1 << 64) - 1)
        return ((self.s >> 33) & 0x7FFFFFFF) / float(0x7FFFFFFF)

    def range(self, lo, hi):
        return lo + (hi - lo) * self.next()


def arc_path(rng, cx, cy, radius):
    """A curled, uneven arc: a partial ring whose radius wanders as it sweeps.

    The wander is two sine terms at unrelated rates, which is what stops it
    reading as a circle with noise on it and makes it hook and pinch the way a
    real arc does.
    """
    a0 = rng.range(0, math.tau)
    sweep = rng.range(3.4, 5.2)
    k1, k2 = rng.range(1.2, 2.4), rng.range(3.0, 5.0)
    p1, p2 = rng.range(0, math.tau), rng.range(0, math.tau)
    squash = rng.range(0.78, 1.0)
    pts = []
    steps = 90
    for i in range(steps + 1):
        t = i / steps
        a = a0 + sweep * t
        r = radius * (0.78 + 0.20 * math.sin(t * math.tau * k1 + p1)
                      + 0.07 * math.sin(t * math.tau * k2 + p2))
        pts.append((cx + math.cos(a) * r, cy + math.sin(a) * r * squash, t))
    return pts


def stroke(field, pts, wmax, taper=True):
    """Lay a tapered stroke down the path, keeping the strongest value per pixel.

    Only pixels inside each segment's bounding box are touched. Evaluating the
    full 256x256 against every segment is 5.9M distance tests per cell and takes
    the better part of a minute in pure Python; the box makes it a second.
    """
    for i in range(len(pts) - 1):
        x0, y0, t0 = pts[i]
        x1, y1, _ = pts[i + 1]
        # Thick through the middle, tapering to nothing at both ends.
        w = wmax * (math.sin(math.pi * t0) ** 0.55) if taper else wmax
        if w <= 0.2:
            continue
        # BIG ENOUGH FOR THE HALO, not just the filament. At 3.2 the box cut
        # the glow off mid-fade and every shape sat in a visible square. The
        # halo below is a 4th-power falloff specifically so it reaches the
        # cutoff by ~7w and this stays affordable.
        reach = w * 7.5
        lo_x = max(0, int(min(x0, x1) - reach))
        hi_x = min(CELL - 1, int(max(x0, x1) + reach))
        lo_y = max(0, int(min(y0, y1) - reach))
        hi_y = min(CELL - 1, int(max(y0, y1) + reach))
        dx, dy = x1 - x0, y1 - y0
        seg2 = dx * dx + dy * dy
        for py in range(lo_y, hi_y + 1):
            row = field[py]
            for px in range(lo_x, hi_x + 1):
                if seg2 > 0:
                    u = ((px - x0) * dx + (py - y0) * dy) / seg2
                    u = 0.0 if u < 0 else (1.0 if u > 1 else u)
                else:
                    u = 0.0
                ex, ey = px - (x0 + dx * u), py - (y0 + dy * u)
                d = math.sqrt(ex * ex + ey * ey)
                # TWO TERMS, not one. A single falloff cannot be both a hard
                # filament and a wide glow: tighten it and the halo vanishes,
                # loosen it and the core turns to mush. The cubed term is the
                # filament, the squared wide term is the light coming off it.
                core = w / (d + w * 0.5)
                core = core * core * core
                halo = (w * 1.9) / (d + w * 1.9)
                halo = halo * halo
                halo = halo * halo * 0.62
                v = core if core > halo else halo
                if v > row[px]:
                    row[px] = v


def bake_cell(rng):
    field = [[0.0] * CELL for _ in range(CELL)]
    cx, cy = CELL * 0.5, CELL * 0.5
    radius = CELL * rng.range(0.26, 0.32)

    main = arc_path(rng, cx, cy, radius)
    stroke(field, main, CELL * rng.range(0.028, 0.036))

    # A short fork peeling off the main arc, which is most of what separates an
    # electric arc from a drawn squiggle.
    start = int(len(main) * rng.range(0.25, 0.6))
    fx, fy, _ = main[start]
    fa = rng.range(0, math.tau)
    flen = CELL * rng.range(0.10, 0.18)
    fork = []
    fsteps = 26
    for i in range(fsteps + 1):
        t = i / fsteps
        a = fa + math.sin(t * 4.0) * 0.9
        fork.append((fx + math.cos(a) * flen * t, fy + math.sin(a) * flen * t, t))
    stroke(field, fork, CELL * rng.range(0.016, 0.022))

    # Chips: little detached fragments thrown clear of the arc.
    for _ in range(int(rng.range(2, 5))):
        a = rng.range(0, math.tau)
        rr = radius * rng.range(0.95, 1.45)
        px, py = cx + math.cos(a) * rr, cy + math.sin(a) * rr
        ln = CELL * rng.range(0.015, 0.045)
        ang = rng.range(0, math.tau)
        chip = [(px, py, 0.5), (px + math.cos(ang) * ln, py + math.sin(ang) * ln, 0.5)]
        stroke(field, chip, CELL * rng.range(0.008, 0.013), taper=False)

    return field


def shade(v):
    """Field value -> RGBA. White filament, blue body, blue glow, clear edge."""
    if v <= 0.004:
        return (0, 0, 0, 0)
    v = min(1.0, v)
    if v > 0.55:
        k = (v - 0.55) / 0.45
        r = MID[0] + (CORE[0] - MID[0]) * k
        g = MID[1] + (CORE[1] - MID[1]) * k
        b = MID[2] + (CORE[2] - MID[2]) * k
    else:
        k = v / 0.55
        r = RIM[0] + (MID[0] - RIM[0]) * k
        g = RIM[1] + (MID[1] - RIM[1]) * k
        b = RIM[2] + (MID[2] - RIM[2]) * k
    # Alpha rises faster than colour so the halo stays translucent while the
    # filament goes fully opaque.
    a = min(1.0, v * 1.7) ** 0.8
    return (int(r * 255), int(g * 255), int(b * 255), int(a * 255))


def write_png(path, w, h, pixels):
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter type 0 (None) for this scanline
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


def main():
    seed = 3
    if '--seed' in sys.argv:
        seed = int(sys.argv[sys.argv.index('--seed') + 1])
    rng = Rng(seed)

    size = CELL * GRID
    rows = [bytearray(size * 4) for _ in range(size)]
    for cell in range(GRID * GRID):
        field = bake_cell(rng)
        ox = (cell % GRID) * CELL
        oy = (cell // GRID) * CELL
        for y in range(CELL):
            row = rows[oy + y]
            src = field[y]
            for x in range(CELL):
                r, g, b, a = shade(src[x])
                i = (ox + x) * 4
                row[i] = r
                row[i + 1] = g
                row[i + 2] = b
                row[i + 3] = a
        print('  cell %d baked' % cell)

    write_png(OUT, size, size, rows)
    lit = sum(1 for row in rows for i in range(3, len(row), 4) if row[i] > 8)
    print()
    print('wrote %s' % os.path.relpath(OUT, ROOT).replace(os.sep, '/'))
    print('  %dx%d, %dx%d grid of %dpx cells, seed %d' % (size, size, GRID, GRID, CELL, seed))
    print('  %.1f%% of pixels carry alpha' % (lit / float(size * size) * 100))
    print('  %.1f KB' % (os.path.getsize(OUT) / 1024.0))


main()
