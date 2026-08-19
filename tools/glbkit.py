"""FINAL bake of the swing hit-capsules. Nothing here is hand-chosen.

Three failures the earlier bakes had, all fixed by measuring instead of picking:

1. AXIS SIGN. Power iteration returns the principal axis up to sign, so the
   slice chain came out handle-first in some keyframes and head-first in others.
   Runtime lerps capsule i against capsule i, so a flip lerps the axe's HEAD
   into its HANDLE - a multi-metre phantom capsule mid-swing. Fixed by anchoring
   +axis away from the model's PIVOT (the vertices that barely move all clip).

2. SLICE COUNT. Slicing a low-poly board finer than its vertices produces EMPTY
   middle slices, which collapse to r=0.02 and stop covering the thing they are
   meant to represent - it looks like a tighter fit in m3 while actually being a
   hole. Chosen here as the largest count where every slice still contains
   geometry AND keyframe coverage stays >= 99.5%.

3. KEYFRAME SPACING. Endpoints are lerped, so a fast rotation is approximated by
   the CHORD of its arc: the plank's 0.3s drop left the capsule up to 0.9m off
   the real board. Keyframes are inserted greedily wherever the interpolated
   shape is furthest from the real mesh, until the worst gap is under TOL.

Emits config-ready keyframes plus the numbers that justify them.
"""
import json
import math
import os
import struct

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOL = 0.08          # metres the interpolated capsule may miss the real mesh by
MAX_KEYFRAMES = 26  # config-size ceiling; report if we hit it

COMP = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
FMT = {5120: 'b', 5121: 'B', 5122: 'h', 5123: 'H', 5125: 'I', 5126: 'f'}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def load(p):
    d = open(p, 'rb').read()
    off, js, bn = 12, None, b''
    while off < len(d):
        ln, ty = struct.unpack_from('<I4s', d, off)
        b = d[off + 8:off + 8 + ln]
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
    return [struct.unpack_from('<' + FMT[ct] * n, bn, base + k * st) for k in range(a['count'])]


def trs(t, q, s):
    x, y, z, w = q
    R = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
         [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
         [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
    return [[R[i][j] * s[j] for j in range(3)] + [t[i]] for i in range(3)] + [[0, 0, 0, 1]]


def ntrs(n, o=None):
    o = o or {}
    if 'matrix' in n and not o:
        m = n['matrix']
        return [[m[0], m[4], m[8], m[12]], [m[1], m[5], m[9], m[13]],
                [m[2], m[6], m[10], m[14]], [m[3], m[7], m[11], m[15]]]
    return trs(o.get('translation', n.get('translation', [0, 0, 0])),
               o.get('rotation', n.get('rotation', [0, 0, 0, 1])),
               o.get('scale', n.get('scale', [1, 1, 1])))


def mul(A, B):
    return [[sum(A[i][k] * B[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def xf(M, p):
    return tuple(sum(M[k][j] * p[j] for j in range(3)) + M[k][3] for k in range(3))


def lerp(a, b, t):
    return [a[i] + (b[i] - a[i]) * t for i in range(len(a))]


def slerp(a, b, t):
    d = sum(a[i] * b[i] for i in range(4))
    if d < 0:
        b = [-v for v in b]
        d = -d
    if d > 0.9995:
        v = lerp(a, b, t)
    else:
        th = math.acos(max(-1, min(1, d)))
        s = math.sin(th)
        v = [(math.sin((1 - t) * th) / s) * a[i] + (math.sin(t * th) / s) * b[i] for i in range(4)]
    n = math.sqrt(sum(c * c for c in v)) or 1.0
    return [c / n for c in v]


def make_sampler(path, clip):
    g, bn = load(path)
    nodes = g['nodes']
    anim = next(a for a in g['animations'] if a.get('name') == clip)
    chans, samplers = anim['channels'], anim['samplers']
    cache = {c['sampler']: ([v[0] for v in acc(g, bn, samplers[c['sampler']]['input'])],
                            acc(g, bn, samplers[c['sampler']]['output'])) for c in chans}
    I = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
    mc = {}

    def prim_pts(mi):
        if mi not in mc:
            out = []
            for pr in g['meshes'][mi]['primitives']:
                if 'POSITION' in pr.get('attributes', {}):
                    out.extend(acc(g, bn, pr['attributes']['POSITION']))
            mc[mi] = out
        return mc[mi]

    memo = {}

    def verts(t):
        key = round(t, 5)
        if key in memo:
            return memo[key]
        o = {}
        for c in chans:
            tg = c['target'].get('node')
            pth = c['target']['path']
            ts, vs = cache[c['sampler']]
            tt = min(max(t, ts[0]), ts[-1])
            k = 0
            while k < len(ts) - 2 and ts[k + 1] < tt:
                k += 1
            u = (tt - ts[k]) / ((ts[k + 1] - ts[k]) or 1.0)
            a, b = list(vs[k]), list(vs[min(k + 1, len(vs) - 1)])
            o.setdefault(tg, {})[pth] = slerp(a, b, u) if pth == 'rotation' else lerp(a, b, u)
        pts = []

        def walk(i, Pm):
            n = nodes[i]
            M = mul(Pm, ntrs(n, o.get(i)))
            if 'mesh' in n:
                nm = (n.get('name', '') + ' ' + g['meshes'][n['mesh']].get('name', '')).lower()
                if 'collider' not in nm:
                    for p in prim_pts(n['mesh']):
                        pts.append(xf(M, p))
            for c in n.get('children', []):
                walk(c, M)

        for sc in g.get('scenes', []):
            for r in sc.get('nodes', []):
                walk(r, I)
        memo[key] = pts
        return pts

    return verts


def find_pivot(sample, dur):
    frames = [sample(dur * k / 8) for k in range(9)]
    n = len(frames[0])
    travel = sorted((max(abs(f[i][j] - frames[0][i][j]) for f in frames for j in range(3)), i)
                    for i in range(n))
    keep = [i for _, i in travel[:max(1, n // 20)]]
    return [sum(frames[0][i][j] for i in keep) / len(keep) for j in range(3)]


def fit(pts, nslice, pivot):
    c = [sum(p[k] for p in pts) / len(pts) for k in range(3)]
    v = [1.0, 0.3, 0.2]
    for _ in range(80):
        a3 = [0.0, 0.0, 0.0]
        for p in pts:
            d = [p[k] - c[k] for k in range(3)]
            dot = sum(d[k] * v[k] for k in range(3))
            for k in range(3):
                a3[k] += d[k] * dot
        n = math.sqrt(sum(x * x for x in a3)) or 1.0
        v = [x / n for x in a3]
    if sum((c[k] - pivot[k]) * v[k] for k in range(3)) < 0:
        v = [-x for x in v]
    proj = [sum((p[k] - c[k]) * v[k] for k in range(3)) for p in pts]
    lo, hi = min(proj), max(proj)
    segs = []
    empty = 0
    for i in range(nslice):
        a = lo + (hi - lo) * i / nslice
        b = lo + (hi - lo) * (i + 1) / nslice
        rr = -1.0
        for p, pr in zip(pts, proj):
            if (a - 1e-9) <= pr <= (b + 1e-9):
                d = [p[k] - c[k] for k in range(3)]
                dot = sum(d[k] * v[k] for k in range(3))
                rr = max(rr, math.sqrt(max(0.0, sum(x * x for x in d) - dot * dot)))
        if rr < 0:
            empty += 1
            rr = 0.0
        segs.append((tuple(c[k] + v[k] * a for k in range(3)),
                     tuple(c[k] + v[k] * b for k in range(3)), rr))
    return segs, empty


def caps_at(kfs, t):
    """Byte-for-byte what swingTraps.ts capsAt() computes."""
    if t <= kfs[0][0]:
        return kfs[0][1]
    if t >= kfs[-1][0]:
        return kfs[-1][1]
    i = 0
    while i < len(kfs) - 2 and kfs[i + 1][0] < t:
        i += 1
    ta, ca = kfs[i]
    tb, cb = kfs[i + 1]
    u = (t - ta) / ((tb - ta) or 1.0)
    return [(tuple(ca[k][0][j] + (cb[k][0][j] - ca[k][0][j]) * u for j in range(3)),
             tuple(ca[k][1][j] + (cb[k][1][j] - ca[k][1][j]) * u for j in range(3)),
             ca[k][2] + (cb[k][2] - ca[k][2]) * u) for k in range(len(ca))]


def pt_seg(p, a, b):
    ab = [b[k] - a[k] for k in range(3)]
    L = sum(x * x for x in ab)
    t = 0.0 if L == 0 else max(0.0, min(1.0, sum((p[k] - a[k]) * ab[k] for k in range(3)) / L))
    return math.sqrt(sum((p[k] - (a[k] + ab[k] * t)) ** 2 for k in range(3)))


def worst_gap(kfs, sample, t, stride):
    caps = caps_at(kfs, t)
    w = 0.0
    for p in sample(t)[::stride]:
        d = min(pt_seg(p, c[0], c[1]) - c[2] for c in caps)
        if d > w:
            w = d
    return w



# library only - no top-level work

SURF_TARGET = 900


def make_surface_sampler(path, clip):
    """Like glbkit.make_sampler but returns points spread over the TRIANGLE"""
    g, bn = load(path)
    nodes = g['nodes']
    anim = next(a for a in g['animations'] if a.get('name') == clip)
    chans, samplers = anim['channels'], anim['samplers']
    cache = {c['sampler']: ([v[0] for v in acc(g, bn, samplers[c['sampler']]['input'])],
                            acc(g, bn, samplers[c['sampler']]['output'])) for c in chans}
    I = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]

    tris = {}

    def mesh_tris(mi):
        if mi in tris:
            return tris[mi]
        out = []
        for pr in g['meshes'][mi]['primitives']:
            if 'POSITION' not in pr.get('attributes', {}):
                continue
            pos = acc(g, bn, pr['attributes']['POSITION'])
            if 'indices' in pr:
                idx = [i[0] for i in acc(g, bn, pr['indices'])]
            else:
                idx = list(range(len(pos)))
            for k in range(0, len(idx) - 2, 3):
                out.append((pos[idx[k]], pos[idx[k + 1]], pos[idx[k + 2]]))
        tris[mi] = out
        return out

    # Barycentric patterns keyed by subdivision level. A FIXED count per
    # triangle is worthless here: the plank is 16 triangles, so 15 points each
    # puts samples ~2m apart on an 8m board and every distance measured against
    # them reads up to a metre too far. Subdivide by AREA instead.
    SPACING = 0.08  # metres between surface samples
    BARY = {}

    def bary(n):
        if n not in BARY:
            pts = []
            for i in range(n + 1):
                for j in range(n + 1 - i):
                    k = n - i - j
                    pts.append((i / n, j / n, k / n))
            BARY[n] = pts
        return BARY[n]

    memo = {}

    def verts(t):
        key = round(t, 5)
        if key in memo:
            return memo[key]
        o = {}
        for c in chans:
            tg = c['target'].get('node')
            pth = c['target']['path']
            ts, vs = cache[c['sampler']]
            tt = min(max(t, ts[0]), ts[-1])
            k = 0
            while k < len(ts) - 2 and ts[k + 1] < tt:
                k += 1
            u = (tt - ts[k]) / ((ts[k + 1] - ts[k]) or 1.0)
            a, b = list(vs[k]), list(vs[min(k + 1, len(vs) - 1)])
            o.setdefault(tg, {})[pth] = slerp(a, b, u) if pth == 'rotation' else lerp(a, b, u)
        pts = []

        def walk(i, Pm):
            n = nodes[i]
            M = mul(Pm, ntrs(n, o.get(i)))
            if 'mesh' in n:
                nm = (n.get('name', '') + ' ' + g['meshes'][n['mesh']].get('name', '')).lower()
                if 'collider' not in nm:
                    for (p0, p1, p2) in mesh_tris(n['mesh']):
                        q0, q1, q2 = xf(M, p0), xf(M, p1), xf(M, p2)
                        e1 = [q1[k] - q0[k] for k in range(3)]
                        e2 = [q2[k] - q0[k] for k in range(3)]
                        cr = (e1[1] * e2[2] - e1[2] * e2[1],
                              e1[2] * e2[0] - e1[0] * e2[2],
                              e1[0] * e2[1] - e1[1] * e2[0])
                        area = 0.5 * math.sqrt(sum(c * c for c in cr))
                        side = math.sqrt(max(area, 1e-9) * 2)
                        lvl = max(1, min(64, int(side / SPACING) + 1))
                        for (u1, v1, w1) in bary(lvl):
                            pts.append(tuple(q0[k] * u1 + q1[k] * v1 + q2[k] * w1 for k in range(3)))
            for c in n.get('children', []):
                walk(c, M)

        for sc in g.get('scenes', []):
            for r in sc.get('nodes', []):
                walk(r, I)
        # thin out deterministically to keep the fit fast. Callers that MEASURE
        # distances raise SURF_TARGET so this is a no-op for them.
        step = max(1, len(pts) // SURF_TARGET)
        pts = pts[::step]
        memo[key] = pts
        return pts

    return verts


