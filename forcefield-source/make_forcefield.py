"""
Bakes the impact sprite for the barrier that keeps players on the plot.

    python forcefield-source/make_forcefield.py

WHAT IT IS. A classic cobweb: eight thick radial threads meeting at a hub, with
many thin rings strung between them, each SAGGING inward like a real thread
under its own weight. Generated procedurally to that structure — nothing is
traced or copied from any artwork.

WHY THE SAG IS THE WHOLE THING. An earlier version drew the rings as straight
chords between neighbouring spokes, which is geometrically defensible (a taut
thread IS straight) and reads as a polygon — a dartboard, or a shield lattice.
Real webs are not taut: every ring thread hangs between its two anchors and
bows toward the hub, and that curve is the single feature the eye uses to
identify a cobweb. So the ring's radius varies across each sector:

    r(a) = R * (1 - SAG/2 * (1 + cos(pi * a/h)))

with `a` the angle off the sector's bisector and h the half-sector. At the
spokes (a = ±h) the thread meets its anchor at full radius R; at the middle it
dips to R*(1-SAG). A plain straight chord only dips by 1-cos(h), which at eight
spokes is 7.6% and far too subtle to register.

A RAISED COSINE, not the parabola 1 - SAG*(1 - (a/h)^2) this started as. Both
have the same endpoints and the same mid-sector dip, but the parabola reaches
the anchor with non-zero slope — so every ring came to a sharp point on every
spoke, and fifteen of them stacked up read as concentric stars rather than as a
web. The cosine arrives tangentially, which is the smooth scallop a hanging
thread actually makes.

WHY EIGHT SPOKES, ALIGNED TO THE AXES. At 45° intervals starting at 0 they run
to the four corners AND the four edge midpoints of a square sprite, so the web
fills its frame instead of sitting as a circle inside it.

THE EDGE IS SOFTENED anyway, over the last stretch out to the corners. A web
drawn hard to the sprite boundary would show a square edge in-world and read as
a poster stuck on the fence rather than as something the player just hit.

RGB IS FLAT WHITE. Colour comes from the material at runtime (FORCE_FIELD_COLOR
and FORCE_FIELD_ALBEDO in config.ts), so the tint can change without a re-bake.
"""

import math
import os
import random
import struct
import zlib

SIZE = 256
SPOKES = 8            # thick radial threads, at 45° — corners and edge midpoints
RINGS = 15            # thin threads strung between the spokes
RING_START = 0.10     # first ring, as a fraction of the half-width
RING_END = 1.46       # last ring — past 1.0 so the web reaches the corners
RING_CURVE = 0.88     # <1 widens the spacing toward the rim
SAG = 0.13            # how far each ring bows toward the hub, mid-sector
SPOKE_HALF = 0.019    # spokes are the heavy threads...
RING_HALF = 0.0075    # ...and the rings are noticeably finer
JITTER_ANGLE = 0.018  # a little wobble; the reference structure is near-regular
JITTER_RING = 0.012
LINE_GAIN = 1.0
HUB_GAIN = 0.55       # the impact point; the spokes converging already darken it
HUB_TIGHT = 8.0
EDGE_START = 1.04     # softening begins here...
EDGE_END = 1.44       # ...and is complete by the corners
SEED = 5

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   'assets', 'scene', 'Textures', 'forcefield_hit.png')


def smoothstep(e0, e1, x):
    if e1 == e0:
        return 0.0
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def build():
    rng = random.Random(SEED)
    half = math.pi / SPOKES  # half a sector

    spoke_angles = [i * (2.0 * math.pi / SPOKES) + (rng.random() - 0.5) * 2 * JITTER_ANGLE
                    for i in range(SPOKES)]
    ring_radii = []
    for i in range(RINGS):
        f = (i / max(1, RINGS - 1)) ** RING_CURVE
        ring_radii.append(RING_START + (RING_END - RING_START) * f
                          + (rng.random() - 0.5) * 2 * JITTER_RING)

    px = bytearray(SIZE * SIZE * 4)
    c = (SIZE - 1) / 2.0
    for y in range(SIZE):
        ny = (y - c) / c
        for x in range(SIZE):
            nx = (x - c) / c
            r = math.hypot(nx, ny)
            theta = math.atan2(ny, nx)

            # Nearest radial thread, and the angle off it.
            a = math.pi
            for sa in spoke_angles:
                d = (theta - sa + math.pi) % (2.0 * math.pi) - math.pi
                if abs(d) < abs(a):
                    a = d

            # Perpendicular distance to the spoke, so thickness is constant in
            # space rather than in angle — otherwise spokes fan into wedges at
            # the rim and pinch away at the hub.
            spoke = 1.0 - smoothstep(0.0, SPOKE_HALF, r * math.sin(abs(a)))

            # Each ring sags toward the hub between its two anchors. See the
            # module docstring — this curve is what makes it read as a cobweb.
            t = a / half  # -1 at one spoke, +1 at the next
            # RAISED COSINE, not a parabola. Both dip to R*(1-SAG) mid-sector and
            # return to R at the anchors, but the parabola arrives with non-zero
            # slope, so every ring came to a sharp point on every spoke and the
            # web read as a stack of stars. This meets each spoke tangentially,
            # which is the smooth scallop a hanging thread actually makes.
            droop = 1.0 - SAG * 0.5 * (1.0 + math.cos(math.pi * t))
            ring = 0.0
            for rr in ring_radii:
                v = 1.0 - smoothstep(0.0, RING_HALF, abs(r - rr * droop))
                if v > ring:
                    ring = v

            web = max(spoke, ring)
            edge = 1.0 - smoothstep(EDGE_START, EDGE_END, r)
            hub = max(0.0, 1.0 - r) ** HUB_TIGHT

            alpha = max(0.0, min(1.0, web * edge * LINE_GAIN + hub * HUB_GAIN * edge))

            o = (y * SIZE + x) * 4
            px[o] = px[o + 1] = px[o + 2] = 255  # tinted at runtime
            px[o + 3] = int(round(alpha * 255))
    return px


def encode(path, size, px):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)
        raw += px[y * stride:(y + 1) * stride]

    def chunk(tag, body):
        return struct.pack('>I', len(body)) + tag + body + struct.pack('>I', zlib.crc32(tag + body) & 0xFFFFFFFF)

    out = b'\x89PNG\r\n\x1a\n'
    out += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    out += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    out += chunk(b'IEND', b'')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, 'wb').write(out)
    return len(out)


px = build()
alphas = [px[i * 4 + 3] for i in range(SIZE * SIZE)]
n = encode(OUT, SIZE, px)
print('%s  %dx%d  %.1f KB' % (OUT, SIZE, SIZE, n / 1024))
print('alpha: max %d  mean %.1f  threaded %.0f%%' % (
    max(alphas), sum(alphas) / len(alphas), 100 * sum(1 for a in alphas if a > 8) / len(alphas)))
