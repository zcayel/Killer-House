"""Verify the VICTORY CINEMATIC actually frames what it claims to frame.

WHY THIS EXISTS. src/effects/victoryCinematic.ts stages the one composed shot
in this scene - the escapee on a heap of skulls in front of the leaderboard -
and every number that makes it work is a number somebody can nudge without
seeing the result. Moving VICTORY_STAGE_POSITION half a metre, or the board in
Creator Hub, or a keyframe's dist, changes a picture nobody looks at until a
player wins. Nothing throws when it goes wrong; the shot is just bad.

So this rebuilds the whole thing from the files the GAME reads and measures it:

  * the board, out of main.crdt - the file the runtime loads. NOT
    assets/scene/main.composite, which is the editor's copy and has disagreed
    with main.crdt by eleven metres before now (see verify_hits.py).
  * the pile, by re-running victoryCinematic.ts's own layout - the same
    mulberry32 with the same seed, so this is the heap that ships, not a model
    of it.
  * the shot, out of VICTORY_SHOT in config.ts, projected through a pinhole
    camera at 16:9.

and then asserts the things the shot is FOR:

  1. the hero is on the leaderboard's face side, in front of it, not beside it
  2. at the wide keyframe the whole board is inside the frame
  3. the avatar is never smaller than MIN_AVATAR_FRACTION of frame height
  4. the board is visible in every keyframe after the opening
  5. the pile's summit meets the avatar's feet - no hovering, no burial
  6. the pile does not intersect anything placed nearby in main.crdt
  7. nothing placed in main.crdt sits on the camera's line to the hero
  8. the hero is on the board's DRAWN centre line, not just in front of it
  9. the two flanking headstones clear the heap and stay inside the frame
 10. no placed model's own volume swallows a camera keyframe unless the shot
     strikes it - the check that was missing when the camera spent most of the
     arc sat INSIDE KHN.glb, filming the hero through an exterior wall

The layout is re-implemented here rather than executed, because running the
real thing would mean standing up the SDK and a renderer. That duplication is
the one weakness of this tool, and it is contained two ways: every constant is
READ OUT of config.ts rather than retyped, so the numbers cannot drift; and the
PRNG port is checked against node (see rng_js), so the scatter cannot either.
Only the twenty lines of placement arithmetic are copied, and they are the part
that changes least.

    python tools/verify_victory_shot.py

Exit 1 on any failure.
"""
import json
import math
import os
import re
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The avatar the shot is composed around. DCL avatars are ~1.85m; the width is
# only used to keep the hero clear of the pile's own summit skulls.
AVATAR_HEIGHT = 1.85
# Below this the hero is a smudge and the shot is a photo of a leaderboard.
MIN_AVATAR_FRACTION = 0.20
ASPECT = 16 / 9


def fail(msg):
    print('FAIL  ' + msg)
    fail.count += 1


fail.count = 0


def ok(msg):
    print('ok    ' + msg)


# ── config.ts ───────────────────────────────────────────────────────────────
CFG = open(os.path.join(ROOT, 'src', 'config.ts'), encoding='utf-8').read()


def num(name):
    m = re.search(r'export const %s\s*=\s*(-?[\d.]+)' % name, CFG)
    if not m:
        sys.exit('missing constant %s in config.ts' % name)
    return float(m.group(1))


def vec3(name):
    m = re.search(r'export const %s\s*=\s*Vector3\.create\(([^)]*)\)' % name, CFG)
    if not m:
        sys.exit('missing Vector3 %s in config.ts' % name)
    return tuple(float(v) for v in m.group(1).split(','))


def shot():
    m = re.search(r'export const VICTORY_SHOT[^=]*=\s*\[(.*?)\n\]', CFG, re.S)
    if not m:
        sys.exit('missing VICTORY_SHOT in config.ts')
    keys = []
    for row in re.finditer(r'\{([^}]*)\}', m.group(1)):
        d = {}
        for k, v in re.findall(r'(\w+)\s*:\s*(-?[\d.]+)', row.group(1)):
            d[k] = float(v)
        keys.append(d)
    if not keys:
        sys.exit('VICTORY_SHOT parsed empty')
    return keys


STAGE = vec3('VICTORY_STAGE_POSITION')
PILE_R = num('VICTORY_PILE_RADIUS')
PILE_H = num('VICTORY_PILE_HEIGHT')
FALLOFF = num('VICTORY_PILE_FALLOFF')
N_SKULLS = int(num('VICTORY_PILE_SKULLS'))
CLEAR_R = num('VICTORY_PILE_CLEAR_RADIUS')
S_MIN = num('VICTORY_SKULL_SCALE_MIN')
S_MAX = num('VICTORY_SKULL_SCALE_MAX')
SINK = num('VICTORY_SKULL_SINK')
SPREAD = num('VICTORY_PILE_SPREAD')
FACE_JITTER = num('VICTORY_SKULL_FACE_JITTER')
STAND = num('VICTORY_STAND_HEIGHT')
STAND_R = num('VICTORY_STAND_RADIUS')
CLEAR_RADIUS = num('VICTORY_SET_CLEAR_RADIUS')
FACE_T = num('VICTORY_AVATAR_FACE_T')
GRAVE_SCALE = num('VICTORY_GRAVE_SCALE')
SHOT = shot()


def vec3_list(name):
    m = re.search(r'export const %s\s*=\s*\[(.*?)\n\]' % name, CFG, re.S)
    if not m:
        sys.exit('missing %s in config.ts' % name)
    return [tuple(float(v) for v in row.split(','))
            for row in re.findall(r'Vector3\.create\(([^)]*)\)', m.group(1))]


def str_list(name):
    m = re.search(r"export const %s\s*=\s*\[([^\]]*)\]" % name, CFG, re.S)
    if not m:
        sys.exit('missing %s in config.ts' % name)
    return re.findall(r"'([^']*)'", m.group(1))


CLEAR_MATCH = str_list('VICTORY_SET_CLEAR_MATCH')
CLEAR_ALWAYS = str_list('VICTORY_SET_CLEAR_ALWAYS')
GRAVE_OFFSETS = vec3_list('VICTORY_GRAVE_OFFSETS')
# HWN20_Grave_31.glb, measured off the GLB. Half-width is what the clearance
# checks below care about; the height is what has to stay under the board.
GRAVE_HALF_W = 0.42
GRAVE_H = 1.05

# Model heights, measured off the GLBs themselves (see tools/glbkit.py). Both
# have their origin at the base, so height above the placement point IS this.
SKULL_H = {
    'BonesSkull_01.glb': 0.454,
    'HWN20_Skull_01.glb': 0.247
}
SKULL_TRIS = {
    'BonesSkull_01.glb': 196,
    'HWN20_Skull_01.glb': 456
}
# Widest horizontal span, for the coverage sum below.
SKULL_W = {
    'BonesSkull_01.glb': 0.586,
    'HWN20_Skull_01.glb': 0.323
}
# One parcel's worth. The scene has sixteen, but a set piece that stands for
# fifteen seconds has no business spending a large share of the whole budget.
MAX_PILE_TRIS = 10000 * 2
MODELS = re.findall(r"'([^']*\.glb)'", re.search(
    r'export const VICTORY_SKULL_MODELS\s*=\s*\[(.*?)\]', CFG, re.S).group(1))


# ── the pile, exactly as victoryCinematic.ts builds it ──────────────────────
def u32(x):
    return x & 0xFFFFFFFF


def i32(x):
    x &= 0xFFFFFFFF
    return x - 0x100000000 if x & 0x80000000 else x


def imul(a, b):
    """JS Math.imul - wrap to 32 bits and read the result as signed."""
    return i32(u32(a) * u32(b))


def rng_js(seed):
    """mulberry32, ported operator for operator from victoryCinematic.ts.

    The pedantry is the point. JS's >>> is an unsigned shift, ^ and | coerce
    through ToInt32, and the `t + Math.imul(...)` in the middle is a FLOAT add
    that is only truncated by the ^ after it. Python has none of those edges, so
    every one of them is written out; get any of them wrong and this tool
    measures a heap of skulls the game will never build.

    Checked against node, which is what settles it. Seeded 20260828 - the seed
    the scene actually uses - the first six draws out of both are
    0.45197 0.68111 0.21312 0.97055 0.96153 0.80991.
    """
    a = u32(seed)

    def rnd():
        nonlocal a
        a = u32(a + 0x6D2B79F5)
        t = imul(i32(u32(a) ^ (u32(a) >> 15)), i32(u32(a) | 1))
        t = i32(u32(int(t + imul(i32(u32(t) ^ (u32(t) >> 7)), i32(u32(t) | 61)))) ^ u32(t))
        return u32(u32(t) ^ (u32(t) >> 14)) / 4294967296.0

    return rnd


def dcl_quat(x, y, z):
    """Quaternion.fromEulerDegrees(x, y, z), ported from @dcl/ecs-math.

    It is a YAW-PITCH-ROLL composition (y then x then z), not the XYZ order most
    tools default to, and the difference is large once any two of the three are
    non-trivial. Anything that wants to reproduce a skull's real orientation -
    a block-out render, say - has to go through this rather than hand three
    euler numbers to a program that will compose them its own way.
    """
    hp, hy, hr = math.radians(x) / 2, math.radians(y) / 2, math.radians(z) / 2
    c1, c2, c3 = math.cos(hp), math.cos(hy), math.cos(hr)
    s1, s2, s3 = math.sin(hp), math.sin(hy), math.sin(hr)
    return (c2 * s1 * c3 + s2 * c1 * s3,
            s2 * c1 * c3 - c2 * s1 * s3,
            c2 * c1 * s3 - s2 * s1 * c3,
            c2 * c1 * c3 + s2 * s1 * s3)


def cone_height(r):
    u = min(1.0, r / PILE_R)
    return PILE_H * (1 - u ** FALLOFF)


def build_pile():
    rnd = rng_js(20260828)
    out = []
    for _ in range(N_SKULLS):
        ang = rnd() * math.pi * 2
        r = CLEAR_R + (rnd() ** SPREAD) * (PILE_R - CLEAR_R)
        scale = S_MIN + rnd() * (S_MAX - S_MIN)
        y = cone_height(r) - SINK * scale * 0.45
        outward = math.degrees(math.atan2(math.cos(ang), math.sin(ang)))
        pitch = -32 + rnd() * 64
        yaw = outward + (rnd() * 2 - 1) * FACE_JITTER
        roll = -26 + rnd() * 52
        model = MODELS[int(rnd() * len(MODELS))]
        out.append({
            'x': STAGE[0] + math.cos(ang) * r,
            'z': STAGE[2] + math.sin(ang) * r,
            'y': y, 'r': r, 'scale': scale,
            'crown': y + SKULL_H[model.split('/')[-1]] * scale,
            'tris': SKULL_TRIS[model.split('/')[-1]],
            'euler': (pitch, yaw, roll),
            'quat': dcl_quat(pitch, yaw, roll),
            'model': model.split('/')[-1]
        })
    return out


# ── the board, out of main.crdt ─────────────────────────────────────────────
def board_from_crdt():
    d = open(os.path.join(ROOT, 'main.crdt'), 'rb').read()
    off, gl, tf = 0, {}, {}
    while off + 8 <= len(d):
        ln, _ty = struct.unpack_from('<II', d, off)
        if ln < 8 or off + ln > len(d):
            break
        ent, cid, _ts, dl = struct.unpack_from('<IIII', d, off + 8)
        p = d[off + 24:off + 24 + dl]
        if cid == 1041:
            i, src = 0, None
            while i < len(p):
                key = p[i]; i += 1
                f, wt = key >> 3, key & 7
                if wt == 2:
                    n = p[i]; i += 1
                    v = p[i:i + n]; i += n
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
        elif cid == 1 and len(p) >= 44:
            tf[ent] = struct.unpack_from('<10fI', p, 0)
        off += ln
    return gl, tf


GL, TF = board_from_crdt()
BOARD_ENT = next((e for e, s in GL.items() if 'leadboard' in s.lower()), None)
if BOARD_ENT is None or BOARD_ENT not in TF:
    sys.exit('leadboard.glb not found in main.crdt - the board has been renamed or removed')
BT = TF[BOARD_ENT]
BPOS = BT[0:3]
BQ = BT[3:7]
BSCALE = BT[7:10]

# The art quad's own footprint in the anchor's local space, kept in step with
# leaderboard.ts's FACE_* constants (which is what the board is drawn onto).
LB = open(os.path.join(ROOT, 'src', 'leaderboard.ts'), encoding='utf-8').read()


def face(name):
    m = re.search(r'const %s\s*=\s*(-?[\d.]+)' % name, LB)
    if not m:
        sys.exit('missing %s in leaderboard.ts' % name)
    return float(m.group(1))


FX = (face('FACE_MIN_X'), face('FACE_MAX_X'))
FY = (face('FACE_MIN_Y'), face('FACE_MAX_Y'))


def qrot(q, v):
    x, y, z, w = q
    vx, vy, vz = v
    tx = 2 * (y * vz - z * vy)
    ty = 2 * (z * vx - x * vz)
    tz = 2 * (x * vy - y * vx)
    return (vx + w * tx + (y * tz - z * ty),
            vy + w * ty + (z * tx - x * tz),
            vz + w * tz + (x * ty - y * tx))


def board_pt(lx, ly, lz=0.0):
    v = qrot(BQ, (lx * BSCALE[0], ly * BSCALE[1], lz * BSCALE[2]))
    return (BPOS[0] + v[0], BPOS[1] + v[1], BPOS[2] + v[2])


CORNERS = [board_pt(x, y) for x in FX for y in FY]
BOARD_NORMAL = qrot(BQ, (0.0, 0.0, -1.0))   # the face looks down local -Z


# ── projection ──────────────────────────────────────────────────────────────
def projector(cam, aim, fov_v):
    fwd = [aim[i] - cam[i] for i in range(3)]
    L = math.sqrt(sum(v * v for v in fwd))
    fwd = [v / L for v in fwd]
    # right = forward x world-up, with world-up = (0, 1, 0)
    right = [-fwd[2], 0.0, fwd[0]]
    rl = math.sqrt(sum(v * v for v in right))
    right = [v / rl for v in right]
    up = [right[1] * fwd[2] - right[2] * fwd[1],
          right[2] * fwd[0] - right[0] * fwd[2],
          right[0] * fwd[1] - right[1] * fwd[0]]
    ty = math.tan(math.radians(fov_v) / 2)
    tx = ty * ASPECT

    def P(p):
        d = [p[i] - cam[i] for i in range(3)]
        z = sum(d[i] * fwd[i] for i in range(3))
        if z <= 0.01:
            return None
        return (sum(d[i] * right[i] for i in range(3)) / z / tx,
                sum(d[i] * up[i] for i in range(3)) / z / ty, z)

    return P


def cam_for(key):
    phi = math.radians(key['phi'])
    return ((STAGE[0] + math.cos(phi) * key['dist'], key['camY'], STAGE[2] + math.sin(phi) * key['dist']),
            (STAGE[0], key['aimY'], STAGE[2]))


# ── checks ──────────────────────────────────────────────────────────────────
print('leadboard.glb  pos %.3f %.3f %.3f  scale %.3f %.3f %.3f' % (BPOS + BSCALE))
bw = math.dist(board_pt(FX[0], 0), board_pt(FX[1], 0))
bh = math.dist(board_pt(0, FY[0]), board_pt(0, FY[1]))
print('board face     %.2fm wide x %.2fm tall, normal (%.2f, %.2f, %.2f)' % ((bw, bh) + BOARD_NORMAL))
print('stage          %.2f %.2f %.2f   pile r%.2f h%.2f  %d skulls' % (STAGE + (PILE_R, PILE_H, N_SKULLS)))
print()

# 1. in FRONT of the board, on the face side, and looking at it.
to_stage = (STAGE[0] - BPOS[0], 0.0, STAGE[2] - BPOS[2])
dist_face = to_stage[0] * BOARD_NORMAL[0] + to_stage[2] * BOARD_NORMAL[2]
if dist_face <= 0:
    fail('the stage is BEHIND the board face (%.2fm) - the hero would be stood round the back' % dist_face)
elif dist_face < 2.0:
    fail('the stage is only %.2fm off the board face - the hero is against the plate' % dist_face)
else:
    ok('stage sits %.2fm out in front of the board face' % dist_face)

# 2/3/4. the shot itself.
for k in SHOT:
    cam, aim = cam_for(k)
    P = projector(cam, aim, k['fov'])
    pts = [P(c) for c in CORNERS]
    seen = [p for p in pts if p]
    feet = P((STAGE[0], STAND, STAGE[2]))
    head = P((STAGE[0], STAND + AVATAR_HEIGHT, STAGE[2]))
    tag = 't=%.2f' % k['t']

    if feet is None or head is None:
        fail('%s the hero is behind the camera' % tag)
        continue
    frac = (head[1] - feet[1]) / 2.0
    if frac < MIN_AVATAR_FRACTION:
        fail('%s avatar fills only %.0f%% of frame height (min %.0f%%)' % (tag, frac * 100, MIN_AVATAR_FRACTION * 100))
    else:
        ok('%s avatar fills %.0f%% of frame height' % (tag, frac * 100))

    if len(seen) < 4:
        fail('%s part of the board is behind the camera' % tag)
        continue
    bx = (min(p[0] for p in seen), max(p[0] for p in seen))
    by = (min(p[1] for p in seen), max(p[1] for p in seen))
    onscreen = bx[1] > -1 and bx[0] < 1 and by[1] > -1 and by[0] < 1
    if not onscreen:
        fail('%s the board is entirely outside the frame' % tag)
    elif k is SHOT[-1]:
        if bx[0] < -1 or bx[1] > 1 or by[0] < -1 or by[1] > 1:
            fail('THE WIDE SHOT CROPS THE BOARD: x %.2f..%.2f  y %.2f..%.2f (frame is -1..1)'
                 % (bx + by))
        else:
            ok('t=1.00 the whole board is in frame: x %.2f..%.2f  y %.2f..%.2f' % (bx + by))
    else:
        ok('%s board on screen: x %.2f..%.2f  y %.2f..%.2f' % ((tag,) + bx + by))

print()

# 5. the summit meets the feet.
pile = build_pile()
crowns = sorted(pile, key=lambda s: -s['crown'])
top = crowns[0]['crown']
near = [s for s in pile if s['r'] < 0.75]
near_top = max(s['crown'] for s in near) if near else 0.0
if len(near) < 4:
    fail('only %d skulls within 0.75m of the summit - the crown is bare and the hero is stood'
         ' on an invisible plinth with a fringe of skulls round the bottom. Raise'
         ' VICTORY_PILE_SPREAD.' % len(near))
elif near_top < STAND - 0.25:
    fail('summit skulls only reach %.2fm and the feet are at %.2f - the hero hovers' % (near_top, STAND))
elif near_top > STAND + 0.55:
    fail('summit skulls reach %.2fm against feet at %.2f - the hero is buried to the knee' % (near_top, STAND))
else:
    ok('summit skulls reach %.2fm, feet at %.2f - ankle deep' % (near_top, STAND))
print('      tallest skull anywhere %.2fm, %d skulls inside 0.75m of the summit' % (top, len(near)))

reach = max(math.hypot(s['x'] - STAGE[0], s['z'] - STAGE[2]) for s in pile)
if reach > PILE_R + 0.01:
    fail('a skull sits %.2fm out, past VICTORY_PILE_RADIUS %.2f' % (reach, PILE_R))
else:
    ok('the heap stays inside its %.2fm radius (widest skull %.2fm out)' % (PILE_R, reach))

bands = [0] * 4
for s in pile:
    bands[min(3, int(s['y'] / (PILE_H / 4)) if s['y'] > 0 else 0)] += 1
print('      skulls per quarter of the cone, base to summit: %s' % bands)

# HOW MUCH OF THE MOUND IS ACTUALLY SKULL. The first version of this heap
# passed every other check in this file and still looked wrong: 54 skulls over a
# 2.2m radius covered 39% of the cone and read as scattered debris. Coverage is
# the number that catches that, and it is the reason the radius is 1.5.
slant = math.pi * PILE_R * math.hypot(PILE_R, PILE_H)
footprint = sum(math.pi * (SKULL_W[s['model']] * s['scale'] / 2) ** 2 for s in pile)
cover = footprint / slant
if cover < 0.65:
    fail('the heap covers only %.0f%% of its own cone - that is scattered skulls, not a pile.'
         ' Tighten VICTORY_PILE_RADIUS or raise VICTORY_PILE_SKULLS.' % (cover * 100))
elif cover > 1.6:
    fail('the heap covers %.0f%% of its own cone - so densely packed it will read as one lump'
         % (cover * 100))
else:
    ok('the heap covers %.0f%% of its own cone' % (cover * 100))

# The standing cap must not stick out past the mound it is pretending to be.
if STAND_R > PILE_R * 0.6:
    fail('the standing cap is %.2fm across a %.2fm heap - there is invisible standable air'
         ' out past the skulls' % (STAND_R, PILE_R))
else:
    ok('the %.2fm standing cap sits well inside the %.2fm heap' % (STAND_R, PILE_R))

tris = sum(s['tris'] for s in pile)
if tris > MAX_PILE_TRIS:
    fail('the heap is %d triangles, over the %d budget' % (tris, MAX_PILE_TRIS))
else:
    ok('the heap costs %d triangles of a %d budget' % (tris, MAX_PILE_TRIS))
if bands[0] < bands[3]:
    fail('the heap is top-heavy (%d at the base, %d at the summit) - that is a tower, not a pile' % (bands[0], bands[3]))
else:
    ok('the heap is bottom-heavy, as a heap is')

print()

# 6. nothing placed in the scene is inside the pile.
clashes = []
for ent, src in GL.items():
    if ent not in TF or ent == BOARD_ENT:
        continue
    t = TF[ent]
    if t[10] != 0:      # parented - its transform is not world space
        continue
    d = math.hypot(t[0] - STAGE[0], t[2] - STAGE[2])
    if d < PILE_R + 0.6:
        clashes.append((d, src.split('/')[-1], t[0], t[1], t[2]))
if clashes:
    for d, name, x, y, z in sorted(clashes):
        fail('%s is placed %.2fm from the stage centre, inside the heap (%.2f %.2f %.2f)' % (name, d, x, y, z))
else:
    ok('no placed entity in main.crdt falls inside the heap')
    nearest = sorted(
        (math.hypot(TF[e][0] - STAGE[0], TF[e][2] - STAGE[2]), s.split('/')[-1])
        for e, s in GL.items() if e in TF and TF[e][10] == 0 and e != BOARD_ENT)[:3]
    for d, name in nearest:
        print('      nearest: %-34s %.2fm' % (name, d))

# 7. clear line of sight, at every keyframe.
#
# The framing checks above all assume the camera can SEE what they measure. A
# grave, a pillar or a fence panel parked on the sightline puts a silhouette
# across the hero and none of the numbers would notice. This is a proximity
# test against the camera-to-hero segment rather than a real occlusion trace -
# it cannot know how big each prop is, so it flags anything close enough to be
# a candidate and leaves the judgement written down here.
SIGHT_CLEARANCE = 1.2


def seg_dist(p, a, b):
    ab = [b[i] - a[i] for i in range(3)]
    ap = [p[i] - a[i] for i in range(3)]
    L2 = sum(v * v for v in ab)
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, sum(ap[i] * ab[i] for i in range(3)) / L2))
    q = [a[i] + ab[i] * t for i in range(3)]
    return math.dist(p, q)


blockers = set()
for k in SHOT:
    cam, _aim = cam_for(k)
    hero = (STAGE[0], STAND + AVATAR_HEIGHT * 0.5, STAGE[2])
    for ent, src in GL.items():
        if ent not in TF or ent == BOARD_ENT:
            continue
        t = TF[ent]
        if t[10] != 0:
            continue
        d = seg_dist((t[0], t[1], t[2]), cam, hero)
        if d < SIGHT_CLEARANCE:
            blockers.add((round(d, 2), src.split('/')[-1], 't=%.2f' % k['t']))
if blockers:
    for d, name, tag in sorted(blockers):
        fail('%s sits %.2fm off the camera-to-hero line at %s - it may cut across the shot' % (name, d, tag))
else:
    ok('the camera has a clear line to the hero at every keyframe')

print()

# ── 8. dead centre of the board, not merely in front of it ─────────────────
# The DRAWN centre line, which is not the anchor's. leaderboard.ts shifts the
# whole board sideways by BOARD_SHIFT_METRES (world metres, divided by the
# anchor's scale at build time), and the art quad is not centred on the anchor
# either - its local x runs -2.041..2.346. Checking against BPOS instead of this
# would pass a hero standing 0.6m off to one side of the plate they are meant to
# be posing in front of.
SHIFT = face('BOARD_SHIFT_METRES')
CENTRE_LX = (FX[0] + FX[1]) / 2 + SHIFT / BSCALE[0]
DRAWN_CENTRE = board_pt(CENTRE_LX, (FY[0] + FY[1]) / 2)
WIDTH_AXIS = qrot(BQ, (1.0, 0.0, 0.0))

def lateral(px, pz):
    """Signed metres along the board's own width axis from its drawn centre."""
    return (px - DRAWN_CENTRE[0]) * WIDTH_AXIS[0] + (pz - DRAWN_CENTRE[2]) * WIDTH_AXIS[2]


off_centre = lateral(STAGE[0], STAGE[2])
if abs(off_centre) > 0.25:
    fail('the heap sits %.2fm off the board\'s drawn centre line (drawn centre z=%.3f, not the anchor\'s %.3f)'
         % (off_centre, DRAWN_CENTRE[2], BPOS[2]))
else:
    ok('the heap is on the board\'s drawn centre line (%.2fm off, centre z=%.3f)' % (off_centre, DRAWN_CENTRE[2]))

# ── 9. the two flanking headstones ─────────────────────────────────────────
if len(GRAVE_OFFSETS) != 2:
    fail('VICTORY_GRAVE_OFFSETS has %d entries - the shot is composed for one stone either side'
         % len(GRAVE_OFFSETS))

graves = [(STAGE[0] + o[0], STAGE[1] + o[1], STAGE[2] + o[2]) for o in GRAVE_OFFSETS]
for i, g in enumerate(graves):
    d = math.hypot(g[0] - STAGE[0], g[2] - STAGE[2])
    gap = d - GRAVE_HALF_W * GRAVE_SCALE - PILE_R
    if gap < 0:
        fail('flanking stone %d overlaps the heap by %.2fm' % (i + 1, -gap))
    else:
        ok('flanking stone %d stands %.2fm out, clearing the heap by %.2fm' % (i + 1, d, gap))

if len(graves) == 2:
    la, lb = lateral(*[graves[0][j] for j in (0, 2)]), lateral(*[graves[1][j] for j in (0, 2)])
    if la * lb >= 0:
        fail('both flanking stones are on the SAME side of the hero (%.2f and %.2f)' % (la, lb))
    elif abs(abs(la) - abs(lb)) > 0.05:
        fail('the flanking stones are not symmetric: %.2fm one side, %.2fm the other' % (abs(la), abs(lb)))
    else:
        ok('one stone %.2fm to each side of the hero' % abs(la))

    # Nearer the plate than the hero is, which is what "move them near the
    # leaderboard" asked for - and the reason they read as part of the board
    # rather than as two stones standing in the yard.
    for i, g in enumerate(graves):
        gd = (g[0] - BPOS[0]) * BOARD_NORMAL[0] + (g[2] - BPOS[2]) * BOARD_NORMAL[2]
        if gd >= dist_face:
            fail('flanking stone %d is %.2fm off the board, no nearer than the hero at %.2fm' % (i + 1, gd, dist_face))
        else:
            ok('flanking stone %d sits %.2fm off the board, %.2fm nearer than the hero' % (i + 1, gd, dist_face - gd))

# In frame at the wide keyframe, or they are two props nobody ever sees.
wide = SHOT[-1]
cam, aim = cam_for(wide)
P = projector(cam, aim, wide['fov'])
for i, g in enumerate(graves):
    top = P((g[0], g[1] + GRAVE_H * GRAVE_SCALE, g[2]))
    if top is None:
        fail('flanking stone %d is behind the camera at the wide shot' % (i + 1))
    elif abs(top[0]) > 1 or abs(top[1]) > 1:
        fail('flanking stone %d is outside the wide frame at x %.2f y %.2f' % (i + 1, top[0], top[1]))
    else:
        ok('flanking stone %d is in the wide frame at x %+.2f y %+.2f' % (i + 1, top[0], top[1]))

# ── which of the yard's own stones the shot strikes ────────────────────────
struck, left = [], []
for ent, src in GL.items():
    if ent not in TF or ent == BOARD_ENT or TF[ent][10] != 0:
        continue
    if 'grave' not in src.lower():
        continue
    t = TF[ent]
    d = math.hypot(t[0] - STAGE[0], t[2] - STAGE[2])
    (struck if d <= CLEAR_RADIUS else left).append((d, src.split('/')[-1]))
print()
print('      headstones struck for the shot (inside %.1fm):' % CLEAR_RADIUS)
for d, n in sorted(struck):
    print('        %-30s %.2fm' % (n, d))
if not struck:
    fail('nothing is struck - VICTORY_SET_CLEAR_RADIUS %.1f reaches no headstone, so the yard\'s own '
         'stones stay standing in the middle of the composition' % CLEAR_RADIUS)
else:
    ok('%d headstone(s) struck, nearest one left standing at %.2fm'
       % (len(struck), min(left)[0] if left else float('inf')))

# ── 10. is the camera standing inside anything? ────────────────────────────
#
# THE CHECK THAT WAS MISSING. Every other line in this file measured props by
# their ORIGIN, and KHN.glb's origin is 12m from the stage - so a 20m building
# that the camera flies straight into passed a "clear line to the hero" test
# nine times out of nine. Origins say nothing about volume.
#
# AABBs come from the glTF accessors' own min/max, which the format REQUIRES on
# POSITION. That means no vertex data is decoded and no mesh is walked: the
# whole sweep reads JSON headers and is over in a second even with a 9.8MB house
# in the list. A box is generous compared to the real hull, which is the right
# way round for this - it flags a camera that is merely close to being inside.
print()

def model_aabb(path):
    """Local-space AABB of a GLB, straight out of its accessor min/max."""
    full = os.path.join(ROOT, path)
    if not os.path.exists(full):
        return None
    d = open(full, 'rb').read()
    if d[:4] != b'glTF':
        return None
    off, js = 12, None
    while off < len(d):
        ln, ty = struct.unpack_from('<I4s', d, off)
        if ty == b'JSON':
            js = json.loads(d[off + 8:off + 8 + ln].decode('utf-8'))
        off += 8 + ln + ((4 - ln % 4) % 4 if ln % 4 else 0)
    if js is None:
        return None
    nodes, meshes, acc = js.get('nodes', []), js.get('meshes', []), js.get('accessors', [])
    lo = [1e9] * 3
    hi = [-1e9] * 3

    def mul(A, B):
        return [[sum(A[r][k] * B[k][c] for k in range(4)) for c in range(4)] for r in range(4)]

    def local(n):
        if 'matrix' in n:
            m = n['matrix']      # glTF matrices are COLUMN major
            return [[m[c * 4 + r] for c in range(4)] for r in range(4)]
        t = n.get('translation', [0, 0, 0])
        q = n.get('rotation', [0, 0, 0, 1])
        sc = n.get('scale', [1, 1, 1])
        x, y, z, w = q
        R = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0],
             [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0],
             [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0],
             [0, 0, 0, 1]]
        for r in range(3):
            for c in range(3):
                R[r][c] *= sc[c]
            R[r][3] = t[r]
        return R

    def walk(i, P):
        n = nodes[i]
        M = mul(P, local(n))
        if 'mesh' in n:
            for pr in meshes[n['mesh']].get('primitives', []):
                a = acc[pr['attributes']['POSITION']] if 'POSITION' in pr.get('attributes', {}) else None
                if a is None or 'min' not in a or 'max' not in a:
                    continue
                for cx in (a['min'][0], a['max'][0]):
                    for cy in (a['min'][1], a['max'][1]):
                        for cz in (a['min'][2], a['max'][2]):
                            for k in range(3):
                                v = M[k][0] * cx + M[k][1] * cy + M[k][2] * cz + M[k][3]
                                lo[k] = min(lo[k], v)
                                hi[k] = max(hi[k], v)
        for c in n.get('children', []):
            walk(c, M)

    I = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
    roots = js.get('scenes', [{}])[js.get('scene', 0)].get('nodes', list(range(len(nodes))))
    for r in roots:
        walk(r, I)
    return (lo, hi) if lo[0] < 1e8 else None


def is_struck(src, px, pz):
    low = src.lower()
    if any(m.lower() in low for m in CLEAR_ALWAYS):
        return True
    if any(m.lower() in low for m in CLEAR_MATCH):
        return math.hypot(px - STAGE[0], pz - STAGE[2]) <= CLEAR_RADIUS
    return False


boxes = {}
intruders = []
for ent, src in GL.items():
    if ent not in TF or TF[ent][10] != 0:
        continue
    t = TF[ent]
    if src not in boxes:
        boxes[src] = model_aabb(src)
    box = boxes[src]
    if box is None:
        continue
    lo, hi = box
    sc = t[7:10]
    # Axis-aligned placement only. Every entity this matters for is placed
    # square (the house included); a rotated box would need its corners turned,
    # and getting that wrong would report a false clearance, which is worse than
    # not reporting. Anything yawed is skipped and named below.
    yaw_free = abs(t[3]) < 1e-3 and abs(t[5]) < 1e-3
    wlo = [t[i] + lo[i] * sc[i] for i in range(3)]
    whi = [t[i] + hi[i] * sc[i] for i in range(3)]
    for k in SHOT:
        cam, _ = cam_for(k)
        inside = (wlo[0] <= cam[0] <= whi[0] and wlo[1] <= cam[1] <= whi[1] and wlo[2] <= cam[2] <= whi[2])
        if inside and not is_struck(src, t[0], t[2]):
            intruders.append((src.split('/')[-1], k['t'], yaw_free, wlo, whi))
            break

if intruders:
    for name, t, yaw_free, wlo, whi in intruders:
        fail('the camera is INSIDE %s at t=%.2f (x %.1f..%.1f y %.1f..%.1f z %.1f..%.1f)%s'
             % (name, t, wlo[0], whi[0], wlo[1], whi[1], wlo[2], whi[2],
                '' if yaw_free else ' [rotated placement, box is approximate]'))
    print('      add it to VICTORY_SET_CLEAR_ALWAYS, or move the shot out of it')
else:
    ok('no camera keyframe sits inside an unstruck model (%d models measured)'
       % len([b for b in boxes.values() if b]))

# The hero looks at the lens, not past it.
face_cam = cam_for({'phi': SHOT[0]['phi'], 'dist': SHOT[0]['dist'], 'camY': 0, 'aimY': 0})[0]
kf = None
for i in range(len(SHOT) - 1):
    if SHOT[i]['t'] <= FACE_T <= SHOT[i + 1]['t']:
        kf = i
        break
if kf is None:
    fail('VICTORY_AVATAR_FACE_T %.2f is outside the shot' % FACE_T)
else:
    a, b = SHOT[kf], SHOT[kf + 1]
    span = b['t'] - a['t']
    f = 0 if span <= 0 else (FACE_T - a['t']) / span
    f = f * f * (3 - 2 * f)
    face_phi = a['phi'] + (b['phi'] - a['phi']) * f
    visible_end = min(1.0, num('VICTORY_CINEMATIC_HOLD_SECONDS') / num('VICTORY_CINEMATIC_SECONDS'))
    def phi_at(t):
        for i in range(len(SHOT) - 1):
            if SHOT[i]['t'] <= t <= SHOT[i + 1]['t']:
                sp = SHOT[i + 1]['t'] - SHOT[i]['t']
                g = 0 if sp <= 0 else (t - SHOT[i]['t']) / sp
                g = g * g * (3 - 2 * g)
                return SHOT[i]['phi'] + (SHOT[i + 1]['phi'] - SHOT[i]['phi']) * g
        return SHOT[-1]['phi']
    worst = max(abs(face_phi - phi_at(visible_end * i / 100)) for i in range(101))
    if worst > 25:
        fail('the hero is up to %.0f degrees off the lens across the visible arc - '
             'VICTORY_AVATAR_FACE_T %.2f is aimed at the wrong part of the move' % (worst, FACE_T))
    else:
        ok('the hero faces within %.0f degrees of the lens for the whole visible arc' % worst)

print()
if fail.count:
    print('%d FAILURE(S)' % fail.count)
    sys.exit(1)
print('victory shot verified')
