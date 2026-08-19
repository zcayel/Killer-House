"""Static consistency audit for the scene's TypeScript sources.

No Node in this environment, so tsc cannot run. This covers the subset of what
tsc would have caught that matters most here — unresolved imports, names
imported but never exported, duplicate exports — plus two classes of bug tsc
would NOT catch at all: asset paths that point at files which don't exist, and
baked-asset constants that have drifted from the asset they describe.
"""
import os
import re
import struct
import sys
import zlib

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.')
SRC = os.path.join(ROOT, 'src')

problems = []
notes = []


def rel(p):
    return os.path.relpath(p, ROOT).replace('\\', '/')


# ── Collect sources ────────────────────────────────────────────────────────
files = []
for dirpath, _, names in os.walk(SRC):
    for n in names:
        if n.endswith(('.ts', '.tsx')):
            files.append(os.path.join(dirpath, n))

text = {f: open(f, encoding='utf-8').read() for f in files}


def strip_code(src):
    """Remove comments and string bodies so scans don't trip on prose."""
    out = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        nx = src[i + 1] if i + 1 < n else ''
        if c == '/' and nx == '/':
            while i < n and src[i] != '\n':
                i += 1
        elif c == '/' and nx == '*':
            i += 2
            while i + 1 < n and not (src[i] == '*' and src[i + 1] == '/'):
                i += 1
            i += 2
        elif c in '"\'`':
            q = c
            out.append(q)
            i += 1
            while i < n:
                if src[i] == '\\':
                    i += 2
                    continue
                if src[i] == q:
                    break
                i += 1
            out.append(q)
            i += 1
        else:
            out.append(c)
            i += 1
    return ''.join(out)


code = {f: strip_code(t) for f, t in text.items()}

# ── Exports per module ─────────────────────────────────────────────────────
EXPORT_RE = re.compile(
    r'^export\s+(?:declare\s+)?'
    r'(?:(?:const|let|var|function|class|abstract\s+class|type|interface|enum)\s+)?'
    r'([A-Za-z_$][\w$]*)',
    re.M)
EXPORT_LIST_RE = re.compile(r'^export\s*\{([^}]*)\}', re.M)

exports = {}
for f, c in code.items():
    names = set()
    for m in EXPORT_RE.finditer(c):
        names.add(m.group(1))
    for m in EXPORT_LIST_RE.finditer(c):
        for part in m.group(1).split(','):
            part = part.strip()
            if not part:
                continue
            names.add(part.split(' as ')[-1].strip())
    names.discard('default')
    exports[f] = names

# duplicate top-level export names inside one module
for f, c in code.items():
    seen = {}
    for m in EXPORT_RE.finditer(c):
        nm = m.group(1)
        if nm in ('default',):
            continue
        seen.setdefault(nm, []).append(c[:m.start()].count('\n') + 1)
    for nm, lines in seen.items():
        if len(lines) > 1:
            problems.append(f'DUPLICATE EXPORT  {rel(f)}: `{nm}` exported at lines {lines}')

# ── Imports ────────────────────────────────────────────────────────────────
IMPORT_RE = re.compile(r'import\s+(type\s+)?([^;]*?)\s+from\s+[\'"]([^\'"]+)[\'"]', re.S)


def resolve(from_file, spec):
    if not spec.startswith('.'):
        return None  # package import, out of scope
    base = os.path.normpath(os.path.join(os.path.dirname(from_file), spec))
    for cand in (base + '.ts', base + '.tsx',
                 os.path.join(base, 'index.ts'), os.path.join(base, 'index.tsx')):
        if os.path.isfile(cand):
            return cand
    return False  # local but missing


unused_by_file = {}
for f, c in code.items():
    body_after = c
    for m in IMPORT_RE.finditer(c):
        clause, spec = m.group(2), m.group(3)
        target = resolve(f, spec)
        if target is False:
            problems.append(f'UNRESOLVED IMPORT  {rel(f)}: "{spec}" does not resolve to a file')
            continue

        named = re.search(r'\{([^}]*)\}', clause, re.S)
        names = []
        if named:
            for part in named.group(1).split(','):
                part = part.strip()
                if part:
                    names.append(part.split(' as ')[-1].strip())
        # default / namespace binding
        head = clause.split('{')[0].strip().rstrip(',').strip()
        if head and not head.startswith('*'):
            names.append(head)

        if target:
            for nm in names:
                if nm in ('type',):
                    continue
                if nm not in exports[target]:
                    problems.append(
                        f'MISSING EXPORT    {rel(f)}: imports `{nm}` from "{spec}" '
                        f'but {rel(target)} does not export it')

        # usage check: does the name appear anywhere outside its own import line?
        rest = c[:m.start()] + c[m.end():]
        for nm in names:
            if not re.search(r'\b' + re.escape(nm) + r'\b', rest):
                unused_by_file.setdefault(rel(f), []).append(f'{nm} (from "{spec}")')

# ── Asset paths referenced from code vs files on disk ──────────────────────
ASSET_RE = re.compile(r'[\'"]((?:assets|models|images)/[^\'"]+\.(?:glb|gltf|png|jpg|jpeg|mp3|wav|ogg))[\'"]', re.I)
seen_assets = set()
for f, t in text.items():
    for m in ASSET_RE.finditer(t):
        p = m.group(1)
        if p in seen_assets:
            continue
        seen_assets.add(p)
        if not os.path.isfile(os.path.join(ROOT, p.replace('/', os.sep))):
            problems.append(f'MISSING ASSET     {rel(f)}: "{p}" is referenced but not on disk')

# ── Baked-asset constants vs the actual images ─────────────────────────────
def png_size(path):
    with open(path, 'rb') as fh:
        d = fh.read(33)
    if d[:8] != b'\x89PNG\r\n\x1a\n':
        return None
    return struct.unpack('>II', d[16:24])


def const_value(name):
    for f, c in code.items():
        m = re.search(r'export\s+const\s+' + name + r'\s*=\s*([^\n]+)', c)
        if m:
            return m.group(1).strip().rstrip(',')
    return None


title_png = os.path.join(ROOT, 'assets', 'scene', 'Textures', 'title_killer_house.png')
if os.path.isfile(title_png):
    w, h = png_size(title_png)
    expr = const_value('KILLER_HOUSE_TITLE_ASPECT')
    if expr:
        m = re.match(r'(\d+)\s*/\s*(\d+)', expr)
        if m:
            cw, ch = int(m.group(1)), int(m.group(2))
            if (cw, ch) != (w, h):
                problems.append(
                    f'ASSET DRIFT       KILLER_HOUSE_TITLE_ASPECT is {cw}/{ch} '
                    f'but title_killer_house.png is {w}x{h}')
            else:
                notes.append(f'title aspect {cw}/{ch} matches the PNG ({w}x{h})')

flip_png = os.path.join(ROOT, 'assets', 'scene', 'Textures', 'lightning_flipbook.png')
if os.path.isfile(flip_png):
    w, h = png_size(flip_png)
    g = const_value('LIGHTNING_FLIPBOOK_GRID')
    if g and g.split()[0].isdigit():
        gi = int(g.split()[0])
        if w % gi or h % gi:
            problems.append(f'ASSET DRIFT       lightning atlas {w}x{h} is not divisible by GRID {gi}')
        elif w != h:
            problems.append(f'ASSET DRIFT       lightning atlas {w}x{h} is not square; UV stepper assumes it is')
        else:
            notes.append(f'lightning atlas {w}x{h} divides evenly by GRID {gi} ({w // gi}px cells)')

# ── Report ─────────────────────────────────────────────────────────────────
print(f'audited {len(files)} source files under {rel(SRC)}\n')
if problems:
    print(f'--- {len(problems)} PROBLEM(S) ---')
    for p in problems:
        print(' ', p)
else:
    print('--- no unresolved imports, missing exports, missing assets or asset drift ---')

if unused_by_file:
    total = sum(len(v) for v in unused_by_file.values())
    print(f'\n--- {total} unused import(s) (not fatal: noUnusedLocals is off) ---')
    for f in sorted(unused_by_file):
        print(f'  {f}: ' + ', '.join(unused_by_file[f]))

if notes:
    print('\n--- verified ---')
    for n in notes:
        print(' ', n)

sys.exit(1 if problems else 0)
