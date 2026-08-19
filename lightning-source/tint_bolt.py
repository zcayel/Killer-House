"""
Re-tints the baked lightning flipbook so the bolt's CORE reads blue instead of
white, then writes the atlas the scene actually ships.

    python title-source/tint_bolt.py

WHY THIS EXISTS AS A SEPARATE STEP. The bolt was baked white-hot in the middle
with a cold fringe, which is what real lightning looks like photographed — but
in the scene the whole stroke reads as a flat white line. Two things do that,
and the tint only fixes one of them:

  1. THE TEXTURE. Averaged over the visible pixels, the core sat at
     (233, 240, 249) — that is white with a 6% blue lean, not a blue core.
  2. THE EMISSIVE. LIGHTNING_BOLT_EMISSIVE multiplies the texture before
     tonemapping. Any channel that lands above 1.0 is clipped, and at a high
     enough multiplier ALL THREE channels clip no matter what colour went in,
     so the bolt renders white however blue the texture is. That is a knob in
     config.ts, not something this script can reach.

So the fix is split: this pushes R and G down where the stroke is brightest, and
LIGHTNING_BOLT_EMISSIVE comes down far enough for the ratio to survive.

THE TINT IS PROPORTIONAL TO BRIGHTNESS, using R as the measure of "how white is
this pixel" — it is the channel that separates the white core from the blue
fringe. A flat multiply would drag the already-dim fringe down with it and the
bolt would just get darker; this leaves the fringe alone and re-colours the core.

Reads the UNTINTED bake and writes the shipped atlas, so it is re-runnable and
the knobs below can be re-tuned without another Blender bake. Never edit the
shipped PNG in place — running this twice on its own output would tint the tint.
"""

import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(HERE, 'lightning_flipbook_white.png')
DST = os.path.join(ROOT, 'assets', 'scene', 'Textures', 'lightning_flipbook.png')

# How hard to pull each channel where the stroke is brightest. R falls furthest,
# G less (it carries most of the perceived brightness — drop it as hard as R and
# the bolt goes navy and stops reading as hot), B is nudged up to full.
K_R = 0.42
K_G = 0.20
K_B = 0.02


# ── Minimal PNG codec (no PIL in this environment) ─────────────────────────

def decode(path):
    d = open(path, 'rb').read()
    assert d[:8] == b'\x89PNG\r\n\x1a\n', 'not a png'
    off, idat = 8, b''
    w = h = bd = ct = None
    while off < len(d):
        ln, typ = struct.unpack_from('>I4s', d, off)
        body = d[off + 8: off + 8 + ln]
        if typ == b'IHDR':
            w, h, bd, ct = struct.unpack('>IIBB', body[:10])
        elif typ == b'IDAT':
            idat += body
        elif typ == b'IEND':
            break
        off += 12 + ln
    assert bd == 8 and ct == 6, f'expected 8-bit RGBA, got depth {bd} type {ct}'
    raw = zlib.decompress(idat)
    stride = w * 4
    out = bytearray(h * stride)
    prev = bytearray(stride)
    pos = 0
    for y in range(h):
        f = raw[pos]; pos += 1
        line = bytearray(raw[pos:pos + stride]); pos += stride
        if f == 1:
            for i in range(4, stride):
                line[i] = (line[i] + line[i - 4]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - 4] if i >= 4 else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - 4] if i >= 4 else 0
                b = prev[i]
                c = prev[i - 4] if i >= 4 else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, out


def encode(path, w, h, px):
    stride = w * 4
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += px[y * stride:(y + 1) * stride]

    def chunk(tag, body):
        return struct.pack('>I', len(body)) + tag + body + struct.pack('>I', zlib.crc32(tag + body) & 0xFFFFFFFF)

    out = b'\x89PNG\r\n\x1a\n'
    out += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    out += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    out += chunk(b'IEND', b'')
    open(path, 'wb').write(out)
    return len(out)


def main():
    if not os.path.isfile(SRC):
        sys.exit(f'missing untinted source: {SRC}\n'
                 f'(it is the raw Blender bake — restore it before re-running)')

    w, h, px = decode(SRC)
    before, after, n = [0, 0, 0], [0, 0, 0], 0

    for i in range(w * h):
        o = i * 4
        if px[o + 3] <= 8:  # fully transparent: nothing to colour
            continue
        r, g, b = px[o], px[o + 1], px[o + 2]
        core = r / 255.0  # how white this pixel is; the fringe is already blue

        nr = int(round(r * (1.0 - K_R * core)))
        ng = int(round(g * (1.0 - K_G * core)))
        nb = min(255, int(round(b * (1.0 + K_B * core))))

        if r >= 224:  # report on the core only — that is what was white
            for k, v in enumerate((r, g, b)):
                before[k] += v
            for k, v in enumerate((nr, ng, nb)):
                after[k] += v
            n += 1

        px[o], px[o + 1], px[o + 2] = nr, ng, nb

    size = encode(DST, w, h, px)
    if n:
        print('core (R>=224), averaged over %d px:' % n)
        print('  before  rgb(%d, %d, %d)' % tuple(v // n for v in before))
        print('  after   rgb(%d, %d, %d)' % tuple(v // n for v in after))
    print('wrote %s  (%dx%d, %.0f KB)' % (DST, w, h, size / 1024))


main()
