"""Find identifiers used but never declared or imported.

WHY THIS EXISTS. There is no Node here, so tsc never runs, and the SDK
transpiles without typechecking — an unbound name is a clean compile and a
ReferenceError at runtime. Worse, systems are wrapped in safeSystem(), which
logs the throw ONCE and then suppresses it, so the symptom is "that trap
silently does nothing" rather than a stack trace.

It has shipped twice:

  * swingTraps.ts  `model is not defined`  — refreshArmBounds() was extracted
    out of adopt() and kept a reference to adopt's `model` parameter. No trap
    was ever adopted; the axes just never moved.
  * fenceTips.ts   `Vector3 is not defined` — a debug overlay used Vector3
    without the module importing it. The fence kill died every frame.

tools/audit.py checks imports RESOLVE (the module exports what you asked for).
It cannot see this, which is about whether a name is in scope where it is used.

THE RULE, kept deliberately narrow to stay quiet: any identifier immediately
followed by a dot must be resolvable — as an import, a file-level declaration,
a parameter or local of the enclosing function, or a known global. Property
accesses, object keys, strings, comments and type positions are all skipped, so
`a.b.c` only ever asks about `a`.

    python tools/check_undefined.py

Exit 1 if anything is unresolved.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'src')

GLOBALS = {
    'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date',
    'Map', 'Set', 'Promise', 'console', 'globalThis', 'Error', 'RegExp',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'undefined', 'null',
    'this', 'super', 'window', 'document', 'module', 'exports', 'require',
    'Symbol', 'BigInt', 'WeakMap', 'WeakSet', 'Infinity', 'NaN', 'process',
}

BLOCK = re.compile(r'/\*.*?\*/', re.S)
LINEC = re.compile(r'//[^\n]*')
SQ = re.compile(r"'(?:\\.|[^'\\\n])*'")
DQ = re.compile(r'"(?:\\.|[^"\\\n])*"')
BQ = re.compile(r'`(?:\\.|[^`\\])*`')


def strip(src):
    """Remove comments and string bodies, preserving line count."""
    def keep_nl(m):
        return '\n' * m.group(0).count('\n')
    src = BLOCK.sub(keep_nl, src)
    src = LINEC.sub('', src)
    src = SQ.sub("''", src)
    src = DQ.sub('""', src)
    src = BQ.sub(lambda m: '``' + '\n' * m.group(0).count('\n'), src)
    return src


def imported_names(src):
    out = set()
    # `import { X } from` AND `import Default, { X } from` — the second form
    # is what `import ReactEcs, { ReactEcsRenderer }` in ui.tsx uses, and
    # missing it reported ReactEcsRenderer as unbound.
    for m in re.finditer(r'import\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from',
                         src, re.S):
        for part in m.group(1).split(','):
            part = part.strip()
            if not part:
                continue
            if ' as ' in part:
                part = part.split(' as ')[-1].strip()
            out.add(part)
    for m in re.finditer(r'import\s+(\w+)\s*(?:,|from)', src):
        out.add(m.group(1))
    for m in re.finditer(r'import\s+\*\s+as\s+(\w+)', src):
        out.add(m.group(1))
    return out


DECL = re.compile(r'\b(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)')


def declared_names(src):
    """Every name declared anywhere in the file, at any depth."""
    out = set(m.group(1) for m in DECL.finditer(src))
    # destructuring: const { a, b } = ... / const [a, b] = ...
    for m in re.finditer(r'\b(?:const|let|var)\s*[\{\[]([^\}\]]*)[\}\]]\s*=', src):
        for part in re.split(r'[,:]', m.group(1)):
            part = part.strip().lstrip('.')
            if re.fullmatch(r'[A-Za-z_$][\w$]*', part or ''):
                out.add(part)
    # for (const [a, b] of ...) / for (const { a } of ...) — binds without an
    # `=`, which the destructuring pattern above requires. candles.ts uses
    # `for (const [ent, name] of engine.getEntitiesWith(Name))`.
    for m in re.finditer(r'\bfor\s*\(\s*(?:const|let|var)\s*[\{\[]([^\}\]]*)[\}\]]\s*(?:of|in)\b',
                         src):
        for part in re.split(r'[,:]', m.group(1)):
            part = part.strip().lstrip('.')
            if re.fullmatch(r'[A-Za-z_$][\w$]*', part or ''):
                out.add(part)
    # for (const x of ...)
    out |= set(re.findall(r'\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+(?:of|in)\b', src))

    # catch (err)
    out |= set(re.findall(r'\bcatch\s*\(\s*([A-Za-z_$][\w$]*)', src))
    return out


FUNC = re.compile(
    r'\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)')


def params_of(sig):
    out = set()
    for part in sig.split(','):
        part = part.split(':')[0].split('=')[0].strip()
        part = part.lstrip('.').strip()
        if re.fullmatch(r'[A-Za-z_$][\w$]*', part or ''):
            out.add(part)
    return out


# An identifier followed by a dot, not itself preceded by a dot or a word char.
DOTTED = re.compile(r'(?<![\w$.])([A-Za-z_$][\w$]*)\s*\.')


def check(path):
    raw = open(path, encoding='utf-8').read()
    src = strip(raw)
    known = imported_names(raw) | declared_names(src) | GLOBALS

    # Names bound by ANY arrow/callback param anywhere in the file. Scoping
    # these precisely needs a real parser; collecting them file-wide only
    # weakens the check, never produces a false alarm.
    for m in re.finditer(r'\(([^()]*)\)\s*=>', src):
        known |= params_of(m.group(1))
    for m in re.finditer(r'(?<![\w$])([A-Za-z_$][\w$]*)\s*=>', src):
        known.add(m.group(1))
    for m in FUNC.finditer(src):
        known |= params_of(m.group(2))
    # class methods and object-literal shorthand methods
    for m in re.finditer(r'(?<![\w$])([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{', src):
        known |= params_of(m.group(2))

    bad = []
    for m in DOTTED.finditer(src):
        name = m.group(1)
        if name in known or name in GLOBALS:
            continue
        if re.fullmatch(r'\d.*', name):
            continue
        line = src.count('\n', 0, m.start()) + 1
        bad.append((line, name, raw.split('\n')[line - 1].strip()[:88]))
    return bad


def main():
    problems = []
    files = 0
    for root, _d, fs in os.walk(SRC):
        for f in sorted(fs):
            if not f.endswith(('.ts', '.tsx')):
                continue
            path = os.path.join(root, f)
            files += 1
            for line, name, text in check(path):
                rel = os.path.relpath(path, ROOT).replace(os.sep, '/')
                problems.append((rel, line, name, text))

    print('checked %d source files for unbound identifiers' % files)
    if not problems:
        print('\nPASS - every dotted identifier resolves to an import, a '
              'declaration or a known global.')
        return
    print('\nFAIL - used but never declared or imported:\n')
    for rel, line, name, text in problems:
        print('  %s:%d  %s' % (rel, line, name))
        print('      %s' % text)
    print('\n%d unresolved. Each is a ReferenceError at runtime — and inside a'
          % len(problems))
    print('system it is logged once by safeSystem and then suppressed forever.')
    sys.exit(1)


if __name__ == '__main__':
    main()
