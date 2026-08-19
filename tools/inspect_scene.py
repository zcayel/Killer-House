"""Read what Creator Hub actually placed, straight out of main.composite.

Every "the trap kills in the wrong place" bug in this scene has come down to a
mismatch between what the code assumes about a placed entity and what its
transform really is. This prints the truth: names, world transforms, parents,
models and animation states.

    python tools/inspect_scene.py                    # summary of everything
    python tools/inspect_scene.py --find "Iron Fence"
    python tools/inspect_scene.py --find pblade --anim
    python tools/inspect_scene.py --near 10.07 0 23.24 --radius 3

Rotations are shown as euler degrees as well as the raw quaternion, because
Creator Hub shows degrees and the composite stores quaternions - and reading one
as the other is exactly how a hazard ends up facing the wrong way.
"""
import argparse
import json
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMPOSITE = os.path.join(ROOT, 'assets', 'scene', 'main.composite')


def quat_to_euler(x, y, z, w):
    """Degrees, XYZ order - the convention Creator Hub's inspector shows."""
    sinr = 2 * (w * x + y * z)
    cosr = 1 - 2 * (x * x + y * y)
    roll = math.atan2(sinr, cosr)
    sinp = 2 * (w * y - z * x)
    sinp = max(-1.0, min(1.0, sinp))
    pitch = math.asin(sinp)
    siny = 2 * (w * z + x * y)
    cosy = 1 - 2 * (y * y + z * z)
    yaw = math.atan2(siny, cosy)
    return tuple(round(math.degrees(v), 2) for v in (roll, pitch, yaw))


def load():
    if not os.path.exists(COMPOSITE):
        sys.exit('no composite at %s' % COMPOSITE)
    d = json.load(open(COMPOSITE, encoding='utf-8'))
    names, tf, gl, anim, other = {}, {}, {}, {}, {}
    for c in d.get('components', []):
        n = c.get('name', '')
        data = c.get('data', {}) or {}
        if n == 'core-schema::Name':
            for k, v in data.items():
                names[k] = (v.get('json') or {}).get('value')
        elif n == 'core::Transform':
            for k, v in data.items():
                tf[k] = v.get('json') or {}
        elif n == 'core::GltfContainer':
            for k, v in data.items():
                gl[k] = v.get('json') or {}
        elif n == 'core::Animator':
            for k, v in data.items():
                anim[k] = v.get('json') or {}
        else:
            for k in data:
                other.setdefault(k, []).append(n)
    return names, tf, gl, anim, other


def world_of(eid, tf):
    """Compose the parent chain, so what is printed is where it really is."""
    pos = [0.0, 0.0, 0.0]
    chain = []
    node, guard = eid, 0
    while node in tf and guard < 32:
        chain.append(node)
        p = tf[node].get('parent')
        if p is None or str(p) == str(node) or str(p) not in tf:
            break
        node = str(p)
        guard += 1
    depth = len(chain)
    # translation only - enough to answer "where is this thing", and the traps
    # that need full rotation composition do it themselves at runtime.
    for e in chain:
        q = tf[e].get('position') or {}
        pos[0] += q.get('x', 0.0)
        pos[1] += q.get('y', 0.0)
        pos[2] += q.get('z', 0.0)
    return pos, depth


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--find', default=None, help='case-insensitive substring of the entity name')
    ap.add_argument('--near', nargs=3, type=float, metavar=('X', 'Y', 'Z'),
                    help='only entities within --radius of this point')
    ap.add_argument('--radius', type=float, default=3.0)
    ap.add_argument('--anim', action='store_true', help='also list animation states')
    ap.add_argument('--components', action='store_true', help='also list other components')
    args = ap.parse_args()

    names, tf, gl, anim, other = load()
    print('composite: %s' % os.path.relpath(COMPOSITE, ROOT).replace('\\', '/'))
    print('%d named entities, %d with transforms, %d with models, %d animated\n'
          % (len(names), len(tf), len(gl), len(anim)))

    rows = []
    for eid, nm in names.items():
        if nm is None:
            continue
        if args.find and args.find.lower() not in nm.lower():
            continue
        wp, depth = world_of(eid, tf)
        if args.near:
            d = math.dist(wp, args.near)
            if d > args.radius:
                continue
        rows.append((nm, eid, wp, depth))

    if not rows:
        print('nothing matched.')
        return
    rows.sort(key=lambda r: r[0])

    for nm, eid, wp, depth in rows:
        t = tf.get(eid, {})
        r = t.get('rotation') or {}
        s = t.get('scale') or {}
        q = (r.get('x', 0.0), r.get('y', 0.0), r.get('z', 0.0), r.get('w', 1.0))
        eul = quat_to_euler(*q)
        sc = (s.get('x', 1.0), s.get('y', 1.0), s.get('z', 1.0))
        parent = t.get('parent')
        pname = names.get(str(parent)) if parent is not None else None
        print('%-26s  id=%-8s' % (nm, eid))
        print('    world pos   (%8.3f, %8.3f, %8.3f)%s'
              % (wp[0], wp[1], wp[2], '   [via %d parents]' % depth if depth > 1 else ''))
        print('    rotation    euler (%7.2f, %7.2f, %7.2f) deg   quat (%.4f, %.4f, %.4f, %.4f)'
              % (eul[0], eul[1], eul[2], q[0], q[1], q[2], q[3]))
        if abs(sc[0] - 1) > 1e-6 or abs(sc[1] - 1) > 1e-6 or abs(sc[2] - 1) > 1e-6:
            uniform = abs(sc[0] - sc[1]) < 1e-6 and abs(sc[0] - sc[2]) < 1e-6
            print('    scale       (%.3f, %.3f, %.3f)%s'
                  % (sc[0], sc[1], sc[2], '' if uniform else '   <-- NON-UNIFORM'))
        if parent is not None:
            print('    parent      %s (%s)' % (parent, pname or '?'))
        src = (gl.get(eid) or {}).get('src')
        if src:
            full = os.path.join(ROOT, src)
            print('    model       %s%s' % (src, '' if os.path.exists(full) else '   <-- MISSING'))
        if args.anim and eid in anim:
            for st in anim[eid].get('states', []) or []:
                print('    clip        %-30r playing=%s loop=%s speed=%s'
                      % (st.get('clip'), st.get('playing'), st.get('loop'), st.get('speed')))
        if args.components and eid in other:
            print('    also        %s' % ', '.join(sorted(set(other[eid]))))
        print()

    print('%d entit%s shown.' % (len(rows), 'y' if len(rows) == 1 else 'ies'))


if __name__ == '__main__':
    main()
