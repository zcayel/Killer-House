"""Is there a real floor at this world point? Ray-cast the actual house mesh.

HOUSE_RECT and HOUSE_WING_RECTS in config.ts are hand-measured rectangles, and
the comment on HOUSE_RECT says outright that an earlier version of it was wrong
in every direction. A rectangle is a guess about the model; this asks the model.

Casts a ray straight down from above the query point and reports the first
KILLERHOUSE_.glb triangle it hits (if any), with its Y.

    python tools/probe_floor.py --x 12 --z 20.86 --from-y 15
    python tools/probe_floor.py --grid 10 14 8 23 --near-y 7.65   # scan a region
"""
import argparse
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import glbkit as G  # noqa: E402

HOUSE = os.path.join('assets', 'Models', 'KILLERHOUSE_', 'KILLERHOUSE_.glb')


def load_triangles(path):
    g, bn = G.load(path)
    I = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
    tris = []

    def walk(i, P):
        n = g['nodes'][i]
        M = G.mul(P, G.ntrs(n))
        if 'mesh' in n:
            for pr in g['meshes'][n['mesh']]['primitives']:
                if 'POSITION' not in pr.get('attributes', {}):
                    continue
                pos = G.acc(g, bn, pr['attributes']['POSITION'])
                idx = ([k[0] for k in G.acc(g, bn, pr['indices'])] if 'indices' in pr
                       else list(range(len(pos))))
                for k in range(0, len(idx) - 2, 3):
                    tris.append((G.xf(M, pos[idx[k]]), G.xf(M, pos[idx[k + 1]]),
                                 G.xf(M, pos[idx[k + 2]])))
        for c in n.get('children', []):
            walk(c, M)

    for sc in g.get('scenes', []):
        for r in sc.get('nodes', []):
            walk(r, I)
    return tris


def ray_tri(orig, dirn, v0, v1, v2, eps=1e-7):
    """Moller-Trumbore. Returns t (distance along dirn) or None."""
    e1 = tuple(v1[i] - v0[i] for i in range(3))
    e2 = tuple(v2[i] - v0[i] for i in range(3))
    p = (dirn[1] * e2[2] - dirn[2] * e2[1],
         dirn[2] * e2[0] - dirn[0] * e2[2],
         dirn[0] * e2[1] - dirn[1] * e2[0])
    det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2]
    if -eps < det < eps:
        return None
    inv = 1.0 / det
    t0 = tuple(orig[i] - v0[i] for i in range(3))
    u = (t0[0] * p[0] + t0[1] * p[1] + t0[2] * p[2]) * inv
    if u < -eps or u > 1 + eps:
        return None
    q = (t0[1] * e1[2] - t0[2] * e1[1],
         t0[2] * e1[0] - t0[0] * e1[2],
         t0[0] * e1[1] - t0[1] * e1[0])
    v = (dirn[0] * q[0] + dirn[1] * q[1] + dirn[2] * q[2]) * inv
    if v < -eps or u + v > 1 + eps:
        return None
    t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv
    return t if t > eps else None


def cast_down(tris, x, z, from_y):
    best = None
    for v0, v1, v2 in tris:
        t = ray_tri((x, from_y, z), (0.0, -1.0, 0.0), v0, v1, v2)
        if t is not None and (best is None or t < best):
            best = t
    return from_y - best if best is not None else None


def house_offset():
    import json
    d = json.load(open(os.path.join(G.ROOT, 'assets', 'scene', 'main.composite'), encoding='utf-8'))
    for c in d.get('components', []):
        if c.get('name') == 'core-schema::Name':
            for k, v in (c.get('data') or {}).items():
                if (v.get('json') or {}).get('value') == 'KILLERHOUSE_.glb':
                    eid = k
        if c.get('name') == 'core::Transform':
            tf = c.get('data') or {}
    p = (tf.get(eid) or {}).get('json', {}).get('position', {})
    return (p.get('x', 0.0), p.get('y', 0.0), p.get('z', 0.0))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--x', type=float)
    ap.add_argument('--z', type=float)
    ap.add_argument('--from-y', type=float, default=15.0)
    ap.add_argument('--grid', nargs=4, type=float, metavar=('X0', 'X1', 'Z0', 'Z1'))
    ap.add_argument('--step', type=float, default=0.5)
    ap.add_argument('--near-y', type=float, default=None,
                    help='only report hits within 0.3m of this height')
    args = ap.parse_args()

    path = os.path.join(G.ROOT, HOUSE)
    print('loading %s (this takes a moment)...' % HOUSE)
    tris = load_triangles(path)
    ox, oy, oz = house_offset()
    print('%d triangles, house world offset (%.2f, %.2f, %.2f)\n' % (len(tris), ox, oy, oz))

    def probe(x, z):
        y = cast_down(tris, x - ox, z - oz, args.from_y - oy)
        return None if y is None else y + oy

    if args.grid:
        x0, x1, z0, z1 = args.grid
        nx = int((x1 - x0) / args.step) + 1
        nz = int((z1 - z0) / args.step) + 1
        print('scanning x %.1f..%.1f  z %.1f..%.1f  at %.2fm steps\n' % (x0, x1, z0, z1, args.step))
        hits = 0
        for j in range(nz):
            z = z0 + j * args.step
            row = []
            for i in range(nx):
                x = x0 + i * args.step
                y = probe(x, z)
                if y is None:
                    row.append('  .  ')
                elif args.near_y is not None and abs(y - args.near_y) > 0.3:
                    row.append('%5.1f' % y)
                else:
                    row.append('[%3.1f]' % y if len(('[%3.1f]' % y)) == 5 else '%5.1f' % y)
                    hits += 1
            print('z=%6.2f  %s' % (z, ' '.join(row)))
        print('\n. = no geometry hit (open air / outside the model)')
        if args.near_y is not None:
            print('[..] = within 0.3m of y=%.2f  (%d matches)' % (args.near_y, hits))
    else:
        if args.x is None or args.z is None:
            sys.exit('need --x/--z or --grid')
        y = probe(args.x, args.z)
        if y is None:
            print('x=%.2f z=%.2f : NO GEOMETRY - open air, nothing to stand on' % (args.x, args.z))
        else:
            print('x=%.2f z=%.2f : floor at y=%.3f' % (args.x, args.z, y))


if __name__ == '__main__':
    main()
