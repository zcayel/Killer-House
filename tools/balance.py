"""Crude bracket-balance check for TS/TSX. No Node here, so this is the cheapest
signal that an edit didn't lose a brace. Strips comments and string literals
with a hand-rolled scanner (regex can't nest), then counts."""
import sys


def strip(src: str) -> str:
    out = []
    i = 0
    n = len(src)
    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ''
        if c == '/' and nxt == '/':
            while i < n and src[i] != '\n':
                i += 1
        elif c == '/' and nxt == '*':
            i += 2
            while i + 1 < n and not (src[i] == '*' and src[i + 1] == '/'):
                i += 1
            i += 2
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
            out.append(c)
            i += 1
    return ''.join(out)


bad = 0
for f in sys.argv[1:]:
    s = strip(open(f, encoding='utf-8').read())
    b = s.count('{') - s.count('}')
    p = s.count('(') - s.count(')')
    k = s.count('[') - s.count(']')
    flag = '' if (b == 0 and p == 0 and k == 0) else '   <-- UNBALANCED'
    if flag:
        bad += 1
    print(f'{f:36s} braces {b:+d}  parens {p:+d}  brackets {k:+d}{flag}')
sys.exit(1 if bad else 0)
