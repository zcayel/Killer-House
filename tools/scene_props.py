"""Measures how much clear space every candle station actually has.

THE RULE: a candle needs room on every side and above it, but NOT below — the
floor it stands on is expected contact, not a collision. So triangles that lie
entirely below the candle's base are skipped and everything else counts.

The candle is treated as the capsule it actually is: HWN20_Candle_03 at
RITUAL_CANDLE_SCALE is 0.45 x 0.72 x 0.39, i.e. a body of radius ~0.23 standing
0.72 tall. Clearance is (nearest triangle) - radius, so a negative number means
the wax is inside something.

Every CANDLE_POOL entry is tested at every CANDLE_OFFSET_BUCKETS offset, because
the offset is what decides where a given player's copy actually stands — a spot
that is fine at (0,0) and buried at (-0.2, 0) is still a broken spot.
"""
import json
import math
import os
import re
import struct
import sys

import os as _o
ROOT = _o.path.dirname(_o.path.dirname(_o.path.abspath(__file__)))
CANDLE_RADIUS = 0.23
CANDLE_HEIGHT = 0.72
BASE_EPS = 0.03        # triangles below base+this are "the floor", and ignored
SAMPLES = 8
NEAR = 5.0             # only consider props whose bounds come within this of a candle

COMP = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
FMT = {5120: 'b', 5121: 'B', 5122: 'h', 5123: 'H', 5125: 'I', 5126: 'f'}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def load(path):
    d = open(path, 'rb').read()
    off, js, bn = 12, None, b''
    while off < len(d):
        ln, ty = struct.unpack_from('<I4s', d, off)
        b = d[off + 8: off + 8 + ln]
        if ty == b'JSON':
            js = json.loads(b.decode('utf-8'))
        elif ty[:3] == b'BIN':
            bn = b
        off += 8 + ln + ((4 - ln % 4) % 4 if ln % 4 else 0)
    return js, bn


def acc(g, bn, i):
    a = g['accessors'][i]
    bv = g['bufferViews'][a['bufferView']]
    base = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    n = NC[a['type']]
    ct = a['componentType']
    st = bv.get('byteStride') or (COMP[ct] * n)
    f = '<' + FMT[ct] * n
    return [struct.unpack_from(f, bn, base + k * st) for k in range(a['count'])]


def local_mat(n):
    if 'matrix' in n:
        m = n['matrix']
        return [[m[0], m[4], m[8], m[12]], [m[1], m[5], m[9], m[13]],
                [m[2], m[6], m[10], m[14]], [m[3], m[7], m[11], m[15]]]
    t = n.get('translation', [0, 0, 0])
    x, y, z, w = n.get('rotation', [0, 0, 0, 1])
    s = n.get('scale', [1, 1, 1])
    return trs(t, (x, y, z, w), s)


def trs(t, q, s):
    x, y, z, w = q
    R = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
         [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
         [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
    return [[R[i][j] * s[j] for j in range(3)] + [t[i]] for i in range(3)] + [[0, 0, 0, 1]]


def mul(A, B):
    return [[sum(A[i][k] * B[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def xform(M, p):
    return (sum(M[0][j] * p[j] for j in range(3)) + M[0][3],
            sum(M[1][j] * p[j] for j in range(3)) + M[1][3],
            sum(M[2][j] * p[j] for j in range(3)) + M[2][3])


_cache = {}


def glb_tris(path):
    """Triangles in the GLB's own space — collider meshes if present, else visible."""
    if path in _cache:
        return _cache[path]
    g, bn = load(path)
    nodes = g.get('nodes', [])
    col, vis = [], []

    def walk(i, P):
        n = nodes[i]
        M = mul(P, local_mat(n))
        if 'mesh' in n:
            me = g['meshes'][n['mesh']]
            target = col if 'collider' in (me.get('name', '') + ' ' + n.get('name', '')).lower() else vis
            for prim in me['primitives']:
                if 'POSITION' not in prim.get('attributes', {}):
                    continue
                pos = [xform(M, p) for p in acc(g, bn, prim['attributes']['POSITION'])]
                idx = [v[0] for v in acc(g, bn, prim['indices'])] if 'indices' in prim else list(range(len(pos)))
                for t in range(0, len(idx) - 2, 3):
                    target.append((pos[idx[t]], pos[idx[t + 1]], pos[idx[t + 2]]))
        for c in n.get('children', []):
            walk(c, M)

    I = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
    for sc in g.get('scenes', []):
        for r in sc.get('nodes', []):
            walk(r, I)
    out = col if col else vis
    _cache[path] = out
    return out


def pt_tri(p, a, b, c):
    """Ericson, Real-Time Collision Detection: closest point on a triangle."""
    ab = [b[i] - a[i] for i in range(3)]
    ac = [c[i] - a[i] for i in range(3)]
    ap = [p[i] - a[i] for i in range(3)]
    d1 = sum(ab[i] * ap[i] for i in range(3))
    d2 = sum(ac[i] * ap[i] for i in range(3))
    if d1 <= 0 and d2 <= 0:
        q = a
    else:
        bp = [p[i] - b[i] for i in range(3)]
        d3 = sum(ab[i] * bp[i] for i in range(3))
        d4 = sum(ac[i] * bp[i] for i in range(3))
        if d3 >= 0 and d4 <= d3:
            q = b
        else:
            vc = d1 * d4 - d3 * d2
            if vc <= 0 and d1 >= 0 and d3 <= 0:
                v = d1 / (d1 - d3) if d1 != d3 else 0
                q = [a[i] + v * ab[i] for i in range(3)]
            else:
                cp = [p[i] - c[i] for i in range(3)]
                d5 = sum(ab[i] * cp[i] for i in range(3))
                d6 = sum(ac[i] * cp[i] for i in range(3))
                if d6 >= 0 and d5 <= d6:
                    q = c
                else:
                    vb = d5 * d2 - d1 * d6
                    if vb <= 0 and d2 >= 0 and d6 <= 0:
                        w = d2 / (d2 - d6) if d2 != d6 else 0
                        q = [a[i] + w * ac[i] for i in range(3)]
                    else:
                        va = d3 * d6 - d5 * d4
                        if va <= 0 and (d4 - d3) >= 0 and (d5 - d6) >= 0:
                            w = (d4 - d3) / ((d4 - d3) + (d5 - d6))
                            q = [b[i] + w * (c[i] - b[i]) for i in range(3)]
                        else:
                            den = va + vb + vc
                            v = vb / den
                            w = vc / den
                            q = [a[i] + ab[i] * v + ac[i] * w for i in range(3)]
    return math.dist(p, q)


# ── scene ─────────────────────────────────────────────────────────────────
comp = json.load(open(os.path.join(ROOT, 'assets', 'scene', 'main.composite'), encoding='utf-8'))
C = {c['name']: c['data'] for c in comp['components']}
G = C['core::GltfContainer']
T = C['core::Transform']
N = C.get('core-schema::Name', {})

world = []   # (name, [tris in world space], bounds)
for e, v in G.items():
    src = (v.get('json', {}) or {}).get('src', '')
    if not src:
        continue
    path = os.path.join(ROOT, src.replace('/', os.sep))
    if not os.path.isfile(path):
        continue
    j = (T.get(e, {}).get('json', {}) or {})
    p = j.get('position', {}) or {}
    q = j.get('rotation', {'x': 0, 'y': 0, 'z': 0, 'w': 1}) or {}
    s = j.get('scale', {'x': 1, 'y': 1, 'z': 1}) or {}
    M = trs((p.get('x', 0), p.get('y', 0), p.get('z', 0)),
            (q.get('x', 0), q.get('y', 0), q.get('z', 0), q.get('w', 1)),
            (s.get('x', 1), s.get('y', 1), s.get('z', 1)))
    tris = [tuple(xform(M, v0) for v0 in tri) for tri in glb_tris(path)]
    if not tris:
        continue
    xs = [v0[0] for tri in tris for v0 in tri]
    ys = [v0[1] for tri in tris for v0 in tri]
    zs = [v0[2] for tri in tris for v0 in tri]
    world.append(((N.get(e, {}).get('json', {}) or {}).get('value', src.split('/')[-1]),
                  tris, (min(xs), max(xs), min(ys), max(ys), min(zs), max(zs))))

print(f'{len(world)} placed models, {sum(len(w[1]) for w in world)} collider triangles\n')

# ── candles ───────────────────────────────────────────────────────────────
cfg = open(os.path.join(ROOT, 'src', 'config.ts'), encoding='utf-8').read()
pool_src = cfg[cfg.index('export const CANDLE_POOL'):]
pool_src = pool_src[:pool_src.index('\n]')]
pool = [(float(a), float(b), float(c)) for a, b, c in
        re.findall(r'pos: Vector3\.create\((-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\)', pool_src)]
off_src = cfg[cfg.index('export const CANDLE_OFFSET_BUCKETS'):]
off_src = off_src[:off_src.index('\n]')]
offs = [(float(a), float(b), float(c)) for a, b, c in
        re.findall(r'Vector3\.create\((-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\)', off_src)]
print(f'{len(pool)} candle spots x {len(offs)} owner offsets\n')


def clearance(x, y, z):
    """Min distance from the candle body to anything that is not the floor."""
    best = 99.0
    worst_name = None
    for name, tris, b in world:
        if (b[0] - NEAR > x or b[1] + NEAR < x or b[4] - NEAR > z or b[5] + NEAR < z
                or b[2] - NEAR > y + CANDLE_HEIGHT or b[3] + NEAR < y):
            continue
        for tri in tris:
            if max(v[1] for v in tri) < y + BASE_EPS:
                continue                      # entirely below the base: this is floor
            for k in range(SAMPLES):
                py = y + 0.04 + (CANDLE_HEIGHT - 0.08) * k / (SAMPLES - 1)
                d = pt_tri((x, py, z), *tri)
                if d < best:
                    best = d
                    worst_name = name
            if best < -CANDLE_RADIUS:
                break
    return best - CANDLE_RADIUS, worst_name


rows = []
for i, (px, py, pz) in enumerate(pool):
    worst = (99.0, None, None)
    for (ox, oy, oz) in offs:
        c, nm = clearance(px + ox, py + oy, pz + oz)
        if c < worst[0]:
            worst = (c, nm, (ox, oz))
    rows.append((i, (px, py, pz), worst))

MIN = float(sys.argv[1]) if len(sys.argv) > 1 else 0.35
print(f'clearance rule: >= {MIN}m from anything that is not the floor\n')
bad = 0
for i, pos, (c, nm, off) in rows:
    tag = ''
    if c < 0:
        tag = '   *** INSIDE GEOMETRY ***'
        bad += 1
    elif c < MIN:
        tag = f'   *** TOO TIGHT (< {MIN}m) ***'
        bad += 1
    print(f'  [{i:2d}] ({pos[0]:6.2f}, {pos[1]:5.2f}, {pos[2]:6.2f})  worst clearance {c:6.2f}m'
          + (f'  vs {nm}' if nm else '') + f'  at offset {off}{tag}')
print(f'\n{bad} of {len(rows)} spots violate the rule')
