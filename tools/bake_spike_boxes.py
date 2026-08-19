"""Re-measure the wall spike panel's kill boxes from the VISIBLE mesh only.

THE BUG THIS FIXES. HWN20_IronfFence_04.glb contains two mesh nodes:

    HWN20_IronfFence_04            428 verts   4.02 x 3.35 x 0.16 m   the pickets
    HWN20_IronfFence_04_collider    56 verts   3.97 x 3.04 x 0.23 m   a solid box

The old WALL_SPIKE_MODEL_BOXES were measured over the UNION of the two, so the
lethal volume was really the collider proxy: a solid slab spanning the whole
panel. An iron fence is mostly the gaps between its pickets, so that slab kills
anyone standing in a gap, touching nothing they can see - and it is 44% thicker
than the fence as well. Same class of mistake as wrapping a flat axe head in a
capsule.

Physics colliders are meant to be cheap and generous; a KILL volume is a promise
about what the player can see. They must not be the same shape.

METHOD
  1. sample the visible mesh's triangles, spaced by AREA (never a fixed count
     per triangle - this model has 228 triangles of wildly different sizes);
  2. rasterise them into an occupancy grid across the panel's XY face;
  3. cover the occupied cells with a small number of axis-aligned boxes, taking
     the largest all-occupied rectangle each time;
  4. give each box the real z-extent of the geometry inside it, not the panel's;
  5. verify: every sampled surface point must land inside some box.

Emits a WALL_SPIKE_MODEL_BOXES block for src/config.ts.

    python tools/bake_spike_boxes.py
    python tools/bake_spike_boxes.py --cell 0.03 --max-boxes 28
"""
import argparse
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import glbkit as G  # noqa: E402

FENCE = os.path.join('assets', 'asset-packs', 'iron_fence_4', 'HWN20_IronfFence_04.glb')


def visible_surface(path, spacing):
    """Surface points of every mesh node whose name does NOT say 'collider'."""
    g, bn = G.load(path)
    I = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
    pts = []
    skipped = []

    def tris(mi):
        out = []
        for pr in g['meshes'][mi]['primitives']:
            if 'POSITION' not in pr.get('attributes', {}):
                continue
            pos = G.acc(g, bn, pr['attributes']['POSITION'])
            idx = ([i[0] for i in G.acc(g, bn, pr['indices'])] if 'indices' in pr
                   else list(range(len(pos))))
            for k in range(0, len(idx) - 2, 3):
                out.append((pos[idx[k]], pos[idx[k + 1]], pos[idx[k + 2]]))
        return out

    def bary(n):
        return [(i / n, j / n, (n - i - j) / n)
                for i in range(n + 1) for j in range(n + 1 - i)]

    def walk(i, P):
        n = g['nodes'][i]
        M = G.mul(P, G.ntrs(n))
        if 'mesh' in n:
            label = '%s %s' % (n.get('name', ''), g['meshes'][n['mesh']].get('name', ''))
            if 'collider' in label.lower():
                skipped.append(n.get('name'))
            else:
                for (p0, p1, p2) in tris(n['mesh']):
                    q0, q1, q2 = G.xf(M, p0), G.xf(M, p1), G.xf(M, p2)
                    e1 = [q1[k] - q0[k] for k in range(3)]
                    e2 = [q2[k] - q0[k] for k in range(3)]
                    cr = (e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2],
                          e1[0] * e2[1] - e1[1] * e2[0])
                    area = 0.5 * math.sqrt(sum(c * c for c in cr))
                    lvl = max(1, min(48, int(math.sqrt(max(area, 1e-9) * 2) / spacing) + 1))
                    for (u, v, w) in bary(lvl):
                        pts.append(tuple(q0[k] * u + q1[k] * v + q2[k] * w for k in range(3)))
        for c in n.get('children', []):
            walk(c, M)

    for sc in g.get('scenes', []):
        for r in sc.get('nodes', []):
            walk(r, I)
    return pts, skipped


def largest_rect(grid, W, H):
    """Largest all-True axis-aligned rectangle. Classic histogram sweep."""
    best = (0, 0, 0, 0, 0)   # area, x0, y0, x1, y1
    heights = [0] * W
    for y in range(H):
        for x in range(W):
            heights[x] = heights[x] + 1 if grid[y * W + x] else 0
        stack = []
        for x in range(W + 1):
            h = heights[x] if x < W else 0
            start = x
            while stack and stack[-1][1] >= h:
                sx, sh = stack.pop()
                area = sh * (x - sx)
                if area > best[0]:
                    best = (area, sx, y - sh + 1, x - 1, y)
                start = sx
            stack.append((start, h))
    return best


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--model', default=FENCE)
    ap.add_argument('--cell', type=float, default=0.04, help='grid cell size, metres')
    ap.add_argument('--spacing', type=float, default=0.015, help='surface sample spacing, metres')
    ap.add_argument('--max-boxes', type=int, default=24)
    ap.add_argument('--out', default=None)
    args = ap.parse_args()

    path = args.model if os.path.isabs(args.model) else os.path.join(G.ROOT, args.model)
    pts, skipped = visible_surface(path, args.spacing)
    print('model    %s' % args.model)
    print('EXCLUDED collider nodes: %s' % (skipped or 'none found'))
    print('sampled  %d surface points off the visible mesh' % len(pts))

    mn = [min(p[k] for p in pts) for k in range(3)]
    mx = [max(p[k] for p in pts) for k in range(3)]
    print('visible  x %.3f..%.3f  y %.3f..%.3f  z %.3f..%.3f'
          % (mn[0], mx[0], mn[1], mx[1], mn[2], mx[2]))

    C = args.cell
    W = int((mx[0] - mn[0]) / C) + 1
    H = int((mx[1] - mn[1]) / C) + 1
    occ = [False] * (W * H)
    zlo = [1e9] * (W * H)
    zhi = [-1e9] * (W * H)
    for p in pts:
        gx = min(W - 1, int((p[0] - mn[0]) / C))
        gy = min(H - 1, int((p[1] - mn[1]) / C))
        i = gy * W + gx
        occ[i] = True
        zlo[i] = min(zlo[i], p[2])
        zhi[i] = max(zhi[i], p[2])
    filled = sum(1 for o in occ if o)
    print('grid     %d x %d cells of %.0f mm; %d occupied (%.0f%% of the panel face)'
          % (W, H, C * 1000, filled, 100.0 * filled / (W * H)))

    # cover the occupied cells with as few rectangles as the budget allows
    todo = list(occ)
    boxes = []
    while any(todo) and len(boxes) < args.max_boxes:
        area, x0, y0, x1, y1 = largest_rect(todo, W, H)
        if area <= 0:
            break
        zl, zh = 1e9, -1e9
        for yy in range(y0, y1 + 1):
            for xx in range(x0, x1 + 1):
                i = yy * W + xx
                todo[i] = False
                if occ[i]:
                    zl = min(zl, zlo[i])
                    zh = max(zh, zhi[i])
        if zl > zh:
            zl, zh = mn[2], mx[2]
        boxes.append((mn[0] + x0 * C, mn[1] + y0 * C, zl,
                      mn[0] + (x1 + 1) * C, mn[1] + (y1 + 1) * C, zh))
    leftover = sum(1 for t in todo if t)

    # verify: no sampled point may fall outside every box
    outside = 0
    for p in pts:
        if not any(b[0] - 1e-6 <= p[0] <= b[3] + 1e-6 and b[1] - 1e-6 <= p[1] <= b[4] + 1e-6
                   and b[2] - 1e-6 <= p[2] <= b[5] + 1e-6 for b in boxes):
            outside += 1

    vol = sum((b[3] - b[0]) * (b[4] - b[1]) * max(b[5] - b[2], 1e-3) for b in boxes)
    slab = (mx[0] - mn[0]) * (mx[1] - mn[1]) * 0.234   # the old collider-proxy slab
    print('boxes    %d   uncovered occupied cells %d   surface points outside all boxes %d'
          % (len(boxes), leftover, outside))
    print('volume   %.3f m3 vs the old collider slab %.3f m3  -> %.0f%% less lethal air'
          % (vol, slab, 100 * (1 - vol / slab)))

    body = ['export const WALL_SPIKE_MODEL_BOXES: { min: Vector3; max: Vector3 }[] = [']
    for b in boxes:
        body.append('  { min: Vector3.create(%.3f, %.3f, %.3f), max: Vector3.create(%.3f, %.3f, %.3f) },'
                    % (b[0], b[1], b[2], b[3], b[4], b[5]))
    body.append(']')
    text = '\n'.join(body) + '\n'
    if args.out:
        dest = args.out if os.path.isabs(args.out) else os.path.join(G.ROOT, args.out)
        open(dest, 'w', encoding='utf-8').write(text)
        print('\nwritten to %s' % dest)
    else:
        print()
        print(text)


if __name__ == '__main__':
    main()
