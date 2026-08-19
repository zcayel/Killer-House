"""Replay the SHIPPED kill test against the real animated mesh.

Volume ratios are a proxy. This asks the question directly: sweep the player
across a grid, on both floors, through the clip, and every time the game says
"kill", measure how far the model actually was at that instant.

  UNFAIR  - killed with the model further away than your own body radius.
  MISSED  - the mesh passed through you and nothing happened.

It reads the keyframes out of src/traps/swingTrapShapes.ts and the placements
out of assets/scene/main.composite, so it tests what actually ships rather than
a copy of it. Re-run after any re-bake, or after moving anything in Creator Hub.

    python tools/verify_hits.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import glbkit as G

G.SURF_TARGET = 8000  # dense enough that the measured distances are real

import json
import math
import os
import re

ROOT = G.ROOT
PLAYER_RADIUS = 0.40
PLAYER_HEIGHT = 1.90
TOUCH_MARGIN = 0.05      # SWING_TRAP_TOUCH_MARGIN
# The lethal-box shrink is PER MODEL now (SwingTrapModel.extentShrink in
# src/traps/swingTrapShapes.ts) and is read straight out of that file by
# load_model(), so this tool cannot drift from what ships.
# Current measured state: 1 unfair per axe at 0.63m (threshold 0.60), 0 on the
# planks, 0 missed anywhere. Set to 1 rather than 0 so the gate holds the line
# where it actually is; tighten it to 0 if that last case is ever fixed. Never
# RAISE it to make a red build green - that is the failure this gate exists
# to catch.
ALLOWED_UNFAIR = 1
TOTALS = {}
SUBSTEPS = 3
DT = 1.0 / 30.0

SHAPES = os.path.join(ROOT, 'src', 'traps', 'swingTrapShapes.ts')


# ── read the shipped keyframes ─────────────────────────────────────────────
def load_model(const):
    src = open(SHAPES, encoding='utf-8').read()
    seg = src.split(f'export const {const}')[1].split('\n}\n')[0]
    dur = float(re.search(r'duration: ([\d.]+)', seg).group(1))
    below = 'killFromBelowOnly: true' in seg
    cause = re.search(r"deathCause: '([^']+)'", seg).group(1)
    _sh = re.search(r'extentShrink: ([\d.]+)', seg)
    shrink = float(_sh.group(1)) if _sh else 1.0
    kfs = []
    for line in seg.split('\n'):
        m = re.match(r'\s*\{ t: ([-\d.]+), boxes: \[(.*)\] \},?\s*$', line)
        if not m:
            continue
        t = float(m.group(1))
        boxes = []
        for bm in re.finditer(
                r'\{ c: Vector3\.create\(([^)]*)\), u: Vector3\.create\(([^)]*)\), '
                r'w: Vector3\.create\(([^)]*)\), h: Vector3\.create\(([^)]*)\) \}', m.group(2)):
            c, u, w, h = [tuple(float(x) for x in g.split(',')) for g in bm.groups()]
            boxes.append((c, u, w, h))
        kfs.append((t, boxes))
    return {'duration': dur, 'below': below, 'cause': cause, 'keyframes': kfs,
            'shrink': shrink}


# ── vector helpers ─────────────────────────────────────────────────────────
def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def norm(a):
    n = math.sqrt(dot(a, a)) or 1.0
    return (a[0] / n, a[1] / n, a[2] / n)


def qrot(q, v):
    x, y, z, w = q
    t = (2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0]))
    return (v[0] + w * t[0] + (y * t[2] - z * t[1]),
            v[1] + w * t[1] + (z * t[0] - x * t[2]),
            v[2] + w * t[2] + (x * t[1] - y * t[0]))


# ── swingTraps.ts, reimplemented ───────────────────────────────────────────
def boxes_at(model, t):
    kf = model['keyframes']
    if t <= kf[0][0]:
        return kf[0][1]
    if t >= kf[-1][0]:
        return kf[-1][1]
    i = 0
    while i < len(kf) - 2 and kf[i + 1][0] < t:
        i += 1
    ta, ba = kf[i]
    tb, bb = kf[i + 1]
    u = (t - ta) / ((tb - ta) or 1.0)
    out = []
    for k in range(len(ba)):
        A, B = ba[k], bb[k] if k < len(bb) else ba[k]
        out.append(tuple(tuple(A[j][d] + (B[j][d] - A[j][d]) * u for d in range(3)) for j in range(4)))
    return out


def to_world(unit, box, shrink=1.0):
    c, u, w, h = box
    pos, rot, scl, esc = unit
    cw = tuple(pos[k] + qrot(rot, tuple(c[j] * scl[j] for j in range(3)))[k] for k in range(3))
    return (cw, qrot(rot, u), qrot(rot, w), tuple(x * esc * shrink for x in h))


def oriented_box_hits(cw, uu, ww, hh, feet, margin):
    u = norm(uu)
    w = norm(tuple(ww[k] - u[k] * dot(u, ww) for k in range(3)))
    n = cross(u, w)
    d0 = tuple(feet[k] - cw[k] for k in range(3))
    d1 = (d0[0], d0[1] + PLAYER_HEIGHT, d0[2])
    a = (dot(d0, u), dot(d0, w), dot(d0, n))
    b = (dot(d1, u), dot(d1, w), dot(d1, n))

    def dist_at(t):
        s = 0.0
        for k in range(3):
            e = abs(a[k] + (b[k] - a[k]) * t) - hh[k]
            if e > 0:
                s += e * e
        return math.sqrt(s)

    lo, hi = 0.0, 1.0
    for _ in range(14):
        m1 = lo + (hi - lo) / 3
        m2 = hi - (hi - lo) / 3
        if dist_at(m1) <= dist_at(m2):
            hi = m2
        else:
            lo = m1
    return dist_at((lo + hi) / 2) <= PLAYER_RADIUS + margin


def box_lowest_y(cw, u, w, h):
    n = cross(u, w)
    return cw[1] - (abs(u[1]) * h[0] + abs(w[1]) * h[1] + abs(n[1]) * h[2])


def touches_at(unit, model, t, feet, bridge=True):
    for box in boxes_at(model, t):
        b = to_world(unit, box, model['shrink'])
        if bridge and model['below'] and box_lowest_y(*b) <= feet[1] + 0.3:
            continue
        if oriented_box_hits(b[0], b[1], b[2], b[3], feet, TOUCH_MARGIN):
            return True
    return False


def touching(unit, model, elapsed, feet, bridge=True):
    """Returns the clip time that triggered, or None."""
    frm = max(0.0, elapsed - DT)
    for i in range(1, SUBSTEPS + 1):
        ti = frm + (elapsed - frm) * i / SUBSTEPS
        if touches_at(unit, model, ti, feet, bridge):
            return ti
    return None


# ── true distance from the player's capsule to the animated mesh ───────────
def capsule_to_points(pts, feet):
    """min distance from the player's vertical segment to any surface sample."""
    fx, fy, fz = feet
    top = fy + PLAYER_HEIGHT
    best = 1e9
    for p in pts:
        y = p[1]
        if y < fy:
            dy = fy - y
        elif y > top:
            dy = y - top
        else:
            dy = 0.0
        dx = p[0] - fx
        dz = p[2] - fz
        d = math.sqrt(dx * dx + dy * dy + dz * dz)
        if d < best:
            best = d
    return best


def world_mesh(sampler, unit, t):
    pos, rot, scl, _ = unit
    return [tuple(pos[k] + qrot(rot, tuple(p[j] * scl[j] for j in range(3)))[k] for k in range(3))
            for p in sampler(t)]


# ── placed units, straight out of the composite ────────────────────────────
def placed():
    d = json.load(open(os.path.join(ROOT, 'assets', 'scene', 'main.composite'), encoding='utf-8'))
    names, tf = {}, {}
    for comp in d.get('components', []):
        if comp.get('name') == 'core-schema::Name':
            for k, v in comp.get('data', {}).items():
                names[k] = v.get('json', {}).get('value')
        if comp.get('name') == 'core::Transform':
            for k, v in comp.get('data', {}).items():
                tf[k] = v.get('json', {})
    out = {}
    for k, nm in names.items():
        if nm and ('fplank' in nm or 'pblade2' in nm):
            t = tf.get(k, {})
            p = t.get('position', {})
            r = t.get('rotation', {})
            s = t.get('scale', {})
            pos = (p.get('x', 0), p.get('y', 0), p.get('z', 0))
            rot = (r.get('x', 0), r.get('y', 0), r.get('z', 0), r.get('w', 1))
            scl = (s.get('x', 1), s.get('y', 1), s.get('z', 1))
            out[nm] = (pos, rot, scl, max(abs(x) for x in scl))
    return out


UNITS = placed()
MODELS = {'fplank': ('SWING_TRAP_FPLANK', os.path.join(ROOT, 'assets', 'Models', 'fplank', 'fplank.glb'),
                     'TemplateHN.011Action.001'),
          'pblade2': ('SWING_TRAP_PBLADE', os.path.join(ROOT, 'assets', 'Models', 'pblade2', 'pblade2.glb'),
                      'pbaldeAction')}

FLOORS = [2.64, 7.65]
STEP = 0.75
REACH = 11.0
NT = 14

print('Simulating the shipped kill test against the real mesh')
print(f'  player capsule r={PLAYER_RADIUS} h={PLAYER_HEIGHT}, touch margin {TOUCH_MARGIN}, '
      f'{SUBSTEPS} sub-steps at {1/DT:.0f}fps')
print(f'  grid {STEP}m out to {REACH}m, floors {FLOORS}, {NT} times per clip\n')

for name in sorted(UNITS):
    kind = 'fplank' if 'fplank' in name else 'pblade2'
    const, path, clip = MODELS[kind]
    model = load_model(const)
    unit = UNITS[name]
    sample = None
    tested = kills = unfair = missed = bridged = 0
    worst_unfair = (0.0, None)
    unfair_ds = []
    worst_missed = (0.0, None)

    # cache the mesh surface per sampled time
    surf = {}
    sampler = G.make_surface_sampler(path, clip)

    for ti in range(NT):
        t = model['duration'] * ti / (NT - 1)
        pts_model = sampler(t)
        # place the mesh in the world exactly as the engine does
        pos, rot, scl, _ = unit
        pts = [tuple(pos[k] + qrot(rot, tuple(p[j] * scl[j] for j in range(3)))[k] for k in range(3))
               for p in pts_model]
        surf[t] = pts

        n = int(REACH / STEP)
        for fy in FLOORS:
            for ix in range(-n, n + 1):
                for iz in range(-n, n + 1):
                    feet = (pos[0] + ix * STEP, fy, pos[2] + iz * STEP)
                    tested += 1
                    hit = touching(unit, model, t, feet)
                    if hit is None:
                        continue
                    kills += 1
                    hit_pts = pts if abs(hit - t) < 1e-6 else world_mesh(sampler, unit, hit)
                    d = capsule_to_points(hit_pts, feet)
                    if d > PLAYER_RADIUS + TOUCH_MARGIN + 0.15:
                        unfair += 1
                        unfair_ds.append(d)
                        if d > worst_unfair[0]:
                            worst_unfair = (d, (round(feet[0], 2), fy, round(feet[2], 2), round(t, 2)))

    # missed kills: sample positions genuinely inside the swept mesh
    for t, pts in surf.items():
        step = max(1, len(pts) // 60)
        for p in pts[::step]:
            for fy in FLOORS:
                if not (fy - 0.5 < p[1] < fy + PLAYER_HEIGHT + 0.5):
                    continue
                feet = (p[0], fy, p[2])
                d = capsule_to_points(pts, feet)
                if d < 0.15 and touching(unit, model, t, feet) is None:
                    # A plank you can stand on is the drawbridge working, not a
                    # missed kill. Only count it if the shape missed the player
                    # even with that rule switched off.
                    if touching(unit, model, t, feet, bridge=False) is not None:
                        bridged += 1
                        continue
                    missed += 1
                    if (0.4 - d) > worst_missed[0]:
                        worst_missed = (0.4 - d, (round(p[0], 2), fy, round(p[2], 2), round(t, 2)))

    print(f'{name:16s} {model["cause"]}')
    TOTALS[name] = (unfair, missed)
    print(f'  {tested} position-times tested, {kills} kills')
    if kills:
        print(f'  UNFAIR (model >0.6m away): {unfair}  ({100*unfair/kills:.1f}% of kills)'
              + (f'   median {sorted(unfair_ds)[len(unfair_ds)//2]:.2f}m  worst {worst_unfair[0]:.2f}m at {worst_unfair[1]}' if unfair_ds else ''))
    else:
        print('  UNFAIR: n/a — nothing in reach at any tested position')
    print(f'  bridge rule suppressed (by design, plank only): {bridged}')
    print(f'  MISSED (mesh through the player, no kill): {missed}'
          + (f'   worst {worst_missed[0]:.2f}m at {worst_missed[1]}' if worst_missed[1] else ''))
    print()


# ── REGRESSION GATE ────────────────────────────────────────────────────────
# This tool used to only PRINT. A number nobody reads is not a check, and this
# project shipped three separate "fair" traps that were killing people. Exit
# non-zero so a bad bake cannot pass quietly.
#
# UNFAIR = the kill volume reached a player the visible mesh never touched.
# MISSED = the mesh passed through a player with no kill. Both are failures;
# MISSED especially, because the obvious "fix" for unfair kills is to shrink
# the boxes until they stop touching anyone.
_fail = []
for _n, (_u, _m) in TOTALS.items():
    if _u > ALLOWED_UNFAIR:
        _fail.append('%s: %d unfair kills (allowed %d)' % (_n, _u, ALLOWED_UNFAIR))
    if _m > 0:
        _fail.append('%s: %d MISSED kills' % (_n, _m))
if _fail:
    print()
    print('FAIL - fairness regression:')
    for _f in _fail:
        print('   ' + _f)
    sys.exit(1)
print()
print('PASS - every swing trap is within the fairness budget '
      '(<=%d unfair, 0 missed).' % ALLOWED_UNFAIR)
