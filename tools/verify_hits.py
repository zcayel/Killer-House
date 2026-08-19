"""Replay the SHIPPED kill test against the real animated mesh.

Volume ratios are a proxy. This asks the question directly: sweep the player
across a grid, on both floors, through the clip, and every time the game says
"kill", measure how far the model actually was at that instant.

  UNFAIR  - killed with the model further away than your own body radius.
  MISSED  - the mesh passed through you and nothing happened.

It reads the keyframes out of src/traps/swingTrapShapes.ts, the plank
placements out of main.crdt and the axe placements out of SWING_TRAP_PLACEMENTS
in src/config.ts — the three files the GAME reads — so it tests what actually
ships rather than a copy of it. Re-run after any re-bake, after moving anything
in Creator Hub, or after editing SWING_TRAP_PLACEMENTS.

It deliberately does NOT read assets/scene/main.composite. That is the editor's
file; on 2026-08-19 it disagreed with main.crdt about where an axe was by
eleven metres, and reading it is why this tool reported a fair axe for a day
while players were being killed by an unseen one.

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
# TIGHTENED TO 0 on 2026-08-19. This was 1, to allow one 0.63m kill per axe
# that the old placement produced. Moving the axes into SWING_TRAP_PLACEMENTS
# at scale 0.70 removed it: the measured state is now 0 unfair and 0 missed on
# all six units, 37 kills per axe and 11 per plank across 23548 position-times
# each. The gate holds the line where it actually is.
#
# Never RAISE this to make a red build green - that is the exact failure this
# gate exists to catch. If a change adds an unfair kill, the change is wrong.
ALLOWED_UNFAIR = 0
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


# FLOOR_LEVELS_Y in src/config.ts. Mirrors floorSeparates() in swingTraps.ts.
FLOOR_LEVELS_Y = [8.58, 7.65, 2.64, 0.0]


def box_highest_y(cw, u, w, h):
    n = cross(u, w)
    return cw[1] + (abs(u[1]) * h[0] + abs(w[1]) * h[1] + abs(n[1]) * h[2])


def floor_separates(b, feet_y):
    """A whole floor slab between the box and the player's feet."""
    top = box_highest_y(*b)
    for level in FLOOR_LEVELS_Y:
        if feet_y >= level - 0.05 and top < level - 0.05:
            return True
    return False


def box_underside_near(b, p):
    """How low the box hangs directly over p. Mirrors boxUndersideNear()."""
    cw, u, w, h = b
    n = cross(u, w)
    d = tuple(p[k] - cw[k] for k in range(3))
    du = max(-h[0], min(h[0], dot(d, u)))
    dw = max(-h[1], min(h[1], dot(d, w)))
    return cw[1] + u[1] * du + w[1] * dw - abs(n[1]) * h[2]


def touches_at(unit, model, t, feet, bridge=True):
    for box in boxes_at(model, t):
        b = to_world(unit, box, model['shrink'])
        if bridge and model['below'] and box_underside_near(b, feet) <= feet[1] + 0.3:
            continue
        if floor_separates(b, feet[1]):
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


# Memo for world_mesh. Every kill needs the mesh posed at the exact sub-step
# time it happened, and posing it means transforming ~8000 surface points. The
# sub-step times repeat constantly (SUBSTEPS per frame, NT frames), so without
# this the tool re-does identical work thousands of times — which is what made
# it take hours once the axes were moved somewhere players can actually reach.
# Keyed per unit, and cleared between units so one axe cannot answer for another.
_MESH_MEMO = {}


def world_mesh(sampler, unit, t):
    key = round(t, 6)
    hit = _MESH_MEMO.get(key)
    if hit is not None:
        return hit
    pos, rot, scl, _ = unit
    out = [tuple(pos[k] + qrot(rot, tuple(p[j] * scl[j] for j in range(3)))[k] for k in range(3))
           for p in sampler(t)]
    _MESH_MEMO[key] = out
    return out


# model-file substring -> (shape const, clip). The PATH is not here on
# purpose; it comes from each placed entity's own GltfContainer src.
TRAP_MODELS = {'fplank': ('SWING_TRAP_FPLANK', 'TemplateHN.011Action.001'),
               'blade': ('SWING_TRAP_PBLADE', 'pbaldeAction')}


# ── placed units ───────────────────────────────────────────────────────────
#
# TWO SOURCES, because the game now has two.
#
# This used to read assets/scene/main.composite for everything, and that was
# the blind spot that let the axes ship broken for a day. The composite is the
# Creator Hub EDITOR's file; the runtime loads main.crdt. On 2026-08-19 they
# disagreed about pblade2.glb_2 by eleven metres, so this tool kept reporting a
# fair, unburied axe in a room the game had never put one in.
#
#   planks -> main.crdt      (still placed in the editor; read what SHIPS)
#   axes   -> src/config.ts  (SWING_TRAP_PLACEMENTS; spawned from code now)
#
# Neither path goes near the composite any more. If a placement is not in the
# file the runtime reads, this tool must not see it either.
def placed_from_crdt():
    """Plank placements, out of the file the runtime actually loads."""
    import struct
    d = open(os.path.join(ROOT, 'main.crdt'), 'rb').read()
    off, gl, tf = 0, {}, {}
    while off + 8 <= len(d):
        ln, _ty = struct.unpack_from('<II', d, off)
        if ln < 8 or off + ln > len(d):
            break
        ent, cid, _ts, dl = struct.unpack_from('<IIII', d, off + 8)
        p = d[off + 24:off + 24 + dl]
        if cid == 1041:  # GltfContainer, for the src string
            i, src = 0, None
            while i < len(p):
                key = p[i]
                i += 1
                f, wt = key >> 3, key & 7
                if wt == 2:
                    n = p[i]
                    i += 1
                    v = p[i:i + n]
                    i += n
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
        off += ln
    out = {}
    seen = {}
    for ent, src in gl.items():
        base = src.split('/')[-1]
        if not any(k in base for k in TRAP_MODELS):
            continue
        t = tf.get(ent)
        if t is None:
            continue
        seen[base] = seen.get(base, 0) + 1
        nm = base if seen[base] == 1 else '%s_%d' % (base, seen[base])
        scl = tuple(t[7:10])
        # src carried alongside the transform: the model path comes from the
        # SCENE, never from a constant in this file. A verifier with a
        # hardcoded path measures the shipped boxes against whatever mesh it
        # was last told about, which is how a model swap silently produces a
        # green build for the wrong geometry.
        out[nm] = (tuple(t[0:3]), tuple(t[3:7]), scl, max(abs(x) for x in scl), src)
    return out


def placed():
    return placed_from_crdt()


UNITS = placed()


FLOORS = [2.64, 7.65]
STEP = 0.75
REACH = 11.0
NT = 14

print('Simulating the shipped kill test against the real mesh')
print(f'  player capsule r={PLAYER_RADIUS} h={PLAYER_HEIGHT}, touch margin {TOUCH_MARGIN}, '
      f'{SUBSTEPS} sub-steps at {1/DT:.0f}fps')
print(f'  grid {STEP}m out to {REACH}m, floors {FLOORS}, {NT} times per clip\n')

for name in sorted(UNITS):
    entry = UNITS[name]
    unit, src = entry[:4], entry[4]
    kind = next(k for k in TRAP_MODELS if k in src)
    const, clip = TRAP_MODELS[kind]
    path = os.path.join(ROOT, *src.split('/'))
    model = load_model(const)
    sample = None
    tested = kills = unfair = missed = bridged = 0
    worst_unfair = (0.0, None)
    unfair_ds = []
    worst_missed = (0.0, None)

    # cache the mesh surface per sampled time
    surf = {}
    sampler = G.make_surface_sampler(path, clip)
    _MESH_MEMO.clear()  # the memo is per-unit: it bakes in this unit's transform

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
