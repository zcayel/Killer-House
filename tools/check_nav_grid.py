"""Fail if the skeleton's navigation grids no longer describe the live scene.

WHY THIS EXISTS. The skeleton is kinematic — its Transform is written directly
every frame, so scene colliders exert no force on it. Nothing stops it walking
through the scenery except SKELETON_BLOCKED_GRID / SKELETON_GROUND_GRID, and
those are BAKED. Move a prop in Creator Hub and the grid keeps describing the
old scene.

A stale grid does not look stale. It looks like a pathing bug: the skeleton
walks through the thing you just moved, or refuses to walk through the space
you just cleared. This project chased that symptom more than once before
realising the data, not the code, was wrong.

    python tools/check_nav_grid.py

Exit 0 = the grid matches the scene. Exit 1 = re-bake:

    python tools/bake_skeleton_grid.py

and splice the printed SKELETON_GRID_SOURCE_HASH / SKELETON_BLOCKED_GRID /
SKELETON_GROUND_GRID blocks into src/config.ts.

It also re-checks the invariants the grids have to satisfy on their own, so a
mis-spliced or hand-edited grid is caught even when the fingerprint matches.
"""
import hashlib
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, 'src', 'config.ts')
COMPOSITE = os.path.join(ROOT, 'assets', 'scene', 'main.composite')


def scene_fingerprint():
    """Must stay byte-identical to scene_fingerprint() in bake_skeleton_grid.py."""
    h = hashlib.sha256()
    h.update(open(COMPOSITE, 'rb').read())
    d = json.load(open(COMPOSITE, encoding='utf-8'))
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


def block(cfg, name, pat=r"'([^']+)'"):
    i = cfg.index('export const ' + name)
    return re.findall(pat, cfg[i:cfg.index('\n]', i)])


def num(cfg, name):
    return float(re.search(r'export const %s\s*=\s*([-\d.]+)' % name, cfg).group(1))


def main():
    cfg = open(CFG, encoding='utf-8').read()
    fails = []

    # ── 1. does the grid still describe this scene? ────────────────────────
    m = re.search(r"SKELETON_GRID_SOURCE_HASH = '([0-9a-f]+)'", cfg)
    if not m:
        fails.append('config.ts has no SKELETON_GRID_SOURCE_HASH - re-bake to add one')
    else:
        want = scene_fingerprint()
        got = m.group(1)
        print('scene fingerprint : %s' % want)
        print('grid was baked at : %s' % got)
        if want != got:
            fails.append(
                'THE GRID IS STALE. main.composite or a referenced .glb has changed\n'
                '     since it was baked, so the skeleton is navigating the OLD scene.\n'
                '     Re-run: python tools/bake_skeleton_grid.py')
        else:
            print('  -> grid matches the live scene')

    # ── 2. the grids have to agree with each other ────────────────────────
    blocked = block(cfg, 'SKELETON_BLOCKED_GRID', r"'([01]+)'")
    ground = block(cfg, 'SKELETON_GROUND_GRID')
    alpha = re.search(r"SKELETON_GROUND_ALPHABET = '([^']+)'", cfg).group(1)
    hstep = num(cfg, 'SKELETON_GROUND_STEP')
    maxstep = num(cfg, 'SKELETON_MAX_STEP')
    print('\nblocked grid      : %d rows x %d' % (len(blocked), len(blocked[0]) if blocked else 0))
    print('ground grid       : %d rows x %d' % (len(ground), len(ground[0]) if ground else 0))

    if len(blocked) != len(ground):
        fails.append('grids have different row counts (%d vs %d)' % (len(blocked), len(ground)))
    elif blocked and len(blocked[0]) != len(ground[0]):
        fails.append('grids have different widths (%d vs %d)' % (len(blocked[0]), len(ground[0])))
    if len({len(r) for r in blocked}) > 1:
        fails.append('blocked grid rows are not all the same width')
    if len({len(r) for r in ground}) > 1:
        fails.append('ground grid rows are not all the same width')
    bad = {ch for r in ground for ch in r if alpha.find(ch) < 0}
    if bad:
        fails.append('ground grid has characters missing from the alphabet: %s' % sorted(bad))

    # ── 3. the climb limit must not fragment the walkable surface ─────────
    if not fails and blocked and ground:
        worst = 0.0
        for j in range(len(ground)):
            for i in range(len(ground[0])):
                if blocked[j][i] == '1':
                    continue
                h = alpha.find(ground[j][i]) * hstep
                for dj, di in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nj, ni = j + dj, i + di
                    if 0 <= nj < len(ground) and 0 <= ni < len(ground[0]) and blocked[nj][ni] == '0':
                        worst = max(worst, abs(alpha.find(ground[nj][ni]) * hstep - h))
        print('worst step between adjacent walkable cells: %.3f m (limit %.2f)' % (worst, maxstep))
        if worst > maxstep + 1e-9:
            fails.append(
                'a %.2fm step exists between two walkable cells but the climb limit\n'
                '     is %.2fm, so part of the yard is unreachable' % (worst, maxstep))

    # ── 4. every grave must be standable ─────────────────────────────────
    if not fails and blocked:
        x0 = num(cfg, 'SKELETON_GRID_ORIGIN_X')
        z0 = num(cfg, 'SKELETON_GRID_ORIGIN_Z')
        cell = num(cfg, 'SKELETON_GRID_CELL')
        i = cfg.index('export const SKELETON_SPAWNS')
        pts = re.findall(r'Vector3\.create\((-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\)',
                         cfg[i:cfg.index('\n]', i)])
        hr = re.search(r'HOUSE_RECT = \{\s*minX:\s*(-?[\d.]+),\s*maxX:\s*(-?[\d.]+),'
                       r'\s*minZ:\s*(-?[\d.]+),\s*maxZ:\s*(-?[\d.]+)', cfg)
        hr = [float(v) for v in hr.groups()]
        wi = cfg.index('export const HOUSE_WING_RECTS')
        wings = [[float(v) for v in g] for g in re.findall(
            r'minX:\s*(-?[\d.]+),\s*maxX:\s*(-?[\d.]+),\s*minZ:\s*(-?[\d.]+),\s*maxZ:\s*(-?[\d.]+)',
            cfg[wi:cfg.index('\n]', wi)])]
        print('\ngrave spawns:')
        for a, _b, c in pts:
            x, z = float(a), float(c)
            j = int((z - z0) // cell)
            ii = int((x - x0) // cell)
            gb = 0 <= j < len(blocked) and 0 <= ii < len(blocked[0]) and blocked[j][ii] == '1'
            inb = (hr[0] < x < hr[1] and hr[2] < z < hr[3]) or any(
                w[0] < x < w[1] and w[2] < z < w[3] for w in wings)
            state = 'BLOCKED' if (gb or inb) else 'free'
            why = (' (grid)' if gb else '') + (' (inside building)' if inb else '')
            print('   (%6.2f, %6.2f)  %s%s' % (x, z, state, why))
            if gb or inb:
                fails.append(
                    'grave spawn (%.2f, %.2f) is on unstandable ground%s. A skeleton\n'
                    '     whose grave is blocked can never leave it: the "never stand inside\n'
                    '     something" rule teleports it home every frame and home is blocked,\n'
                    '     so it animates on the spot forever.' % (x, z, why))

    print()
    if fails:
        print('FAIL - skeleton navigation data is not trustworthy:')
        for f in fails:
            print('   ' + f)
        sys.exit(1)
    print('PASS - navigation grids match the scene and satisfy every invariant.')


if __name__ == '__main__':
    main()
