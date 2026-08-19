"""Score a swinging-axe placement against the real house mesh.

WHY THIS EXISTS. tools/verify_hits.py answers "is the kill fair once the axe is
somewhere" - it sweeps a player around and measures distance at the moment of
death. It cannot answer "should the axe be there at all", and it read placements
from assets/scene/main.composite while the game reads main.crdt, so for
pblade2.glb_2 it was scoring a spot 11m from where the trap actually ran.

This tool asks the placement question directly, against KILLERHOUSE_.glb:

  BURIED   - lethal boxes intersecting solid house geometry. Arc inside a wall
             is arc the player cannot see coming: a phantom kill by definition.
  SPANNING - the sweep crossing a floor slab, so it kills people upstairs and
             downstairs at once through a floor neither of them can see through.
  BLIND    - the visible axe is not where the entity origin is. pblade2.glb
             hangs 5.2-6.2m in -z and 2.1-4.8m in -y from its own origin, so
             the Creator Hub gizmo is ~5.7m from the thing you are aiming.

The axe's own numbers are why full scale cannot work indoors: the shrunk sweep
is 6.70m tall, and the tallest gap between two floor levels in this house is
5.01m. Anything at scale 1.0 kills through a floor somewhere.

    python tools/place_axes.py --pos 19.25 9.16 17.0 --rot-y 0 --scale 0.74
    python tools/place_axes.py --scan --scale 0.74
    python tools/place_axes.py --check-code     # score what config.ts ships
"""
import argparse
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import glbkit as G  # noqa: E402

ROOT = G.ROOT
HOUSE = os.path.join('assets', 'Models', 'KILLERHOUSE_', 'KILLERHOUSE_.glb')
SHAPES = os.path.join(ROOT, 'src', 'traps', 'swingTrapShapes.ts')
CONFIG = os.path.join(ROOT, 'src', 'config.ts')

# From FLOOR_LEVELS_Y in config.ts. A sweep that crosses one of these is
# reaching through a floor slab.
FLOOR_LEVELS = [8.58, 7.65, 2.64, 0.0]
PLAYER_HEIGHT = 1.90

# How deep a lethal box may sit in solid geometry before it counts as buried.
# The house mesh has trim and skirting a few cm proud of the wall plane; this
# is under that, and far under the player's 0.40 body radius.
BURY_TOLERANCE = 0.05

# ACCEPTED, DELIBERATE BURIAL — placement name -> (max % buried, max floors crossed).
#
# A gate that is permanently red teaches people to ignore it, and a gate that is
# silently green teaches them nothing at all. Same compromise as KNOWN_OVERHANG
# in check_hidden_colliders.py: a defect that is a level DECISION rather than a
# defect gets recorded here with its measured cost, so the number is visible in
# the diff and anything WORSE still fails.
#
# 2026-08-19: blade.glb replaced pblade2.glb and the two blades were placed in
# Creator Hub. Measured there, boxes baked from the model's own collider at
# extentShrink 1.00:
#   blade.glb    7.5% buried (130/1722), crosses floor levels 8.58 and 7.65
#   blade.glb_2 10.9% buried (188/1722), crosses floor levels 8.58 and 7.65
# The arc is 9.78m x 6.48m and the largest gap between two floors here is
# 5.01m, so a full-scale blade indoors always reaches through one.
#
# The allowances below are those numbers with a little headroom for a re-bake
# shifting a box or two. They are NOT permission to drift: raising them to make
# a red build green is the failure this gate exists to catch. Lower them —
# ideally to 0 — if the blades are ever moved somewhere clear, or scaled below
# ~0.74 so the arc fits between two floors.
ACCEPTED_BURIED = {
    'blade.glb': (8.5, 2),
    'blade.glb_2': (12.0, 2),
}


def load_boxes(const):
    """Every lethal box of every keyframe, with extentShrink already applied."""
    src = open(SHAPES, encoding='utf-8').read()
    seg = src.split('export const ' + const)[1].split('\n}\n')[0]
    m = re.search(r'extentShrink: ([\d.]+)', seg)
    shrink = float(m.group(1)) if m else 1.0
    out = []
    pat = (r'c: Vector3\.create\(([-\d., ]+)\), u: Vector3\.create\(([-\d., ]+)\), '
           r'w: Vector3\.create\(([-\d., ]+)\), h: Vector3\.create\(([-\d., ]+)\)')
    for line in seg.split('\n'):
        km = re.match(r'\s*\{ t: ([-\d.]+), boxes: \[(.*)\] \},?\s*$', line)
        if not km:
            continue
        t = float(km.group(1))
        for b in re.finditer(pat, km.group(2)):
            c, u, w, h = [[float(x) for x in g.split(',')] for g in b.groups()]
            out.append((t, c, u, w, [v * shrink for v in h]))
    return out, shrink


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]]


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def place(box, pos, rot_y, scale):
    """Model-space baked box -> world OBB (centre, 3 unit axes, 3 half-extents)."""
    _t, c0, u0, w0, h = box
    # X negated, exactly as toWorld() in traps/swingTraps.ts does it: the bake
    # is in glTF space and the engine mirrors a .glb on X when it loads it. The
    # house is NOT mirrored (its bounds match the in-game HOUSE_RECT), so the
    # boxes have to be brought into the house's space here.
    c = [-c0[0], c0[1], c0[2]]
    u = [-u0[0], u0[1], u0[2]]
    w = [-w0[0], w0[1], w0[2]]
    ca, sa = math.cos(rot_y), math.sin(rot_y)

    def rot(v):
        return [v[0] * ca + v[2] * sa, v[1], -v[0] * sa + v[2] * ca]

    cw = rot([c[0] * scale, c[1] * scale, c[2] * scale])
    cw = [cw[0] + pos[0], cw[1] + pos[1], cw[2] + pos[2]]
    uu, ww = rot(u), rot(w)
    vv = cross(uu, ww)
    return cw, [uu, ww, vv], [h[0] * scale, h[1] * scale, h[2] * scale]


def tri_obb(tri, c, axes, h, shrink_h=0.0):
    """Exact triangle vs oriented box, separating axis theorem."""
    hh = [max(v - shrink_h, 1e-4) for v in h]
    v = []
    for p in tri:
        d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]]
        v.append([dot(d, axes[0]), dot(d, axes[1]), dot(d, axes[2])])
    for i in range(3):
        if min(v[0][i], v[1][i], v[2][i]) > hh[i]:
            return False
        if max(v[0][i], v[1][i], v[2][i]) < -hh[i]:
            return False
    e = [[v[1][i] - v[0][i] for i in range(3)],
         [v[2][i] - v[1][i] for i in range(3)],
         [v[0][i] - v[2][i] for i in range(3)]]
    n = cross(e[0], e[1])
    r = abs(n[0]) * hh[0] + abs(n[1]) * hh[1] + abs(n[2]) * hh[2]
    d0 = dot(n, v[0])
    if d0 > r or d0 < -r:
        return False
    for i in range(3):
        for j in range(3):
            a = [0.0, 0.0, 0.0]
            a[(j + 1) % 3] = -e[i][(j + 2) % 3]
            a[(j + 2) % 3] = e[i][(j + 1) % 3]
            if abs(a[0]) + abs(a[1]) + abs(a[2]) < 1e-9:
                continue
            p = [dot(a, x) for x in v]
            r = sum(abs(a[k]) * hh[k] for k in range(3))
            if min(p) > r or max(p) < -r:
                return False
    return True


class TriGrid:
    """Uniform grid over the house so each box only meets nearby triangles."""

    def __init__(self, tris, cell=1.5):
        self.cell = cell
        self.g = {}
        for i, t in enumerate(tris):
            lo = [min(p[k] for p in t) for k in range(3)]
            hi = [max(p[k] for p in t) for k in range(3)]
            for ix in range(int(lo[0] // cell), int(hi[0] // cell) + 1):
                for iy in range(int(lo[1] // cell), int(hi[1] // cell) + 1):
                    for iz in range(int(lo[2] // cell), int(hi[2] // cell) + 1):
                        self.g.setdefault((ix, iy, iz), []).append(i)
        self.tris = tris

    def near(self, lo, hi):
        c = self.cell
        seen = set()
        for ix in range(int(lo[0] // c), int(hi[0] // c) + 1):
            for iy in range(int(lo[1] // c), int(hi[1] // c) + 1):
                for iz in range(int(lo[2] // c), int(hi[2] // c) + 1):
                    seen.update(self.g.get((ix, iy, iz), ()))
        return [self.tris[i] for i in seen]


def crdt_placements():
    """Every GltfContainer in main.crdt, as {src: [(entity, pos, quat, scale)]}.

    main.crdt, NOT assets/scene/main.composite. The composite is the Creator Hub
    editor's file; main.crdt is what the runtime loads, and on 2026-08-19 the two
    disagreed about where pblade2.glb_2 was by 11 metres. Any tool that reasons
    about placement has to read the shipped one or it is scoring a scene nobody
    plays.
    """
    import struct
    d = open(os.path.join(ROOT, 'main.crdt'), 'rb').read()
    off = 0
    gl = {}
    tf = {}
    nm = {}
    while off + 8 <= len(d):
        ln, _ty = struct.unpack_from('<II', d, off)
        if ln < 8 or off + ln > len(d):
            break
        ent, cid, _ts, dl = struct.unpack_from('<IIII', d, off + 8)
        p = d[off + 24:off + 24 + dl]
        if cid == 1041:  # GltfContainer
            i = 0
            src = None
            while i < len(p):
                key = p[i]
                i += 1
                f, wt = key >> 3, key & 7
                if wt == 2:
                    ln2 = p[i]
                    i += 1
                    v = p[i:i + ln2]
                    i += ln2
                    if f == 1:
                        src = v.decode('utf-8', 'replace')
                elif wt == 0:
                    while p[i] & 0x80:
                        i += 1
                    i += 1
                else:
                    break
            if src:
                gl[ent] = src
        elif cid == 1 and len(p) >= 44:  # Transform
            tf[ent] = struct.unpack_from('<10fI', p, 0)
        elif cid == 3864921337:  # core-schema::Name
            nm[ent] = ''.join(ch for ch in p[1:].decode('utf-8', 'replace')
                              if ch.isprintable()).strip()
        off += ln
    out = {}
    for ent, src in gl.items():
        t = tf.get(ent)
        if t is None:
            continue
        # the entity's REAL name, not one synthesised from iteration order —
        # crdt dict order does not match the editor's _2 suffixes, and naming
        # by order silently swapped the two blades' budgets.
        out.setdefault(src, []).append(
            (ent, list(t[0:3]), list(t[3:7]), list(t[7:10]), nm.get(ent, str(ent))))
    return out


def house_offset():
    """Where KILLERHOUSE_.glb is placed, per main.crdt."""
    for src, uses in crdt_placements().items():
        if 'KILLERHOUSE' in src:
            return uses[0][1]
    return [0.0, 0.0, 0.0]


def load_house():
    """House triangles in WORLD space.

    The .glb is authored about its own origin; the placed entity sits at
    house_offset(). Skipping that step puts every triangle ~23m from where the
    player meets it, which reads as "nothing is ever in the way" - the exact
    false PASS this tool exists to avoid.
    """
    g, bn = G.load(os.path.join(ROOT, HOUSE))
    ox, oy, oz = house_offset()
    # NOT mirrored. G.dcl() mirrors the animated trap models (see the
    # HANDEDNESS note in glbkit.py), but the house must not be: its bounds read
    # unmirrored as x 14.39..34.72, which matches HOUSE_RECT (14.0..35.0) —
    # and HOUSE_RECT was measured by hand IN GAME, so it is ground truth for
    # engine space. Mirrored it would read 11.28..31.61 and miss by 3m.
    I = [[1, 0, 0, ox], [0, 1, 0, oy], [0, 0, 1, oz], [0, 0, 0, 1]]
    tris = []

    def walk(i, P):
        n = g['nodes'][i]
        M = G.mul(P, G.ntrs(n))
        if 'mesh' in n:
            for pr in g['meshes'][n['mesh']]['primitives']:
                if 'POSITION' not in pr.get('attributes', {}):
                    continue
                pos = G.acc(g, bn, pr['attributes']['POSITION'])
                idx = ([k[0] for k in G.acc(g, bn, pr['indices'])]
                       if 'indices' in pr else list(range(len(pos))))
                for k in range(0, len(idx) - 2, 3):
                    tris.append((G.xf(M, pos[idx[k]]), G.xf(M, pos[idx[k + 1]]),
                                 G.xf(M, pos[idx[k + 2]])))
        for c in n.get('children', []):
            walk(c, M)

    for sc in g.get('scenes', []):
        for r in sc.get('nodes', []):
            walk(r, I)
    return tris


def score(boxes, grid, pos, rot_y, scale):
    """(buried count, total, sweep AABB, floors crossed)."""
    lo = [1e9] * 3
    hi = [-1e9] * 3
    buried = 0
    for b in boxes:
        c, axes, h = place(b, pos, rot_y, scale)
        for sx in (-1, 1):
            for sy in (-1, 1):
                for sz in (-1, 1):
                    p = [c[k] + sx * h[0] * axes[0][k] + sy * h[1] * axes[1][k]
                         + sz * h[2] * axes[2][k] for k in range(3)]
                    for k in range(3):
                        lo[k] = min(lo[k], p[k])
                        hi[k] = max(hi[k], p[k])
        r = max(h)
        if any(tri_obb(t, c, axes, h, BURY_TOLERANCE)
               for t in grid.near([c[k] - r for k in range(3)],
                                  [c[k] + r for k in range(3)])):
            buried += 1
    crossed = [f for f in FLOOR_LEVELS if lo[1] < f - 0.02 < hi[1]]
    return buried, len(boxes), (lo, hi), crossed


def report(name, boxes, grid, pos, rot_y_deg, scale):
    rot_y = math.radians(rot_y_deg)
    buried, total, (lo, hi), crossed = score(boxes, grid, pos, rot_y, scale)
    pct = 100.0 * buried / total if total else 0.0
    print('%s  pos (%.2f, %.2f, %.2f)  rotY %.1f  scale %.3f'
          % (name, pos[0], pos[1], pos[2], rot_y_deg, scale))
    print('   lethal sweep   x %+7.2f..%-7.2f  y %+7.2f..%-7.2f  z %+7.2f..%-7.2f'
          % (lo[0], hi[0], lo[1], hi[1], lo[2], hi[2]))
    print('   buried boxes   %d / %d  (%.1f%%)' % (buried, total, pct))
    if crossed:
        print('   SPANNING       crosses floor level(s) %s'
              % ', '.join('%.2f' % f for f in crossed))
    else:
        print('   spanning       no floor slab crossed')
    allow_pct, allow_cross = ACCEPTED_BURIED.get(name, (1.0, 0))
    ok = pct <= allow_pct and len(crossed) <= allow_cross
    if name in ACCEPTED_BURIED and ok and (pct >= 1.0 or crossed):
        print('   verdict        ACCEPTED (budget %.1f%% buried, %d floors — '
              'see ACCEPTED_BURIED)' % (allow_pct, allow_cross))
    else:
        print('   verdict        %s' % ('OK' if ok else 'REJECT'))
    print()
    return ok, pct, crossed


def read_code_placements():
    """The placed blades, straight out of main.crdt.

    Was SWING_TRAP_PLACEMENTS in config.ts while the axes were spawned from
    code. That existed because pblade2.glb's origin sat 5.7m from the blade and
    the Creator Hub gizmo could not be trusted. blade.glb put the origin on the
    pivot, so the blades are adopted from the editor again and this reads the
    scene — main.crdt specifically, the file the runtime loads.
    """
    out = []
    for src, uses in crdt_placements().items():
        if 'blade' not in src.split('/')[-1]:
            continue
        for _ent, pos, quat, scl, name in uses:
            # quaternion -> degrees about Y (these are authored Y-only)
            ry = math.degrees(2.0 * math.atan2(quat[1], quat[3]))
            out.append((name, list(pos), ry, max(abs(v) for v in scl)))
    return sorted(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pos', nargs=3, type=float)
    ap.add_argument('--rot-y', type=float, default=0.0)
    ap.add_argument('--scale', type=float, default=0.74)
    ap.add_argument('--scan', action='store_true')
    ap.add_argument('--check-code', action='store_true')
    a = ap.parse_args()

    boxes, shrink = load_boxes('SWING_TRAP_PBLADE')
    print('loading the house mesh (this takes a moment)...')
    tris = load_house()
    grid = TriGrid(tris)
    print('%d triangles, %d lethal boxes across the clip, extentShrink %.2f\n'
          % (len(tris), len(boxes), shrink))

    if a.check_code:
        pl = read_code_placements()
        if not pl:
            print('config.ts has no SWING_TRAP_PLACEMENTS yet.')
            sys.exit(1)
        bad = 0
        for nm, p, ry, sc in pl:
            ok, _pct, _cr = report(nm, boxes, grid, p, ry, sc)
            if not ok:
                bad += 1
        if bad:
            print('FAIL - %d placement(s) rejected.' % bad)
            sys.exit(1)
        print('PASS - every shipped axe placement is within its budget.')
        if any(n in ACCEPTED_BURIED for n, _p, _r, _s in pl):
            print('       NOTE: some placements pass on an ACCEPTED_BURIED')
            print('       allowance, not because they are clear. Their arcs do')
            print('       pass through house geometry - that is a recorded')
            print('       level decision, printed above, not a clean result.')
        return

    if a.scan:
        scan(boxes, grid, a.scale)
        return

    if not a.pos:
        ap.error('give --pos X Y Z, or --scan, or --check-code')
    ok, _pct, _cr = report('candidate', boxes, grid, a.pos, a.rot_y, a.scale)
    sys.exit(0 if ok else 1)


def scan(boxes, grid, scale, floor=2.64, ceil=7.65, coarse=8):
    """Hunt for placements that are neither buried nor spanning.

    Two passes on purpose. Scoring all 2132 boxes takes ~2s, and the search
    space is thousands of positions, so the sweep runs on every Nth box to find
    candidates and only the survivors pay for the full check. A coarse pass that
    says "clear" can still be wrong in detail - that is what the second pass is
    for - but a coarse pass that says "buried" never needs a second look.
    """
    # The sweep hangs 1.996..8.699 below the origin at scale 1. Put its bottom
    # on the walkable floor so it can actually reach someone standing there.
    need = 6.703 * scale
    if need > ceil - floor - 0.05:
        print('scale %.2f will not fit between %.2f and %.2f: sweep is %.2fm, '
              'gap is %.2fm.' % (scale, floor, ceil, need, ceil - floor))
        print('max usable scale here is %.3f' % ((ceil - floor - 0.05) / 6.703))
        return
    oy = floor + 8.699 * scale
    print('floor %.2f, ceiling %.2f: origin y %.2f, sweep %.2f..%.2f (%.2fm)'
          % (floor, ceil, oy, floor, oy - 1.996 * scale, need))
    sub = boxes[::coarse]
    print('coarse pass on %d of %d boxes...' % (len(sub), len(boxes)))
    cands = []
    for rot_deg in (0, 90, 180, 270):
        ry = math.radians(rot_deg)
        for xi in range(28, 70):
            x = xi * 0.5
            for zi in range(16, 54):
                z = zi * 0.5
                b, t, _ab, cr = score(sub, grid, [x, oy, z], ry, scale)
                if cr or b:
                    continue
                cands.append((x, oy, z, rot_deg))
    print('%d candidates clear on the coarse pass; full check...' % len(cands))
    out = []
    for x, y, z, r in cands:
        b, t, ab, cr = score(boxes, grid, [x, y, z], math.radians(r), scale)
        if cr or b:
            continue
        out.append((x, y, z, r, ab))
    print('%d fully clear:\n' % len(out))
    for x, y, z, r, ab in out:
        lo, hi = ab
        print('   pos (%.2f, %.2f, %.2f) rotY %-4d  sweep x %.2f..%.2f  z %.2f..%.2f'
              % (x, y, z, r, lo[0], hi[0], lo[2], hi[2]))
    return out


if __name__ == '__main__':
    main()
