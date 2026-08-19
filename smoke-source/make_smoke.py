"""
Bakes the soft smoke puff the candle particle systems sprite.

    python smoke-source/make_smoke.py

WHY GENERATE IT RATHER THAN SHIP ART. A smoke puff is a radial alpha falloff and
nothing else — there is no detail in it worth an artist's time, and a hand-drawn
one would only be a circle with a blur. Generating it means the shape is a
handful of constants instead of a binary nobody can edit.

WHY IT IS NOT A PLAIN RADIAL GRADIENT. A perfect circle reads as a circle. Every
puff would be the same shape at a different size, and a column of them looks
like rising bubbles rather than smoke. The falloff is modulated by a few octaves
of tiled value noise, so each puff has a soft irregular edge, and because the
particle system rotates them over their lifetime the irregularity never repeats
in the same place twice.

RGB IS FLAT WHITE, on purpose. The colour comes from the ParticleSystem's
initialColor/colorOverTime (see CANDLE_SMOKE_* in config.ts), which lerps over
each particle's life. Baking grey into the texture would multiply with that and
make the smoke muddier than whatever was authored.
"""

import math
import os
import random
import struct
import zlib

SIZE = 128
OCTAVES = 3
BASE_GRID = 4        # cells per side in the coarsest noise octave
NOISE_MIX = 0.55     # 0 = perfect circle, 1 = noise dominates the edge
EDGE_POWER = 1.7     # higher = softer, more gradual falloff
PEAK_ALPHA = 232     # densest texel; deliberately under 255 — see the gain note
SEED = 7

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   'assets', 'scene', 'Textures', 'smoke_puff.png')


def tiled_value_noise(size, grid, rng):
    """Bilinear-interpolated value noise on a wrapping grid."""
    pts = [[rng.random() for _ in range(grid)] for _ in range(grid)]
    out = [[0.0] * size for _ in range(size)]
    for y in range(size):
        gy = y / size * grid
        y0 = int(gy) % grid
        y1 = (y0 + 1) % grid
        ty = gy - int(gy)
        ty = ty * ty * (3 - 2 * ty)  # smoothstep, so cells don't show as creases
        for x in range(size):
            gx = x / size * grid
            x0 = int(gx) % grid
            x1 = (x0 + 1) % grid
            tx = gx - int(gx)
            tx = tx * tx * (3 - 2 * tx)
            a = pts[y0][x0] + (pts[y0][x1] - pts[y0][x0]) * tx
            b = pts[y1][x0] + (pts[y1][x1] - pts[y1][x0]) * tx
            out[y][x] = a + (b - a) * ty
    return out


def build():
    rng = random.Random(SEED)
    field = [[0.0] * SIZE for _ in range(SIZE)]
    amp, total, grid = 1.0, 0.0, BASE_GRID
    for _ in range(OCTAVES):
        n = tiled_value_noise(SIZE, grid, rng)
        for y in range(SIZE):
            row = field[y]
            nr = n[y]
            for x in range(SIZE):
                row[x] += nr[x] * amp
        total += amp
        amp *= 0.5
        grid *= 2
    for y in range(SIZE):
        for x in range(SIZE):
            field[y][x] /= total

    # Normalise the noise to a known 0..1 span first. Value noise averages
    # around 0.5 but its actual min/max depend on the seed, and feeding the raw
    # field straight into the alpha made the whole puff dimmer than intended
    # (peak alpha came out at 152 of 255 — a puff with no core, which reads as
    # haze rather than smoke).
    flo = min(min(r) for r in field)
    fhi = max(max(r) for r in field)
    span = (fhi - flo) or 1.0

    alpha = [[0.0] * SIZE for _ in range(SIZE)]
    c = (SIZE - 1) / 2.0
    peak = 0.0
    for y in range(SIZE):
        for x in range(SIZE):
            d = math.hypot(x - c, y - c) / c  # 0 at centre, 1 at the inscribed edge
            radial = max(0.0, 1.0 - d) ** EDGE_POWER
            n = (field[y][x] - flo) / span
            a = radial * ((1.0 - NOISE_MIX) + NOISE_MIX * n)
            alpha[y][x] = a
            if a > peak:
                peak = a

    # Scale so the densest pixel lands at PEAK_ALPHA. Not 255: a fully opaque
    # texel makes the sprite's centre read as a hard disc when several puffs
    # overlap, which is the one thing this shape is trying not to look like.
    gain = (PEAK_ALPHA / 255.0) / (peak or 1.0)

    px = bytearray(SIZE * SIZE * 4)
    for y in range(SIZE):
        for x in range(SIZE):
            o = (y * SIZE + x) * 4
            px[o] = px[o + 1] = px[o + 2] = 255  # flat white; tinted at runtime
            px[o + 3] = max(0, min(255, int(round(alpha[y][x] * gain * 255))))
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
print('alpha: max %d  mean %.1f  nonzero %.0f%%' % (
    max(alphas), sum(alphas) / len(alphas), 100 * sum(1 for a in alphas if a > 4) / len(alphas)))
