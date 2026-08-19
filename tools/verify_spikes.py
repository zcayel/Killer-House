"""Replay the WALL SPIKE kill test against the visible fence mesh.

The wall-spike equivalent of verify_hits.py. For every unit the trap drives —
the spawned ones from WALL_SPIKE_UNITS and the placed ones from
WALL_SPIKE_PLACED_NAMES — this reconstructs what the runtime does:

    at   = lerp(hidden, extended, travel)
    kill = WALL_SPIKE_MODEL_BOXES rotated+scaled, offset by `at`

...then puts the REAL VISIBLE MESH at the same pose (excluding the model's
collider proxy node, which is a solid slab and is not what the player sees) and
measures, over a grid of standing positions, how far the fence actually was
every time the test says "kill".

    python tools/verify_spikes.py

Reports per unit: where it rests, which way it thrusts, whether it is even
reachable from a floor, and the worst unfair distance.
"""
import json
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import glbkit as G  # noqa: E402

ROOT = G.ROOT
FENCE = os.path.join(ROOT, 'assets', 'asset-packs', 'iron_fence_4', 'HWN20_IronfFence_04.glb')
PLAYER_RADIUS = 0.40
PLAYER_HEIGHT = 1.90
# Both live in src/traps/wallSpikes.ts, which is where the runtime reads them.
# KILL_TRAVEL_MIN is the `unit.travel > 0.1` gate on the lethal check; anything
# at or above it can kill, so it is the earliest pose worth testing.
KILL_TRAVEL_MIN = 0.11
WARNING_PEEK = 0.18
# Read from config, never hardcoded. An earlier hardcoded list held only the
# INTERIOR floors and silently omitted the yard at y=0, which made this tool
# report two yard-level spikes as 'unreachable' when they are in fact standing
# in the grass where players walk. A measuring instrument that cannot see the
# ground is worse than none.
def floor_levels(cfg):
    m = re.search(r'export const FLOOR_LEVELS_Y\s*=\s*\[([^\]]*)\]', cfg)
    if not m:
        sys.exit('FLOOR_LEVELS_Y not found in config.ts')
    out = []
    for tok in m.group(1).split(','):
        tok = tok.strip()
        if not tok:
            continue
        if re.fullmatch(r'-?[\d.]+', tok):
            out.append(float(tok))
        else:
            out.append(num(cfg, tok, 0.0))
    return sorted(set(out))


# ── config ────────────────────────────────────────────────────────────────
def house_rect(cfg):
    """Interior floors are not infinite planes. A panel can sit at exactly the
    right height and still be unreachable because it hangs in the air OUTSIDE
    the building - which is what 4_8 and 4_9 do, 8m up west of the west wall."""
    import re as _re
    m = _re.search(r'export const HOUSE_RECT = \{([^}]*)\}', cfg)
    if not m:
        return None
    d = dict(_re.findall(r'(\w+):\s*([-\d.]+)', m.group(1)))
    return (float(d['minX']), float(d['maxX']), float(d['minZ']), float(d['maxZ']))


def cfg_text():
    return open(os.path.join(ROOT, 'src', 'config.ts'), encoding='utf-8').read()


def num(cfg, name, default=None):
    m = re.search(r'export const %s\s*=\s*([-\d.]+)' % name, cfg)
    if m:
        return float(m.group(1))
    if default is None:
        sys.exit('missing constant %s' % name)
    return default


def boxes_from_cfg(cfg):
    seg = cfg.split('export const WALL_SPIKE_MODEL_BOXES')[1].split('= [', 1)[1].split('\n]')[0]
    out = []
    for m in re.finditer(r'min: Vector3\.create\(([^)]*)\), max: Vector3\.create\(([^)]*)\)', seg):
        mn = [float(x) for x in m.group(1).split(',')]
        mx = [float(x) for x in m.group(2).split(',')]
        out.append((mn, mx))
    return out


def placed_names(cfg):
    seg = cfg.split('export const WALL_SPIKE_PLACED_NAMES')[1].split('= [', 1)[1].split('\n]')[0]
    seg = re.sub(r'//[^\n]*', '', seg)
    return re.findall(r"'([^']+)'", seg)


def spawned_units(cfg):
    seg = cfg.split('export const WALL_SPIKE_UNITS')[1].split('= [', 1)[1].split('\n]')[0]
    out = []
    for m in re.finditer(r'hidden: Vector3\.create\(([^)]*)\), extended: Vector3\.create\(([^)]*)\), '
                         r'rotation: Vector3\.create\(([^)]*)\)', seg):
        h = [float(x) for x in m.group(1).split(',')]
        e = [float(x) for x in m.group(2).split(',')]
        r = [float(x) for x in m.group(3).split(',')]
        out.append((h, e, r))
    return out


# ── maths ─────────────────────────────────────────────────────────────────
def euler_to_quat(dx, dy, dz):
    """Degrees, the same XYZ order Quaternion.fromEulerDegrees uses."""
    hx, hy, hz = (math.radians(v) / 2 for v in (dx, dy, dz))
    cx, sx = math.cos(hx), math.sin(hx)
    cy, sy = math.cos(hy), math.sin(hy)
    cz, sz = math.cos(hz), math.sin(hz)
    return (sx * cy * cz + cx * sy * sz,
            cx * sy * cz - sx * cy * sz,
            cx * cy * sz + sx * sy * cz,
            cx * cy * cz - sx * sy * sz)


def qrot(q, v):
    x, y, z, w = q
    t = (2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0]))
    return (v[0] + w * t[0] + (y * t[2] - z * t[1]),
            v[1] + w * t[1] + (z * t[0] - x * t[2]),
            v[2] + w * t[2] + (x * t[1] - y * t[0]))


def transformed_boxes(model_boxes, q, scale):
    """Exactly wallSpikes.ts transformedBoxes(): scale in model space, rotate, AABB."""
    out = []
    for mn, mx in model_boxes:
        lo = [1e9] * 3
        hi = [-1e9] * 3
        for c in range(8):
            p = qrot(q, ((mx[0] if c & 1 else mn[0]) * scale[0],
                         (mx[1] if c & 2 else mn[1]) * scale[1],
                         (mx[2] if c & 4 else mn[2]) * scale[2]))
            for k in range(3):
                lo[k] = min(lo[k], p[k])
                hi[k] = max(hi[k], p[k])
        out.append((lo, hi))
    return out


def box_hits_player(mn, mx, feet, margin):
    """Exactly hits.ts boxHitsPlayer()."""
    if mx[1] < feet[1] or mn[1] > feet[1] + PLAYER_HEIGHT:
        return False
    nx = max(mn[0], min(feet[0], mx[0]))
    nz = max(mn[2], min(feet[2], mx[2]))
    return math.hypot(feet[0] - nx, feet[2] - nz) < margin


# ── the visible mesh, collider node excluded ──────────────────────────────
def visible_points(spacing=0.03):
    g, bn = G.load(FENCE)
    I = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
    pts = []

    def bary(n):
        return [(i / n, j / n, (n - i - j) / n) for i in range(n + 1) for j in range(n + 1 - i)]

    def walk(i, P):
        n = g['nodes'][i]
        M = G.mul(P, G.ntrs(n))
        if 'mesh' in n:
            label = '%s %s' % (n.get('name', ''), g['meshes'][n['mesh']].get('name', ''))
            if 'collider' not in label.lower():
                for pr in g['meshes'][n['mesh']]['primitives']:
                    if 'POSITION' not in pr.get('attributes', {}):
                        continue
                    pos = G.acc(g, bn, pr['attributes']['POSITION'])
                    idx = ([k[0] for k in G.acc(g, bn, pr['indices'])] if 'indices' in pr
                           else list(range(len(pos))))
                    for k in range(0, len(idx) - 2, 3):
                        q0, q1, q2 = (G.xf(M, pos[idx[k]]), G.xf(M, pos[idx[k + 1]]),
                                      G.xf(M, pos[idx[k + 2]]))
                        e1 = [q1[j] - q0[j] for j in range(3)]
                        e2 = [q2[j] - q0[j] for j in range(3)]
                        cr = (e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2],
                              e1[0] * e2[1] - e1[1] * e2[0])
                        area = 0.5 * math.sqrt(sum(c * c for c in cr))
                        lvl = max(1, min(24, int(math.sqrt(max(area, 1e-9) * 2) / spacing) + 1))
                        for (u, v, w) in bary(lvl):
                            pts.append(tuple(q0[j] * u + q1[j] * v + q2[j] * w for j in range(3)))
        for c in n.get('children', []):
            walk(c, M)

    for sc in g.get('scenes', []):
        for r in sc.get('nodes', []):
            walk(r, I)
    return pts


def capsule_dist(pts, feet):
    top = feet[1] + PLAYER_HEIGHT
    best = 1e9
    for p in pts:
        dy = feet[1] - p[1] if p[1] < feet[1] else (p[1] - top if p[1] > top else 0.0)
        d = math.sqrt((p[0] - feet[0]) ** 2 + dy * dy + (p[2] - feet[2]) ** 2)
        if d < best:
            best = d
    return best


# ── placed transforms ─────────────────────────────────────────────────────
def composite():
    d = json.load(open(os.path.join(ROOT, 'assets', 'scene', 'main.composite'), encoding='utf-8'))
    names, tf = {}, {}
    for c in d.get('components', []):
        if c.get('name') == 'core-schema::Name':
            for k, v in (c.get('data') or {}).items():
                names[k] = (v.get('json') or {}).get('value')
        elif c.get('name') == 'core::Transform':
            for k, v in (c.get('data') or {}).items():
                tf[k] = v.get('json') or {}
    return names, tf


def world_transform(eid, tf):
    """Compose the chain the way wallSpikes.ts worldTransform() does."""
    chain = []
    node, guard = eid, 0
    while node in tf and guard < 16:
        chain.append(node)
        p = tf[node].get('parent')
        if p is None or str(p) == str(node) or str(p) not in tf:
            break
        node = str(p)
        guard += 1
    pos = [0.0, 0.0, 0.0]
    rot = (0.0, 0.0, 0.0, 1.0)
    scl = [1.0, 1.0, 1.0]
    for e in reversed(chain):
        t = tf[e]
        lp = t.get('position') or {}
        lr = t.get('rotation') or {}
        ls = t.get('scale') or {}
        v = (lp.get('x', 0) * scl[0], lp.get('y', 0) * scl[1], lp.get('z', 0) * scl[2])
        v = qrot(rot, v)
        pos = [pos[k] + v[k] for k in range(3)]
        q1 = (lr.get('x', 0), lr.get('y', 0), lr.get('z', 0), lr.get('w', 1))
        a, b = rot, q1
        rot = (a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
               a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
               a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
               a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2])
        scl = [scl[k] * (ls.get('xyz'[k], 1)) for k in range(3)]
    return pos, rot, scl


def main():
    cfg = cfg_text()
    MB = boxes_from_cfg(cfg)
    MARGIN = num(cfg, 'WALL_SPIKE_TOUCH_MARGIN')
    TRAVEL = num(cfg, 'WALL_SPIKE_PLACED_TRAVEL', 1.7)
    SCALE = num(cfg, 'WALL_SPIKE_SCALE', 0.8)
    FLOORS = floor_levels(cfg)
    vis = visible_points()
    print('WALL SPIKE VERIFICATION')
    print('  %d model boxes, touch margin %.2fm, placed travel %.2fm' % (len(MB), MARGIN, TRAVEL))
    print('  visible mesh sampled at %d points (collider node excluded)\n' % len(vis))

    names, tf = composite()
    byname = {v: k for k, v in names.items() if v}
    units = []

    for h, e, r in spawned_units(cfg):
        q = euler_to_quat(*r)
        units.append(('spawned @%.0f,%.0f,%.0f' % tuple(h), h, e, q, [SCALE] * 3))

    for nm in placed_names(cfg):
        eid = byname.get(nm)
        if eid is None:
            print('  %-18s NOT IN SCENE' % nm)
            continue
        pos, q, scl = world_transform(eid, tf)
        pick = qrot(q, (0.0, 1.0, 0.0))
        n = math.sqrt(sum(c * c for c in pick)) or 1.0
        pick = tuple(c / n for c in pick)
        ext = [pos[k] + pick[k] * TRAVEL for k in range(3)]
        units.append((nm, pos, ext, q, scl))

    print('%-20s %-22s %-20s %s' % ('unit', 'rests at', 'thrusts toward', 'reachable from'))
    print('-' * 96)
    results = []
    flat_warnings = []
    outside_warnings = []
    HR = house_rect(cfg)
    for nm, h, e, q, scl in units:
        d = [e[k] - h[k] for k in range(3)]
        L = math.sqrt(sum(c * c for c in d)) or 1.0
        dirn = tuple(c / L for c in d)
        tb = transformed_boxes(MB, q, scl)
        # kill volume at full extension
        kmn = [min(h[k] + (e[k] - h[k]) + b[0][k] for b in tb) for k in range(3)]
        kmx = [max(h[k] + (e[k] - h[k]) + b[1][k] for b in tb) for k in range(3)]
        floors = [f for f in FLOORS if not (kmx[1] < f or kmn[1] > f + PLAYER_HEIGHT)]
        # An INTERIOR floor only exists inside the house footprint. Without this
        # a panel floating outside the building reports as reachable purely
        # because its height matches a floor level somewhere else in the scene.
        if HR is not None:
            inside = (max(kmn[0], HR[0]) <= min(kmx[0], HR[1]) and
                      max(kmn[2], HR[2]) <= min(kmx[2], HR[3]))
            if not inside:
                outside_warnings.append(
                    '%s hangs OUTSIDE the house footprint (panel x %.1f-%.1f z %.1f-%.1f, '
                    'house x %.1f-%.1f z %.1f-%.1f) - no floor beside it, it can never arm'
                    % (nm, kmn[0], kmx[0], kmn[2], kmx[2], HR[0], HR[1], HR[2], HR[3]))
                floors = [f for f in floors if f == 0.0]
        # A spike that is THIN IN Y is not a wall spike, it is a rug. Two of
        # these were adopted by mistake: flat 3.8 x 3.4m panels lying at knee
        # height in open grass, lethal across their whole footprint with
        # nothing recognisable to see. Flag it here so it cannot happen again.
        kr0 = [min(h[k] + b[0][k] for b in tb) for k in range(3)]
        kr1 = [max(h[k] + b[1][k] for b in tb) for k in range(3)]
        thin_axis = min(range(3), key=lambda k: kr1[k] - kr0[k])
        walkable = [f for f in floors if kr0[1] <= f + PLAYER_HEIGHT and kr1[1] >= f]
        if thin_axis == 1 and walkable:
            flat_warnings.append(
                '%s is a FLAT SLAB (y %.2f-%.2f, only %.2fm thick) lying across '
                '%.1f x %.1f m that a player can walk on at y=%s - a rug of blades, '
                'not a wall spike'
                % (nm, kr0[1], kr1[1], kr1[1] - kr0[1], kr1[0] - kr0[0], kr1[2] - kr0[2],
                   ', '.join('%.2f' % f for f in walkable)))
        print('%-20s (%6.2f,%5.2f,%6.2f)  (%5.2f,%5.2f,%5.2f)  %s'
              % (nm[:20], h[0], h[1], h[2], dirn[0], dirn[1], dirn[2],
                 ', '.join('y=%.2f' % f for f in floors) or 'NO FLOOR - unreachable'))
        results.append((nm, h, e, q, scl, tb, floors))

    print('\nUNFAIR KILLS  (test says kill, visible fence further than %.2fm)' % (PLAYER_RADIUS + MARGIN))
    print('-' * 96)
    STEP = 0.25
    for nm, h, e, q, scl, tb, floors in results:
        if not floors:
            print('%-20s skipped - no floor intersects its kill volume' % nm[:20])
            continue
        # EVERY LETHAL POSE, not just the fully extended one.
        #
        # This used to test `at = e` alone. wallSpikes.ts kills at ANY
        # travel > 0.1 - which includes the telegraph peek (0.18), the whole
        # thrust, and the whole retract - and the panel is somewhere different
        # at each of those. Testing only full extension checks the one pose the
        # player is most likely to actually see coming.
        #
        # That gap shipped a real bug: the second-door unit (hidden 26,1,20.8)
        # was lethal across z 20.50-23.60 during its 0.22s telegraph, which
        # covered the doorway at z 21.20, while its fully-extended band had
        # moved on to z 22.1-25.0 and looked clean. It reported 47 kills /
        # 0 unfair right up until it was removed for killing people in that
        # doorway. Sweep the range, and report the WORST pose found.
        travels = [KILL_TRAVEL_MIN, WARNING_PEEK, 0.35, 0.5, 0.75, 1.0]
        kills = unfair = 0
        worst = (0.0, None, None)
        miss = 0
        worst_miss = 0.0
        mesh_pts = 0
        for travel in travels:
            at = [h[k] + (e[k] - h[k]) * travel for k in range(3)]
            mesh = [tuple(at[k] + qrot(q, (p[0] * scl[0], p[1] * scl[1], p[2] * scl[2]))[k]
                          for k in range(3)) for p in vis]
            mesh_pts = len(mesh)
            # A panel below the floor is not something the player can SEE, so it
            # cannot justify a kill. Judging fairness against the whole mesh
            # (including the part buried under the floor) would call a kill fair
            # because a picket two metres under the floorboards was nearby.
            visible = [p for p in mesh if p[1] > min(floors) - 0.05] or mesh
            kmn = [min(at[k] + b[0][k] for b in tb) for k in range(3)]
            kmx = [max(at[k] + b[1][k] for b in tb) for k in range(3)]
            gx = int((kmx[0] - kmn[0]) / STEP) + 4
            gz = int((kmx[2] - kmn[2]) / STEP) + 4
            for f in floors:
                for i in range(-2, gx):
                    for j in range(-2, gz):
                        feet = (kmn[0] + i * STEP, f, kmn[2] + j * STEP)
                        if not any(box_hits_player([at[k] + b[0][k] for k in range(3)],
                                                   [at[k] + b[1][k] for k in range(3)], feet, MARGIN)
                                   for b in tb):
                            continue
                        kills += 1
                        d = capsule_dist(visible, feet)
                        if d > PLAYER_RADIUS + MARGIN:
                            unfair += 1
                            if d > worst[0]:
                                worst = (d, (round(feet[0], 2), f, round(feet[2], 2)), travel)
            # MISSED: does every point of the real mesh sit inside some box?
            for p in mesh:
                d = min(
                    math.sqrt(sum((max(b0 - p[k], 0.0, p[k] - b1)) ** 2
                                 for k, (b0, b1) in enumerate(
                                     zip([at[j] + b[0][j] for j in range(3)],
                                        [at[j] + b[1][j] for j in range(3)]))))
                    for b in tb
                )
                if d > 0.005:  # 5mm: filters float noise at adjacent box seams, not real gaps
                    miss += 1
                    if d > worst_miss:
                        worst_miss = d
        pct = (100.0 * unfair / kills) if kills else 0.0
        flag = '' if unfair == 0 else '   <-- PHANTOM'
        miss_flag = '' if miss == 0 else '   <-- HOLE (real fence untouched by any box)'
        print(f'{nm:20s} mesh coverage: {mesh_pts*len(travels)-miss}/{mesh_pts*len(travels)} points '
              f'inside a box over {len(travels)} poses (worst gap {worst_miss:.3f}m){miss_flag}')
        print('%-20s %4d kills  %4d unfair (%3.0f%%)  worst %.2fm at %s%s%s'
              % (nm[:20], kills, unfair, pct, worst[0], worst[1],
                 '' if worst[2] is None else ' (travel %.2f)' % worst[2], flag))


    for w in outside_warnings:
        print()
        print('  ! %s' % w)
    if flat_warnings:
        print()
        print('ORIENTATION WARNINGS')
        print('-' * 96)
        for w in flat_warnings:
            print('  ! %s' % w)
        print('  Stand these up in Creator Hub - euler (0, 0, 90) like 4_8/4_9 -'
              ' or leave them out of WALL_SPIKE_PLACED_NAMES.')


if __name__ == '__main__':
    main()
