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

CALLS WERE ADDED AFTER THE DOTTED RULE MISSED ONE. A region edit deleted
buildAvatar() out of deathCam.ts and this script still reported PASS, because
the only surviving reference was a BARE CALL with no dot near it. The symptom
was a ReferenceError inside an onMouseDown handler — exactly the silent-failure
class this file exists to prevent, walking straight past the gate.

THE RULE, kept deliberately narrow to stay quiet: any identifier immediately
followed by a dot OR by a call paren must be resolvable — as an import, a file-level declaration,
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
    # Supplied by the Decentraland scene runtime rather than imported —
    # `declare function fetch` / `declare class WebSocket` in
    # node_modules/@dcl/js-runtime/index.d.ts. They look unbound to this
    # checker for the same reason `console` does, and are just as real.
    'fetch', 'WebSocket', 'Headers', 'Request', 'Response', 'AbortController',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
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
        # OPTIONAL PARAMS. `banner?: ShellBanner` reduces to `banner?`, which
        # fails the identifier match below, so the name never gets bound and
        # every `banner.x` in the body reports as unresolved. It went unnoticed
        # while the only optional param in the codebase was used as a bare
        # value; the first `optional.property` access lit up seven false
        # positives at once.
        part = part.rstrip('?')
        if re.fullmatch(r'[A-Za-z_$][\w$]*', part or ''):
            out.add(part)
    return out


# An identifier followed by a dot, not itself preceded by a dot or a word char.
DOTTED = re.compile(r'(?<![\w$.])([A-Za-z_$][\w$]*)\s*\.')


# An identifier followed by a call paren. `a.b()` is excluded by the same
# preceding-dot guard the DOTTED rule uses, so this only ever asks about BARE
# calls — which is the case that slipped through and shipped a ReferenceError.
CALLED = re.compile(r'(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(')

# Words that take a paren but are not calls. Without these, every `if (`,
# `catch (` and `return (` in the codebase reports as an unbound function and
# the whole check becomes noise nobody reads.
NOT_CALLS = {
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
    'new', 'do', 'else', 'await', 'yield', 'delete', 'void', 'in', 'of',
    'instanceof', 'case', 'throw', 'export', 'import', 'as', 'constructor',
    'get', 'set', 'async', 'declare', 'is', 'keyof', 'satisfies',
}


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
    # class methods and object-literal shorthand methods. The NAME is bound as
    # well as the params: `emit(kind: string) {` inside an object literal is a
    # definition, and the bare-call rule would otherwise report every one of
    # them as an unbound function.
    for m in re.finditer(r'(?<![\w$])([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{', src):
        known.add(m.group(1))
        known |= params_of(m.group(2))

    bad = []
    for rx, skip in ((DOTTED, frozenset()), (CALLED, NOT_CALLS)):
        for m in rx.finditer(src):
            name = m.group(1)
            if name in known or name in GLOBALS or name in skip:
                continue
            if re.fullmatch(r'\d.*', name):
                continue
            line = src.count('\n', 0, m.start()) + 1
            bad.append((line, name, raw.split('\n')[line - 1].strip()[:88]))
    bad.sort()
    return bad



# ── unterminated string literals ───────────────────────────────────────────
#
# A quote opened and never closed on the same line. TypeScript rejects it, but
# it is invisible to audit.py (which never parses) and it silently DEFEATS the
# unbound-identifier scan above: strip() cannot match the broken literal, so
# everything after it is misread as code.
#
# It shipped once. A generated edit put a real newline inside quotes:
#     value: deathRecapLines().join('
#     '),
# which is `Unterminated string literal` and stops the preview from starting.
#
# Template literals are exempt — backticks legitimately span lines.
NL = chr(10)
# NOT named SQ/DQ: those are already the compiled single/double-quoted-string
# regexes above, and shadowing them replaces a pattern object with a one-character
# string. strip() then dies on SQ.sub() and takes the whole unbound-identifier
# scan down with it - the gate reports a crash instead of a result.
QUOTE_CHARS = (chr(39), chr(34))
BACKSLASH = chr(92)


def open_quote(line):
    """The quote character still open at the end of `line`, or None.

    COUNTING QUOTES IS NOT ENOUGH, which is how this produced its first false
    alarm. The old test asked whether each quote character appeared an odd
    number of times, and that cannot tell an apostrophe INSIDE a double-quoted
    string from an opening single quote:

        value: "This house isn't just haunted"

    is perfectly valid, has two double quotes and one single, and was reported
    as an unterminated literal. Any English contraction in a double-quoted
    string hit it.

    Walking the line and tracking WHICH quote is currently open costs a few
    lines and gets both cases right: the apostrophe above is just a character
    inside an open double quote, while a literal that really does run off the
    end of its line still comes back with a quote left open. Backslash skips
    the next character, so an escaped quote neither opens nor closes.
    """
    q = None
    i = 0
    n = len(line)
    while i < n:
        c = line[i]
        if c == BACKSLASH:
            i += 2
            continue
        if q is None:
            if c in QUOTE_CHARS:
                q = c
        elif c == q:
            q = None
        i += 1
    return q


def unterminated_strings(path):
    """Lines that end with a quote still open, ignoring comments and backticks."""
    out = []
    raw = open(path, encoding='utf-8').read()
    lines = raw.split(NL)
    # Blank out block comments and template literals first — both legitimately
    # span lines, and counting quotes inside either produces false alarms.
    masked = BLOCK.sub(lambda m: NL * m.group(0).count(NL), raw)
    masked = BQ.sub(lambda m: '``' + NL * m.group(0).count(NL), masked)
    for i, line in enumerate(masked.split(NL), 1):
        line = LINEC.sub('', line)
        if open_quote(line) is not None:
            out.append((i, lines[i - 1].strip()[:88]))
    return out


# ---- uiTransform fields used as JSX attributes ----------------------------
#
# react-ecs UiEntity takes a small set of props - uiTransform, uiBackground,
# uiText, uiInput, uiDropdown, key and the onMouse* handlers. Everything else is
# treated as an unknown component and run through upsertComponent, which does
# `'onChange' in value`. When the value is a string that throws
#
#     TypeError: Cannot use 'in' operator to search for 'onChange' in none
#
# and it does NOT fail politely: the throw propagates through the whole React
# tree, so ONE misplaced attribute blanks the ENTIRE UI, every frame, forever.
#
# It shipped exactly once, as `pointerFilter="none"` on a UiEntity instead of
# `uiTransform={{ pointerFilter: 'none' }}` - a one-character-class mistake that
# reads perfectly fine in a diff. tsc would not catch it either, since the props
# type is permissive.
#
# So: these names are uiTransform FIELDS. Written with `=` they are attributes,
# and that is always wrong. Written with `:` they are object keys, which is what
# they should be.
UI_TRANSFORM_FIELDS = (
    'pointerFilter', 'positionType', 'flexDirection', 'alignItems', 'alignSelf',
    'justifyContent', 'flexGrow', 'flexShrink', 'flexBasis', 'flexWrap',
    'maxWidth', 'maxHeight', 'minWidth', 'minHeight', 'overflow',
)
UI_ATTR = re.compile(
    r'(?<![\w$.])(' + '|'.join(UI_TRANSFORM_FIELDS) + r")\s*=\s*[\"'{]")


def misplaced_ui_props(path):
    """uiTransform fields written as JSX attributes instead of object keys."""
    out = []
    raw = open(path, encoding='utf-8').read()
    masked = BLOCK.sub(lambda m: NL * m.group(0).count(NL), raw)
    for i, line in enumerate(masked.split(NL), 1):
        line = LINEC.sub('', line)
        for m in UI_ATTR.finditer(line):
            out.append((i, m.group(1), raw.split(NL)[i - 1].strip()[:88]))
    return out


def main():
    problems = []
    files = 0
    for root, _d, fs in os.walk(SRC):
        for f in sorted(fs):
            if not f.endswith(('.ts', '.tsx')):
                continue
            path = os.path.join(root, f)
            files += 1
            rel = os.path.relpath(path, ROOT).replace(os.sep, '/')
            for line, text in unterminated_strings(path):
                problems.append((rel, line, '<unterminated string literal>', text))
            for line, name, text in misplaced_ui_props(path):
                problems.append(
                    (rel, line, '<%s= must be inside uiTransform={{ %s: ... }}>' % (name, name), text))
            for line, name, text in check(path):
                problems.append((rel, line, name, text))

    print('checked %d source files for unbound identifiers' % files)
    if not problems:
        print('\nPASS - every dotted identifier and bare call resolves to an import, a '
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
