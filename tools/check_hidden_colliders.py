"""Find colliders the player can hit where nothing is drawn.

A "hidden collider" is anything that blocks, or is clickable, in space the
player sees as empty. They are invisible by definition, so they are normally
only found by walking into one — which is why this is a tool and not a
playtest note.

FOUR SOURCES, all checked here:

  A. A placed model whose _collider mesh reaches past its visible mesh. Every
     .glb in this scene ships a low-poly collider proxy and the visible mesh
     itself carries no collision, so the proxy IS the solid object. Where it
     is bigger than what you can see, you bump into air.
  B. A placed model with collision but no visible geometry at all.
  C. A model with no collider node whose placement still asks for solid
     invisible meshes — that silently has NO collision, the opposite failure.
  D. Code-created MeshCollider boxes/spheres, invisible by construction.
     These are legitimate (hover targets, the skeleton's body) but must be
     deliberate, so they are listed for review.

    python tools/check_hidden_colliders.py

Exit 1 if a collider overhangs its visible mesh by more than TOLERANCE and is
not listed in KNOWN_OVERHANG.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import glbkit as G  # noqa: E402

ROOT = G.ROOT

# How far a collider may reach past the visible mesh before it counts as a
# hidden wall. 10cm is well under the player's body radius (0.4), so anything
# below this cannot produce a "bumped into nothing" moment on its own.
TOLERANCE = 0.10

# KNOWN, ACCEPTED OVERHANGS — model name -> metres allowed.
#
# A gate that is permanently red teaches people to ignore it, so a defect that
# cannot be fixed from code is recorded here rather than left failing. Anything
# NEW, or any of these getting WORSE, still fails.
#
# KILLERHOUSE_.glb: 51 of its 2154 collider vertices sit outside the visible
# silhouette. Measured 2026-08-19:
#   * south side, a 0.28m lip at world z 4.38 against a visible 4.66, from the
#     ground up to world y ~2.5 — in front of the porch, and the only part of
#     this a player can actually walk into;
#   * east side, 0.19m at world x ~34.75, which is past the fence at x 31.1
#     and therefore unreachable.
# Fixing it means shrinking the _collider mesh in the model and re-exporting —
# see HOUSE_MODEL_SPEC.md section 7. Lower this number if that ever happens.
KNOWN_OVERHANG = {'KILLERHOUSE_.glb': 0.29}

I4 = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]


def bounds(path):
    """(visible bounds, collider bounds, has_collider, has_visible)."""
    g, bn = G.load(path)
    vis = [[1e9] * 3, [-1e9] * 3]
    col = [[1e9] * 3, [-1e9] * 3]
    seen = {'col': False, 'vis': False}

    def walk(i, P):
        n = g['nodes'][i]
        M = G.mul(P, G.ntrs(n))
        if 'mesh' in n:
            label = '%s %s' % (n.get('name', ''), g['meshes'][n['mesh']].get('name', ''))
            is_col = 'collider' in label.lower()
            tgt = col if is_col else vis
            seen['col' if is_col else 'vis'] = True
            for pr in g['meshes'][n['mesh']]['primitives']:
                if 'POSITION' not in pr.get('attributes', {}):
                    continue
                for p in G.acc(g, bn, pr['attributes']['POSITION']):
                    q = G.xf(M, p)
                    for k in range(3):
                        tgt[0][k] = min(tgt[0][k], q[k])
                        tgt[1][k] = max(tgt[1][k], q[k])
        for c in n.get('children', []):
            walk(c, M)

    for sc in g.get('scenes', []):
        for r in sc.get('nodes', []):
            walk(r, I4)
    return vis, col, seen['col'], seen['vis']


def main():
    comp = json.load(open(os.path.join(ROOT, 'assets', 'scene', 'main.composite'),
                          encoding='utf-8'))
    C = {c['name']: (c.get('data') or {}) for c in comp.get('components', [])}
    gltfs = C.get('core::GltfContainer', {})
    names = C.get('core-schema::Name', {})

    def nm(e):
        return ((names.get(e, {}) or {}).get('json', {}) or {}).get('value', '?')

    by_src = {}
    for e, v in gltfs.items():
        j = v.get('json', {}) or {}
        src = j.get('src', '')
        if src:
            by_src.setdefault(src, []).append(
                (e, nm(e), j.get('visibleMeshesCollisionMask'),
                 j.get('invisibleMeshesCollisionMask')))

    print('%d placed entities across %d distinct models\n' % (len(gltfs), len(by_src)))
    fails = []
    notes = []

    print('%-34s %5s  %-26s %s' % ('model', 'uses', 'collider vs visible', 'verdict'))
    print('-' * 96)
    for src in sorted(by_src, key=lambda s: -len(by_src[s])):
        uses = by_src[src]
        path = os.path.join(ROOT, src.replace('/', os.sep))
        name = src.split('/')[-1]
        if not os.path.isfile(path):
            notes.append('%s is referenced by the scene but missing on disk' % name)
            continue
        try:
            vis, col, has_col, has_vis = bounds(path)
        except Exception as ex:  # noqa: BLE001 - report and keep going
            notes.append('%s could not be read (%s)' % (name, ex))
            continue

        # does any placement give the invisible mesh physics?
        solid_invis = any(isinstance(m, int) and (m & 1) for _e, _n, _v, m in uses)

        if not has_col:
            if solid_invis:
                notes.append('%s has NO collider mesh, so its "invisible solid" mask '
                             'does nothing - it is pass-through' % name)
            print('%-34s %5d  %-26s %s'
                  % (name[:34], len(uses), 'no collider mesh', 'pass-through'))
            continue
        if not has_vis:
            print('%-34s %5d  %-26s %s'
                  % (name[:34], len(uses), 'COLLIDER ONLY', 'INVISIBLE SOLID'))
            fails.append('%s has collision but NO visible geometry - it is a pure '
                         'invisible wall (%d placed)' % (name, len(uses)))
            continue

        over = [max(vis[0][k] - col[0][k], col[1][k] - vis[1][k]) for k in range(3)]
        worst = max(over)
        desc = 'over by %+.2f %+.2f %+.2f' % (over[0], over[1], over[2])
        allowed = max(TOLERANCE, KNOWN_OVERHANG.get(name, 0.0))
        if worst > allowed and solid_invis:
            print('%-34s %5d  %-26s %s' % (name[:34], len(uses), desc, 'HIDDEN WALL'))
            fails.append('%s: collider reaches %.2fm past the visible mesh (limit '
                         '%.2f) and is solid - you can bump into empty space around it'
                         % (name, worst, allowed))
        elif name in KNOWN_OVERHANG and worst > TOLERANCE:
            print('%-34s %5d  %-26s %s'
                  % (name[:34], len(uses), desc, 'known (see KNOWN_OVERHANG)'))
            notes.append('%s still overhangs by %.2fm - accepted, needs a model '
                         're-export' % (name, worst))
        else:
            print('%-34s %5d  %-26s %s'
                  % (name[:34], len(uses), desc, 'ok' if solid_invis else 'ok (not solid)'))

    # ── D. colliders created in code are invisible by construction ─────────
    print('\ncode-created colliders (invisible by construction - review, not a failure):')
    found = []
    for root, _d, fs in os.walk(os.path.join(ROOT, 'src')):
        for f in fs:
            if not f.endswith(('.ts', '.tsx')):
                continue
            fp = os.path.join(root, f)
            for i, line in enumerate(open(fp, encoding='utf-8'), 1):
                m = re.search(r'MeshCollider\.set(\w+)\([^,]+,\s*ColliderLayer\.(\w+)', line)
                if m:
                    rel = os.path.relpath(fp, ROOT).replace(os.sep, '/')
                    found.append((rel, i, m.group(1), m.group(2)))
    for rel, i, shape, layer in found:
        flag = ''
        if layer in ('CL_PHYSICS', 'CL_PHYSICS_AND_POINTER'):
            flag = '   <- SOLID: blocks the player'
        print('   %-36s:%-5d %-8s %s%s' % (rel, i, shape, layer, flag))
    if not found:
        print('   none')

    for n in notes:
        print('\n  ! %s' % n)

    print()
    if fails:
        print('FAIL - hidden colliders in the scene:')
        for f in fails:
            print('   ' + f)
        print('\n   Fix in the MODEL (shrink the _collider mesh to the silhouette and')
        print('   re-export), not in code - every placement of that .glb shares it.')
        sys.exit(1)
    print('PASS - no NEW hidden colliders. Every placed model is within %.2fm of its '
          'own silhouette,' % TOLERANCE)
    print('       except the accepted entries in KNOWN_OVERHANG above.')


if __name__ == '__main__':
    main()
