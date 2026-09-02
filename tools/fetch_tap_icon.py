"""
THE TAP GLYPH — the explorer's own, not a redrawing of it.

    python tools/fetch_tap_icon.py

WHAT THIS REPLACES. Three hand-drawn attempts, each one a guess at a 40px button
in a screenshot. The last of them was described by the person it shipped to as
looking like a dick, which is a fair summary of what a lone vertical capsule on
a rounded blob looks like. The shape was never the problem to solve: the icon
already exists, it is the one the client draws on the button the player has to
press, and it is public.

WHERE IT COMES FROM.

    decentraland/unity-explorer @ dev
    Explorer/Assets/Textures/UI/Interaction/icon-interactive.png
    49x48 RGBA, white line art on transparent

That repository is Apache-2.0, so shipping the asset is permitted. It sits
alongside icon-mouse-left / -right / -wheel, which are its desktop counterparts
— the set the client picks from to say "this is the control you press", which is
exactly what this prompt is doing.

IT IS FETCHED THROUGH GIT LFS. The raw.githubusercontent URL returns a 130-byte
pointer file, not a PNG; the real blob has to be resolved through the LFS batch
API first. A previous run of this silently wrote the pointer text into the
texture, so the PNG magic is asserted before anything is saved.

RESIZED TO 128x128, from 49x48, over PREMULTIPLIED alpha. Bilinear on straight
alpha pulls the transparent pixels' colour into the edges and leaves a dark
fringe around white line art; premultiplying first is what stops that. The
upscale is for power-of-two safety rather than detail — nothing is gained past
the ~36px this renders at.
"""

import json
import math
import os
import struct
import sys
import urllib.request
import zlib

REPO = 'decentraland/unity-explorer'
REF = 'dev'
ASSET = 'Explorer/Assets/Textures/UI/Interaction/icon-interactive.png'
OUT = os.path.join('assets', 'scene', 'Textures', 'tap_icon.png')
SIZE = 128
PNG_MAGIC = bytes([137, 80, 78, 71, 13, 10, 26, 10])


def get(url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.read()


def fetch_asset():
    """Raw file, then the LFS blob it points at if that is what came back."""
    raw = get(f'https://raw.githubusercontent.com/{REPO}/{REF}/{ASSET}')
    if raw[:8] == PNG_MAGIC:
        return raw
    text = raw.decode('utf-8', 'replace')
    if 'git-lfs' not in text:
        raise SystemExit(f'unrecognised response for {ASSET}:\n{text[:200]}')
    oid = size = None
    for line in text.splitlines():
        if line.startswith('oid sha256:'):
            oid = line.split(':', 1)[1].strip()
        elif line.startswith('size '):
            size = int(line.split()[1])
    if not oid or size is None:
        raise SystemExit('could not parse the LFS pointer')
    body = json.dumps({'operation': 'download', 'transfers': ['basic'],
                       'objects': [{'oid': oid, 'size': size}]}).encode()
    batch = json.loads(get(f'https://github.com/{REPO}.git/info/lfs/objects/batch', body,
                           {'Accept': 'application/vnd.git-lfs+json',
                            'Content-Type': 'application/vnd.git-lfs+json'}))
    obj = batch['objects'][0]
    if 'actions' not in obj:
        raise SystemExit(f'LFS refused the object: {obj.get("error")}')
    blob = get(obj['actions']['download']['href'])
    if blob[:8] != PNG_MAGIC:
        raise SystemExit('LFS returned something that is not a PNG')
    return blob


def decode(d):
    """Minimal PNG reader — 8-bit RGBA or RGB only, which is all this asset is."""
    pos, idat, w, h, ct = 8, b'', 0, 0, 6
    while pos < len(d):
        ln = struct.unpack('>I', d[pos:pos + 4])[0]
        tag, data = d[pos + 4:pos + 8], d[pos + 8:pos + 8 + ln]
        if tag == b'IHDR':
            w, h, bd, ct = struct.unpack('>IIBB', data[:10])
            if bd != 8 or ct not in (2, 6):
                raise SystemExit(f'unsupported PNG: depth {bd} colortype {ct}')
        elif tag == b'IDAT':
            idat += data
        pos += 12 + ln
    bpp = 4 if ct == 6 else 3
    raw, stride, out, prev, i = zlib.decompress(idat), w * bpp, bytearray(), bytearray(w * bpp), 0
    for _ in range(h):
        f = raw[i]; i += 1
        line = bytearray(raw[i:i + stride]); i += stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if (pa <= pb and pa <= pc) else (b if pb <= pc else c))) & 255
        out += line
        prev = line
    if bpp == 3:  # pad to RGBA, fully opaque
        rgba = bytearray()
        for p in range(w * h):
            rgba += out[p * 3:p * 3 + 3] + b'\xff'
        out = rgba
    return w, h, out


def resize(sw, sh, src, size):
    """Bilinear over premultiplied alpha — see the note about dark fringing."""
    pm = bytearray(len(src))
    for p in range(sw * sh):
        a = src[p * 4 + 3] / 255.0
        for c in range(3):
            pm[p * 4 + c] = int(round(src[p * 4 + c] * a))
        pm[p * 4 + 3] = src[p * 4 + 3]
    rows = []
    for y in range(size):
        row = bytearray()
        fy = min(sh - 1.0, max(0.0, (y + 0.5) * sh / size - 0.5))
        y0 = int(math.floor(fy)); y1 = min(sh - 1, y0 + 1); wy = fy - y0
        for x in range(size):
            fx = min(sw - 1.0, max(0.0, (x + 0.5) * sw / size - 0.5))
            x0 = int(math.floor(fx)); x1 = min(sw - 1, x0 + 1); wx = fx - x0
            px = []
            for c in range(4):
                v = (pm[(y0 * sw + x0) * 4 + c] * (1 - wx) * (1 - wy)
                     + pm[(y0 * sw + x1) * 4 + c] * wx * (1 - wy)
                     + pm[(y1 * sw + x0) * 4 + c] * (1 - wx) * wy
                     + pm[(y1 * sw + x1) * 4 + c] * wx * wy)
                px.append(v)
            a = px[3]
            if a > 0.5:  # back to straight alpha
                row.extend(min(255, int(round(px[c] * 255.0 / a))) for c in range(3))
            else:
                row.extend((0, 0, 0))
            row.append(int(round(a)))
        rows.append(row)
    return rows


def write_png(path, w, h, rows):
    raw = bytearray()
    for r in rows:
        raw.append(0)
        raw.extend(r)

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (PNG_MAGIC + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b''))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as fh:
        fh.write(png)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else OUT
    w, h, px = decode(fetch_asset())
    rows = resize(w, h, px, SIZE)
    write_png(out, SIZE, SIZE, rows)
    inked = sum(1 for r in rows for i in range(SIZE) if r[i * 4 + 3] > 8)
    print(f'wrote {out}  {w}x{h} -> {SIZE}x{SIZE}  {100.0*inked/(SIZE*SIZE):.1f}% inked')
    if inked == 0:
        raise SystemExit('every pixel is transparent — the fetch or the resize is wrong')


if __name__ == '__main__':
    main()
