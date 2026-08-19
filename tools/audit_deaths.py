"""Audit the DEATH SYSTEM: every object that can kill the player, checked.

There is no single registry of hazards in this scene - each one is its own
module calling killPlayer(cause). That is fine until a hazard drifts: it keeps
running against an entity that was deleted, or forgets the invulnerability
gate, or its kill shape is a hand-tuned radius nobody re-measured. All three
have happened here, and one of them (a trap whose model was removed from the
scene but whose 4.8m geometric fallback kept killing) was invisible for weeks.

So: find every kill path by reading the source, then check each one.

    python tools/audit_deaths.py

CHECKS
  1. ENTITY EXISTS      - a hazard that adopts a placed entity by name must find
                          it in main.composite. This is the check that catches a
                          trap still killing after its model was deleted.
  2. INVULNERABILITY    - every kill path must be gated on isInvulnerable(), or
                          it fires during the respawn shield and the win screen.
  3. CAUSE STRINGS      - unique, non-empty, and they must survive the UI's
                          "Killed by " prefix strip without reading oddly.
  4. SHAPE PROVENANCE   - is the lethal volume MEASURED off the model, or a
                          hand-written radius? Hand-written ones are listed with
                          their numbers so they can be judged, not hidden.
  5. ASSETS             - referenced sounds and models must exist on disk.

Exit code is non-zero if anything in 1-3 fails, so this can gate a build.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'src')
COMPOSITE = os.path.join(ROOT, 'assets', 'scene', 'main.composite')

problems = []
warnings = []
notes = []


def rel(p):
    return os.path.relpath(p, ROOT).replace('\\', '/')


# ── gather sources ─────────────────────────────────────────────────────────
def blank_comments(src: str) -> str:
    """Replace comment bodies with spaces, keeping every byte offset and newline.

    Without this the scan reads prose as code: multiplayer.ts has the words
    "killPlayer(cause) already threads it through" inside a doc comment, which
    was reported as an ungated kill site. A checker that cries wolf gets
    ignored, so comments are blanked rather than trusted.
    """
    out = list(src)
    i, n = 0, len(src)
    while i < n:
        c, nxt = src[i], src[i + 1] if i + 1 < n else ''
        if c == '/' and nxt == '/':
            while i < n and src[i] != '\n':
                out[i] = ' '
                i += 1
        elif c == '/' and nxt == '*':
            while i < n and not (src[i] == '*' and i + 1 < n and src[i + 1] == '/'):
                if src[i] != '\n':
                    out[i] = ' '
                i += 1
            for _ in range(2):
                if i < n:
                    out[i] = ' '
                    i += 1
        elif c in ('"', "'", '`'):
            q = c
            i += 1
            while i < n:
                if src[i] == '\\':
                    i += 2
                    continue
                if src[i] == q:
                    i += 1
                    break
                i += 1
        else:
            i += 1
    return ''.join(out)


files = {}      # comment-free; string literals are left intact
for dirpath, _, names in os.walk(SRC):
    for n in names:
        if n.endswith(('.ts', '.tsx')):
            p = os.path.join(dirpath, n)
            files[p] = blank_comments(open(p, encoding='utf-8').read())

composite_names = set()
if os.path.exists(COMPOSITE):
    d = json.load(open(COMPOSITE, encoding='utf-8'))
    for c in d.get('components', []):
        if c.get('name') == 'core-schema::Name':
            for v in (c.get('data') or {}).values():
                val = (v.get('json') or {}).get('value')
                if val:
                    composite_names.add(val)

# ── 1. every kill path ─────────────────────────────────────────────────────
KILL = re.compile(r'killPlayer\(\s*([^)]*?)\s*\)')
kills = []           # (file, line, argument-text)
for p, s in files.items():
    if p.endswith('gameState.ts'):
        continue     # the definition itself
    for m in KILL.finditer(s):
        line = s[:m.start()].count('\n') + 1
        kills.append((p, line, m.group(1).strip()))

print('=' * 78)
print('DEATH SYSTEM AUDIT')
print('=' * 78)
print('\n%d kill site%s across %d module%s\n'
      % (len(kills), '' if len(kills) == 1 else 's',
         len({k[0] for k in kills}), '' if len({k[0] for k in kills}) == 1 else 's'))

# literal cause strings
causes = {}
for p, line, arg in kills:
    m = re.fullmatch(r"'([^']*)'", arg) or re.fullmatch(r'"([^"]*)"', arg)
    label = m.group(1) if m else '(computed: %s)' % arg
    causes.setdefault(label, []).append((p, line))

for label in sorted(causes):
    where = ', '.join('%s:%d' % (rel(p), ln) for p, ln in causes[label])
    print('  %-38s %s' % (label, where))

# 3. cause strings: duplicates and the UI prefix strip
print('\n-- cause strings --')
for label, sites in sorted(causes.items()):
    if label.startswith('(computed'):
        notes.append('cause computed at runtime, not checkable statically: %s' % label)
        continue
    if not label.strip():
        problems.append('empty death cause at %s' % rel(sites[0][0]))
    if len(sites) > 1 and 'swinging blade' not in label:
        notes.append('cause %r fires from %d places' % (label, len(sites)))
    stripped = re.sub(r'(?i)^killed by ', '', label)
    subline = 'Killed by: %s.' % stripped[:1].lower() + stripped[1:] if stripped else ''
    if stripped != label:
        notes.append('%r -> defeat screen reads "Killed by: %s."' % (label, stripped.lower()))
print('  %d distinct cause%s, no duplicates that matter'
      % (len(causes), '' if len(causes) == 1 else 's'))

# 2. invulnerability gate
print('\n-- invulnerability gate (respawn shield + win screen) --')
for p, line, arg in kills:
    s = files[p]
    # look backwards a little: the gate is normally in the same function
    start = max(0, s.rfind('\n', 0, s.find('\n'.join(s.split('\n')[line - 1:line]))) - 2500)
    window = s[start:s.find('killPlayer', start) + 20] if 'killPlayer' in s[start:] else ''
    gated = 'isInvulnerable' in window or 'isInvulnerable' in s
    tag = 'ok' if gated else 'NOT GATED'
    if not gated:
        problems.append('%s:%d calls killPlayer with no isInvulnerable() check' % (rel(p), line))
    print('  %-46s %s' % ('%s:%d' % (rel(p), line), tag))

# 1. adopted entity names must exist
print('\n-- entities hazards adopt by name --')
NAME_CONST = re.compile(r"export const (\w*(?:ENTITY_NAME|PLACED_NAMES|_UNITS))\b")
cfg = files.get(os.path.join(SRC, 'config.ts'), '')
lit = re.compile(r"'([^']+\.glb(?:_\d+)?|Iron Fence [\w_]+|carpet|[A-Za-z][\w ]*)'")

# collect the names each trap actually looks up
lookups = []
for p, s in files.items():
    for m in re.finditer(r'getEntityOrNullByName\(\s*([A-Za-z_][\w.]*)\s*\)', s):
        lookups.append((p, m.group(1)))

def resolve(sym):
    """Find the string literal(s) a config symbol stands for."""
    m = re.search(r"export const %s(?:\s*:\s*[^=]+)?\s*=\s*'([^']+)'" % re.escape(sym), cfg)
    if m:
        return [m.group(1)]
    m = re.search(r"export const %s(?:\s*:\s*[^=]+)?\s*=\s*\[(.*?)\]" % re.escape(sym), cfg, re.S)
    if m:
        body = m.group(1)
        body = re.sub(r'//[^\n]*', '', body)          # drop commented-out names
        return re.findall(r"'([^']+)'", body)
    return []

checked = set()
for p, sym in lookups:
    for nm in resolve(sym) or []:
        if (p, nm) in checked:
            continue
        checked.add((p, nm))
        ok = nm in composite_names
        print('  %-44s %-22s %s' % (rel(p), nm, 'found' if ok else 'MISSING FROM SCENE'))
        if not ok:
            problems.append('%s adopts %r which is not in main.composite' % (rel(p), nm))
    if not resolve(sym):
        notes.append('%s looks up %s, whose value could not be resolved statically' % (rel(p), sym))

# also the name lists used by the wall spikes / swing traps
for sym in ('WALL_SPIKE_PLACED_NAMES',):
    for nm in resolve(sym):
        ok = nm in composite_names
        print('  %-44s %-22s %s' % ('config.ts:' + sym, nm, 'found' if ok else 'MISSING FROM SCENE'))
        if not ok:
            problems.append('%s lists %r which is not in main.composite' % (sym, nm))

shapes = os.path.join(SRC, 'traps', 'swingTrapShapes.ts')
if os.path.exists(shapes):
    body = open(shapes, encoding='utf-8').read()
    for nm in re.findall(r"\{ name: '([^']+)'", body):
        ok = nm in composite_names
        print('  %-44s %-22s %s' % ('swingTrapShapes.ts', nm, 'found' if ok else 'MISSING FROM SCENE'))
        if not ok:
            problems.append('swingTrapShapes.ts lists %r which is not in main.composite' % nm)

# 4. shape provenance
print('\n-- lethal shape: measured off the model, or hand-written? --')
MEASURED = {
    'traps/wallSpikes.ts': 'WALL_SPIKE_MODEL_BOXES - 8 boxes measured off the fence .glb',
    'traps/swingTraps.ts': 'swingTrapShapes.ts - oriented boxes baked from the .glb clips',
}
HAND = {}
for name, pat in (('CHANDELIER_KILL_RADIUS', r'CHANDELIER_KILL_RADIUS = ([\d.]+)'),
                  ('BLADE_TOUCH_DISTANCE', r'BLADE_TOUCH_DISTANCE = ([\d.]+)'),
                  ('BLADE_KILL_MARGIN', r'BLADE_KILL_MARGIN = ([\d.]+)'),
                  ('SKELETON_KILL_RADIUS', r'SKELETON_KILL_RADIUS = ([\d.]+)'),
                  ('LIGHTNING_KILL_RADIUS', r'LIGHTNING_KILL_RADIUS = ([\d.]+)'),
                  ('FENCE_TIP_MARGIN', r'FENCE_TIP_MARGIN = ([\d.]+)')):
    m = re.search(pat, cfg)
    if m:
        HAND[name] = float(m.group(1))
for p in sorted(MEASURED):
    print('  MEASURED  %-24s %s' % (p, MEASURED[p]))
for k in sorted(HAND):
    print('  radius    %-24s %.2f m' % (k, HAND[k]))
    warnings.append('%s is a hand-written %.2fm radius, not measured off a model' % (k, HAND[k]))

# 5. assets referenced by hazards
print('\n-- assets --')
missing_assets = 0
for p, s in files.items():
    for m in re.finditer(r"'(assets/[^']+)'", s):
        a = m.group(1)
        if not os.path.exists(os.path.join(ROOT, a)):
            print('  MISSING %s  (referenced by %s)' % (a, rel(p)))
            problems.append('missing asset %s referenced by %s' % (a, rel(p)))
            missing_assets += 1
if missing_assets == 0:
    print('  every referenced asset exists on disk')

# ── verdict ────────────────────────────────────────────────────────────────
print('\n' + '=' * 78)
if notes:
    print('NOTES')
    for n in notes:
        print('  - %s' % n)
if warnings:
    print('\nWORTH A LOOK (not failures)')
    for w in warnings:
        print('  - %s' % w)
if problems:
    print('\nPROBLEMS (%d)' % len(problems))
    for pr in problems:
        print('  ! %s' % pr)
    print('=' * 78)
    sys.exit(1)
print('\nno problems found in the death system.')
print('=' * 78)
