"""Bake a moving GLB part into ORIENTED BOXES that a hit test can use.

This is the tool behind swingTrapShapes.ts. Point it at any .glb with a baked
animation and it measures the moving mesh, pose by pose, and emits keyframes of
oriented boxes ready to paste into TypeScript.

    python tools/bake_hit_shapes.py --model assets/Models/fplank/fplank.glb \
        --clip TemplateHN.011Action.001 --duration 6.125 --name SWING_TRAP_FPLANK

WHY BOXES AND NOT A RADIUS. A sphere or capsule takes the WIDEST extent of
whatever it wraps. The axe head measures 2.69m across but only 0.24m thick, so
as a capsule it becomes a 2.74m cylinder and kills people standing a clear metre
off the flat of the blade. An oriented box keeps the thinness.

EVERYTHING IS CHOSEN BY MEASUREMENT, not by eye:
  * axis sign is anchored to the model's PIVOT (the vertices that barely move
    across the clip) so the slice chain never flips end-for-end between
    keyframes - a flip makes the runtime lerp a head into a handle and puts a
    multi-metre phantom mid-swing;
  * the perpendicular frame is the principal axis OF THE CROSS-SECTION, so a
    flat plate's box lies flat instead of sitting rotated inside a bigger one;
  * slice count keeps rising while each extra slice still removes >8% of the
    lethal volume;
  * each slice is also split ACROSS its width into cells, because a crescent
    (an axe head) leaves empty corners in a single box;
  * keyframes are inserted wherever the interpolated shape sits furthest from
    the real mesh SURFACE, until that error drops under --tolerance.

Surface samples are spaced by AREA, never a fixed count per triangle. That
matters: the plank is 16 triangles, so a fixed count puts samples ~2m apart on
an 8m board and every check measured against them is blind to what it checks.

TWO INVARIANTS THE OUTPUT MUST KEEP, both load-bearing at runtime:
  1. every keyframe carries the same number of boxes, in the same order;
  2. `t` ascends.
Both are asserted before anything is written.
"""
import argparse
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import glbkit as G  # noqa: E402


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def norm(a):
    n = math.sqrt(dot(a, a)) or 1.0
    return (a[0] / n, a[1] / n, a[2] / n)


def fit_boxes(pts, nslice, pivot, wcell, cellcounts=None):
    c = [sum(q[k] for q in pts) / len(pts) for k in range(3)]
    v = [1.0, 0.3, 0.2]
    for _ in range(80):
        a3 = [0.0, 0.0, 0.0]
        for q in pts:
            d = [q[k] - c[k] for k in range(3)]
            dd = sum(d[k] * v[k] for k in range(3))
            for k in range(3):
                a3[k] += d[k] * dd
        n = math.sqrt(sum(x * x for x in a3)) or 1.0
        v = [x / n for x in a3]
    # Sign is arbitrary out of power iteration; anchor it to the pivot.
    if sum((c[k] - pivot[k]) * v[k] for k in range(3)) < 0:
        v = [-x for x in v]
    v = tuple(v)
    proj = [dot([q[k] - c[k] for k in range(3)], v) for q in pts]

    tmp = (1, 0, 0) if abs(v[0]) < 0.9 else (0, 1, 0)
    e1 = norm(cross(tmp, v))
    e2 = cross(v, e1)
    A = B = C = 0.0
    for q, pr in zip(pts, proj):
        d = [q[k] - c[k] - v[k] * pr for k in range(3)]
        x, y = dot(d, e1), dot(d, e2)
        A += x * x
        B += x * y
        C += y * y
    th = 0.5 * math.atan2(2 * B, A - C)
    ca, sa = math.cos(th), math.sin(th)
    f1 = norm(tuple(ca * e1[k] + sa * e2[k] for k in range(3)))
    f2 = cross(v, f1)

    lo, hi = min(proj), max(proj)
    boxes = []
    for i in range(nslice):
        a = lo + (hi - lo) * i / nslice
        b = lo + (hi - lo) * (i + 1) / nslice
        sub = [(q, pr) for q, pr in zip(pts, proj) if (a - 1e-9) <= pr <= (b + 1e-9)]
        if not sub:
            continue
        x1 = [dot([q[k] - c[k] for k in range(3)], f1) for q, _ in sub]
        x2 = [dot([q[k] - c[k] for k in range(3)], f2) for q, _ in sub]
        lo1, hi1 = min(x1), max(x1)
        mid = (a + b) / 2
        ncell = cellcounts[i] if cellcounts is not None else max(1, int((hi1 - lo1) / wcell + 0.999))
        made = []
        for j in range(ncell):
            ca_ = lo1 + (hi1 - lo1) * j / ncell
            cb_ = lo1 + (hi1 - lo1) * (j + 1) / ncell
            cell = [(p1, p2) for p1, p2 in zip(x1, x2) if (ca_ - 1e-9) <= p1 <= (cb_ + 1e-9)]
            if not cell:
                # Never SKIP: that changes the box count between keyframes and
                # slides the whole pairing along by one.
                made.append(None)
                continue
            e1lo = min(p for p, _ in cell)
            e1hi = max(p for p, _ in cell)
            e2lo = min(q for _, q in cell)
            e2hi = max(q for _, q in cell)
            centre = tuple(c[k] + v[k] * mid + f1[k] * (e1lo + e1hi) / 2 + f2[k] * (e2lo + e2hi) / 2
                           for k in range(3))
            made.append((centre, v, f1, ((b - a) / 2, (e1hi - e1lo) / 2, (e2hi - e2lo) / 2)))
        real = [m for m in made if m is not None]
        if not real:
            continue
        boxes.extend([m if m is not None else real[0] for m in made])
    return boxes


def slice_widths(pts, nslice, pivot):
    return [b[3][1] * 2 for b in fit_boxes(pts, nslice, pivot, 1e9)]


def boxes_at(kfs, t):
    """Exactly what the runtime does: lerp, then re-orthonormalise."""
    if t <= kfs[0][0]:
        raw = kfs[0][1]
    elif t >= kfs[-1][0]:
        raw = kfs[-1][1]
    else:
        i = 0
        while i < len(kfs) - 2 and kfs[i + 1][0] < t:
            i += 1
        ta, ba = kfs[i]
        tb, bb = kfs[i + 1]
        u = (t - ta) / ((tb - ta) or 1.0)
        raw = []
        for k in range(len(ba)):
            A, B = ba[k], bb[k] if k < len(bb) else ba[k]
            raw.append(tuple(tuple(A[j][d] + (B[j][d] - A[j][d]) * u for d in range(3))
                             for j in range(4)))
    out = []
    for (centre, u, w, h) in raw:
        u = norm(u)
        w = [w[k] - u[k] * dot(u, w) for k in range(3)]
        w = norm(w)
        out.append((centre, u, w, cross(u, w), h))
    return out


def dist_point_box(p, box):
    centre, u, w, n, h = box
    d = [p[k] - centre[k] for k in range(3)]
    local = (dot(d, u), dot(d, w), dot(d, n))
    s = 0.0
    for k in range(3):
        e = abs(local[k]) - h[k]
        if e > 0:
            s += e * e
    return math.sqrt(s)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--model', required=True, help='path to the .glb, relative to the project root')
    ap.add_argument('--clip', required=True, help='animation clip name inside the .glb')
    ap.add_argument('--duration', type=float, required=True, help='clip length in seconds')
    ap.add_argument('--name', default='SWING_TRAP_SHAPE', help='TS const name for the emitted block')
    ap.add_argument('--tolerance', type=float, default=0.06,
                    help='metres the baked shape may miss the real surface by (default 0.06)')
    ap.add_argument('--max-keyframes', type=int, default=34)
    # SLICES ALONG THE PART'S LENGTH. Auto-selection only ever tried
    # (1,2,3,4,5,6,8), so 8 was a hard ceiling — and --cell-width subdivides
    # ACROSS the width, never along it. On a tapering, curving axe head that
    # leaves one box per slice sized to the slice's WIDEST point, overhanging
    # wherever the blade narrows. Measured: a box reaching ~0.28m past the
    # mesh, which no cell-width or keyframe budget could touch (verified —
    # 24 -> 33 -> 72 boxes/keyframe left the worst phantom kill identical at
    # 0.73m). Override this to spend the budget along the length instead.
    ap.add_argument('--slices', type=int, default=0,
                    help='force N slices along the length (0 = auto, max 8)')
    ap.add_argument('--cell-width', type=float, default=1.0,
                    help='max width of a cross-section cell, metres (default 1.0)')
    ap.add_argument('--samples', type=int, default=4000, help='surface samples per pose')
    ap.add_argument('--out', default=None, help='write the keyframes here instead of stdout')
    # BAKE FROM THE AUTHORED COLLISION SHAPE instead of the render mesh.
    #
    # Default is the render mesh, because for most props that IS the thing the
    # player sees and expects to be hit by. But a model can ship a *_collider
    # node that says, deliberately, "this is my hit volume" — blade.glb does —
    # and then baking the render mesh ignores the artist's intent.
    #
    # Check the hierarchy first: a collider that is a separate ROOT node is not
    # driven by the clip and will bake to a static shape. It has to be a child
    # of the animated node (or animated itself) to be worth baking.
    ap.add_argument('--from-collider', action='store_true',
                    help='bake the *_collider mesh rather than the visible mesh')
    args = ap.parse_args()

    path = args.model if os.path.isabs(args.model) else os.path.join(G.ROOT, args.model)
    if not os.path.exists(path):
        sys.exit('no such model: %s' % path)

    G.SURF_TARGET = args.samples
    part = 'collider' if args.from_collider else 'visible'
    sample = G.make_surface_sampler(path, args.clip, part)
    vsample = G.make_sampler(path, args.clip, part)
    if not sample(0.0):
        sys.exit('no %s geometry found in %s — check the node names'
                 % (part, args.model))
    DUR = args.duration
    pivot = G.find_pivot(vsample, DUR)
    probes = [DUR * k / 60 for k in range(61)]

    print('model    %s' % args.model)
    print('clip     %s   %.3fs' % (args.clip, DUR))
    print('pivot    (%.2f, %.2f, %.2f)' % tuple(pivot))
    print('samples  %d surface points per pose' % len(sample(0.0)))
    print()

    # --- slice count: keep going while each extra slice still pays for itself
    probe_t = [DUR * k / 8 for k in range(9)]
    chosen, prev_v = 1, None
    print('  %7s %10s' % ('slices', 'volume m3'))
    # 10/12/16 are in this list because the old ceiling of 8 WAS A SHIPPED BUG.
    # A slice gets ONE box sized to its widest point, so on a tapering, curving
    # axe head the last slices overhung the blade by ~0.28m and killed players
    # the axe never touched. --cell-width could not reach it (it subdivides
    # ACROSS the width, never along it): 24 -> 33 -> 72 boxes per keyframe left
    # the worst phantom kill identical at 0.73m, while going 8 -> 16 slices cut
    # it to 0.63m and dropped the count from 6 to 1. Do not shorten this list.
    for ns in (args.slices,) if args.slices else (1, 2, 3, 4, 5, 6, 8, 10, 12, 16):
        vol = 0.0
        for t in probe_t:
            vol += sum(8 * b[3][0] * b[3][1] * b[3][2]
                       for b in fit_boxes(sample(t), ns, pivot, args.cell_width))
        vol /= len(probe_t)
        print('  %7d %10.2f' % (ns, vol))
        if args.slices or prev_v is None or vol < prev_v * 0.92:
            chosen, prev_v = ns, vol
    print('  -> %d slices' % chosen)

    # --- cross-section cells, fixed across keyframes so the pairing holds
    cellcounts = [1] * chosen
    for t in [DUR * k / 8 for k in range(9)]:
        for i, w in enumerate(slice_widths(sample(t), chosen, pivot)):
            if i < chosen:
                cellcounts[i] = max(cellcounts[i], max(1, int(w / args.cell_width + 0.999)))
    print('  cells per slice: %s' % cellcounts)

    # --- keyframes: insert where the interpolation is worst
    times = [0.0, DUR / 2, DUR]
    fits = {t: fit_boxes(sample(t), chosen, pivot, args.cell_width, cellcounts) for t in times}
    err = {}

    def score(t, kfs):
        bx = boxes_at(kfs, t)
        g = 0.0
        for p in sample(t):
            d = min(dist_point_box(p, b) for b in bx)
            if d > g:
                g = d
        return g

    while True:
        kfs = [(t, fits[t]) for t in times]
        for t in [p for p in probes if p not in err]:
            err[t] = score(t, kfs)
        worst_t = max(err, key=lambda t: err[t])
        if err[worst_t] <= args.tolerance or len(times) >= args.max_keyframes:
            break
        if min(abs(worst_t - x) for x in times) < 1e-3:
            break
        below = max(x for x in times if x < worst_t)
        above = min(x for x in times if x > worst_t)
        times = sorted(times + [worst_t])
        fits[worst_t] = fit_boxes(sample(worst_t), chosen, pivot, args.cell_width, cellcounts)
        for t in [p for p in probes if below - 1e-9 <= p <= above + 1e-9]:
            err.pop(t, None)

    kfs = [(t, fits[t]) for t in times]

    # --- the invariants, asserted rather than hoped for
    counts = {len(bx) for _, bx in kfs}
    assert len(counts) == 1, 'box count varies between keyframes: %s' % counts
    ts = [t for t, _ in kfs]
    assert all(b > a for a, b in zip(ts, ts[1:])), 't does not ascend'
    # The first box must stay the pivot-end one in every keyframe. If that ever
    # swaps, the runtime is lerping one end of the object into the other.
    flips = sum(1 for _, bx in kfs
                if math.dist(bx[0][0], pivot) > math.dist(bx[-1][0], pivot))
    assert flips == 0, 'slice chain flips end-for-end in %d keyframes' % flips

    worst = max(score(t, kfs) for t in probes)
    vol = sum(sum(8 * b[4][0] * b[4][1] * b[4][2] for b in boxes_at(kfs, t)) for t in probes) / len(probes)
    ref = 0.0
    for t in probes:
        pts = sample(t)
        mn = [min(p[k] for p in pts) for k in range(3)]
        mx = [max(p[k] for p in pts) for k in range(3)]
        ref += (mx[0] - mn[0]) * (mx[1] - mn[1]) * (mx[2] - mn[2])
    ref /= len(probes)

    print()
    print('  keyframes %d   boxes each %d   total %d' % (len(kfs), counts.copy().pop(),
                                                         len(kfs) * counts.copy().pop()))
    print('  orientation flips %d (must be 0)' % flips)
    print('  worst gap vs the real surface: %.3f m  (tolerance %.3f)' % (worst, args.tolerance))
    print('  lethal volume %.2f m3 vs the axis-aligned box %.2f m3  -> %.0f%% less phantom'
          % (vol, ref, 100 * (1 - vol / ref)))
    print()

    lines = []
    for t, bx in kfs:
        parts = []
        for (centre, u, w, h) in bx:
            parts.append('{ c: Vector3.create(%.3f, %.3f, %.3f), u: Vector3.create(%.3f, %.3f, %.3f), '
                         'w: Vector3.create(%.3f, %.3f, %.3f), h: Vector3.create(%.3f, %.3f, %.3f) }'
                         % (centre[0], centre[1], centre[2], u[0], u[1], u[2],
                            w[0], w[1], w[2], h[0], h[1], h[2]))
        lines.append('    { t: %.3f, boxes: [%s] },' % (t, ', '.join(parts)))
    body = '// ==== %s ====\n' % args.name + '\n'.join(lines) + '\n'

    if args.out:
        dest = args.out if os.path.isabs(args.out) else os.path.join(G.ROOT, args.out)
        open(dest, 'w', encoding='utf-8').write(body)
        print('keyframes written to %s' % dest)
    else:
        print(body)


if __name__ == '__main__':
    main()
