"""Build the skeleton's navigation data from the REAL scene geometry.

Emits TWO grids, both consumed by src/enemies/skeletons.ts:

    SKELETON_GROUND_GRID   how high the walkable ground is in each cell
    SKELETON_BLOCKED_GRID  which cells have an obstacle STANDING ON that ground

Run this after moving/adding/removing any prop, or after the skeleton walks
through something it should not. A hand-kept grid drifts silently: this project
shipped 6 cells around a rotated gravestone as walkable because the grid was
baked before the grave was turned 90 degrees.

    python tools/bake_skeleton_grid.py

WHY GROUND-RELATIVE, which is the whole point of this rewrite. The previous
version rasterised every triangle between world y 0.15 and 1.95 - an ABSOLUTE
band - and called those cells blocked. On flat ground that is right. On the
yard's stone steps it is exactly wrong twice over:

  * the steps themselves have triangles in that band, so a staircase read as a
    solid wall and the skeleton was told to path around its own route up; and
  * the skeleton was pinned to y=0 regardless, so while the grid said "wall"
    the movement code happily walked it THROUGH the stonework at ground level.
    That contradiction is the "skeleton runs through the collider" report.

So: find the ground first, then look for obstacles in a band measured FROM that
ground. A step is ground you can stand on. A gravestone is an obstacle standing
on ground. The two are only distinguishable if you know where the ground is.

Per-model bounding boxes do not work here: KILLERHOUSE_.glb's box is 355 m2 of
mostly-open shell, and using it would wall off the whole yard. So rasterise the
actual collider triangles, dilate obstacles by the skeleton's body radius
(blockedAt tests a centre point, so obstacles have to be grown by its width),
and emit grids.

Connectivity is checked at the end: every patrol node and spawn has to remain
mutually reachable, or the skeleton is walled into a pocket. Reachability now
also respects the climb limit, because a cell you cannot step up onto is not
connected to you no matter how clear it looks from above.
"""
import io
import math
import os
import re
import sys
from collections import deque

_out = sys.stdout
sys.stdout = io.StringIO()
import scene_props as cc          # noqa: E402
sys.stdout = _out

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
cfg = open(os.path.join(ROOT, 'src', 'config.ts'), encoding='utf-8').read()

def scene_fingerprint():
    """Identity of the scene this grid describes. Changes whenever a prop is
    moved, added or removed in Creator Hub, or a model file is replaced."""
    import hashlib as _h, json as _j
    h = _h.sha256()
    comp = os.path.join(ROOT, 'assets', 'scene', 'main.composite')
    h.update(open(comp, 'rb').read())
    d = _j.load(open(comp, encoding='utf-8'))
    srcs = set()
    for c in d.get('components', []):
        if c.get('name') == 'core::GltfContainer':
            for _k, v in (c.get('data') or {}).items():
                src = ((v.get('json') or {}).get('src') or '')
                if src:
                    srcs.add(src)
    for src in sorted(srcs):
        f = os.path.join(ROOT, *src.split('/'))
        if os.path.isfile(f):
            h.update(src.encode())
            h.update(str(os.path.getsize(f)).encode())
    return h.hexdigest()[:16]


CELL = 0.5
FINE = 0.25
SKEL_R = 0.45
# Body band, measured UP FROM THE GROUND of each cell (not from world zero).
BODY_LO, BODY_HI = 0.30, 1.95
# Anything above this is roof/overhang, not ground the skeleton could stand on.
GROUND_CEIL = 3.0
# Tallest single step it may climb. Must match SKELETON_MAX_STEP in config.ts.
MAX_STEP = 0.6
# Height quantisation for the emitted grid, and the alphabet it is written in.
# Deliberately excludes ' and \ so a row can never break the TS string literal.
H_STEP = 0.125
ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz+-'


def rect(name):
    m = re.search(re.escape(name) + r'\s*=\s*\{\s*minX:\s*(-?[\d.]+),\s*maxX:\s*(-?[\d.]+),'
                  r'\s*minZ:\s*(-?[\d.]+),\s*maxZ:\s*(-?[\d.]+)', cfg)
    return tuple(float(x) for x in m.groups())


YARD = rect('YARD_BOUNDS')
X0, X1, Z0, Z1 = YARD
NX = int(math.ceil((X1 - X0) / CELL))
NZ = int(math.ceil((Z1 - Z0) / CELL))
FX = int(math.ceil((X1 - X0) / FINE))
FZ = int(math.ceil((Z1 - Z0) / FINE))
print(f'yard {X0}..{X1} x {Z0}..{Z1}  ->  {NX} x {NZ} cells of {CELL}m')

# ── sample every triangle into the fine grid, keeping ALL heights ──────────
heights = [[] for _ in range(FX * FZ)]
per_model = {}
for name, tris, _b in cc.world:
    hits = 0
    for tri in tris:
        A, B, C = tri
        n = max(int(max(math.dist(A, B), math.dist(B, C), math.dist(A, C)) / (FINE * 0.5)), 1)
        for i in range(n + 1):
            for j in range(n + 1 - i):
                u, v = i / n, j / n
                w = 1 - u - v
                p = tuple(A[k] * w + B[k] * u + C[k] * v for k in range(3))
                if not (X0 <= p[0] < X1 and Z0 <= p[2] < Z1):
                    continue
                fi = int((p[0] - X0) / FINE)
                fj = int((p[2] - Z0) / FINE)
                heights[fj * FX + fi].append(p[1])
                hits += 1
    if hits:
        per_model[name] = hits
print(f'{len(per_model)} models contribute geometry inside the yard')
for nm, h in sorted(per_model.items(), key=lambda kv: -kv[1])[:8]:
    print(f'    {nm[:44]:44s} {h} samples')

# ── ground height, then obstacles measured from it ────────────────────────
# Ground = the highest surface at or below GROUND_CEIL. Everything above the
# body band is overhead (roof, an arch, the underside of a balcony) and must
# not make the cell unwalkable - you can walk under a doorway.
#
# GROUND IS THE LOWEST SURFACE YOU COULD ACTUALLY STAND ON, i.e. the lowest
# height with clear HEADROOM above it. Two earlier rules were both wrong:
#
#   * "highest surface <= 3m" makes the TOP OF ANY OBJECT under 3m read as
#     ground, so gravestones and low walls became terraces; and
#   * flood-filling ground into empty cells from the nearest sampled
#     neighbour spread those bogus heights across open grass. A direct
#     geometry probe showed all five patrol/spawn points have NO geometry
#     within 0.25m - they are open yard at y=0 - while that bake claimed
#     1.74-2.57m for them. An empty cell is open ground; it is not "whatever
#     the nearest wall's top was".
#
# So: start at yard level and only climb if yard level is genuinely occupied.
fine_ground = [0.0] * (FX * FZ)
fine_solid = [False] * (FX * FZ)
for idx, hs in enumerate(heights):
    if not hs:
        continue                     # no geometry at all -> open ground, y=0
    def clear(h):
        return not any(h + BODY_LO <= y <= h + BODY_HI for y in hs)
    if clear(0.0):
        fine_ground[idx] = 0.0       # standing at yard level works
        continue
    # Yard level is occupied. The only way this cell is walkable is by standing
    # ON something - take the LOWEST surface with headroom, so the skeleton
    # stands on the first step rather than on the handrail above it.
    cands = sorted(y for y in hs if 0.0 < y <= GROUND_CEIL)
    stood = None
    for h in cands:
        if clear(h):
            stood = h
            break
    if stood is None:
        fine_solid[idx] = True       # occupied at every height -> a real wall
    else:
        fine_ground[idx] = stood

# ── pedestal tops are obstacles, not floor ────────────────────────────────
#
# The headroom rule above says a gravestone's TOP is a surface with clear air
# over it - true, and useless: it is 1.5m up with nothing to climb from, so it
# is an obstacle wearing a floor's clothing. Without this pass the yard came
# out 99% walkable (it is really ~70%), because every prop turned into a
# terrace and the body-radius dilation below had almost nothing left to grow.
#
# A cell is a pedestal if you could not step onto it from ANY nearby ground:
# its own ground sits more than one step above the lowest ground within the
# skeleton's own radius. Stairs survive this - each tread is only ~0.2m above
# the one before it - while a gravestone, crate or plinth does not.
pedestal_r = int(math.ceil(SKEL_R / FINE))
pedestals = 0
for idx in range(FX * FZ):
    if fine_solid[idx]:
        continue
    ci, cj = idx % FX, idx // FX
    lowest = fine_ground[idx]
    for di in range(-pedestal_r, pedestal_r + 1):
        for dj in range(-pedestal_r, pedestal_r + 1):
            ni, nj = ci + di, cj + dj
            if 0 <= ni < FX and 0 <= nj < FZ:
                lowest = min(lowest, fine_ground[nj * FX + ni])
    if fine_ground[idx] - lowest > MAX_STEP:
        fine_solid[idx] = True
        pedestals += 1
print(f'{pedestals} fine cells are pedestal tops (obstacle surfaces, not floor)')

# ── dilate obstacles by the skeleton radius ───────────────────────────────
rad = int(math.ceil(SKEL_R / FINE))
grown = set()
for idx, s in enumerate(fine_solid):
    if not s:
        continue
    ci, cj = idx % FX, idx // FX
    for di in range(-rad, rad + 1):
        for dj in range(-rad, rad + 1):
            if di * di + dj * dj <= rad * rad:
                grown.add((ci + di, cj + dj))

blocked = [[False] * NZ for _ in range(NX)]
ground = [[0.0] * NZ for _ in range(NX)]
step = int(CELL / FINE)
for ci in range(NX):
    for cj in range(NZ):
        g = 0.0
        b = False
        for di in range(step):
            for dj in range(step):
                fi, fj = ci * step + di, cj * step + dj
                if not (0 <= fi < FX and 0 <= fj < FZ):
                    continue
                g = max(g, fine_ground[fj * FX + fi])
                if (fi, fj) in grown:
                    b = True
        blocked[ci][cj] = b
        ground[ci][cj] = g

free = sum(1 for i in range(NX) for j in range(NZ) if not blocked[i][j])
print(f'\n{free}/{NX*NZ} cells walkable = {100*free/(NX*NZ):.0f}% of the yard box')
raised = sum(1 for i in range(NX) for j in range(NZ)
             if not blocked[i][j] and ground[i][j] > 0.2)
print(f'{raised} walkable cells sit above y 0.2 - steps and terraces the old '
      f'flat-y=0 skeleton walked straight through')

# ── connectivity, now respecting the climb limit ──────────────────────────
def pts(const):
    b = cfg[cfg.index('export const ' + const):]
    b = b[:b.index('\n]')]
    return [(float(a), float(c)) for a, _b2, c in
            re.findall(r'Vector3\.create\((-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\)', b)]


route = pts('SKELETON_PATROL_ROUTE')
spawns = pts('SKELETON_SPAWNS')
key = [('patrol %d' % i, p) for i, p in enumerate(route)] + \
      [('spawn %d' % i, p) for i, p in enumerate(spawns)]


def cell(x, z):
    return int((x - X0) / CELL), int((z - Z0) / CELL)


print('\nkey points:')
bad = []
for label, (x, z) in key:
    ci, cj = cell(x, z)
    inside = 0 <= ci < NX and 0 <= cj < NZ
    b = (not inside) or blocked[ci][cj]
    g = ground[ci][cj] if inside else 0.0
    print(f'  {label:10s} ({x:6.2f},{z:6.2f}) cell({ci:3d},{cj:3d}) ground {g:5.2f}  '
          f'{"BLOCKED" if b else "free"}')
    if b:
        bad.append(label)

start = None
for label, (x, z) in key:
    ci, cj = cell(x, z)
    if 0 <= ci < NX and 0 <= cj < NZ and not blocked[ci][cj]:
        start = (ci, cj)
        break
seen = set()
if start:
    q = deque([start])
    seen.add(start)
    while q:
        ci, cj = q.popleft()
        for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ni, nj = ci + di, cj + dj
            if not (0 <= ni < NX and 0 <= nj < NZ) or blocked[ni][nj]:
                continue
            if abs(ground[ni][nj] - ground[ci][cj]) > MAX_STEP:
                continue          # too tall to climb - genuinely not connected
            if (ni, nj) in seen:
                continue
            seen.add((ni, nj))
            q.append((ni, nj))
print(f'\nlargest reachable region (climb limit {MAX_STEP}m): {len(seen)} cells')
for label, (x, z) in key:
    ci, cj = cell(x, z)
    if (ci, cj) not in seen and label not in bad:
        bad.append(label + ' (unreachable)')
print('  UNREACHABLE/BLOCKED: ' + (', '.join(bad) if bad else 'none - all key points connected'))

print('\nmap (# blocked, . flat, digit = ground height in 0.5m steps), x across, z down:')
for j in range(NZ):
    row = ''
    for i in range(NX):
        if blocked[i][j]:
            row += '#'
        elif ground[i][j] > 0.2:
            row += str(min(9, int(ground[i][j] / 0.5)))
        else:
            row += '.'
    print(f'  z{Z0+j*CELL:5.1f} ' + row)


def enc(y):
    return ALPHA[max(0, min(len(ALPHA) - 1, int(round(y / H_STEP))))]


print('\nrows as config strings:')
print('export const SKELETON_BLOCKED_GRID: string[] = [')
for j in range(NZ):
    print("  '" + ''.join('1' if blocked[i][j] else '0' for i in range(NX)) + "',")
print(']')
print()
print('export const SKELETON_GROUND_GRID: string[] = [')
for j in range(NZ):
    print("  '" + ''.join(enc(ground[i][j]) for i in range(NX)) + "',")
print(']')
