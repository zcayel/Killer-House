"""Verify the DEATH REPLAY covers the whole scene, not just the player.

WHY THIS EXISTS. The replay used to record only the player and let the world
run live behind the ghost, so a recap of an axe kill showed a ghost walking to
a spot and falling over with nothing near it. Fixing that means every hazard
now has to carry a handle the replay can grab (src/effects/replayStage.ts):

  * a CUE   - it reports when it fires and can be reset and fired again
              (swing traps, wall spikes, lightning: baked clips / fixed timers)
  * an EXTRA- its Transform is sampled and puppeted back
              (skeletons: this scene writes their position itself)
  * NOTHING - deliberately, with a reason recorded below

The failure this guards against is silent and specific: someone adds a hazard,
it kills the player, and its recap shows the ghost dying of nothing. Nothing
throws, no gate goes red, and the only symptom is a replay that looks broken.
So the rule is that a module calling killPlayer() must appear in COVERAGE with
a decision written down - adding a trap forces you to make that decision.

There is no Node here, so this is a source-text check like every other tool in
this folder, not a runtime test.

    python tools/verify_replay.py

Exit 1 on any failure.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'src')
STAGE = 'src/effects/replayStage.ts'
CAM = 'src/effects/deathCam.ts'
EFFECTS = 'src/effects/deathEffects.ts'

# Every module that can kill the player, and how its recap is staged.
# 'cue'   - registers a ReplayActor and reports when it fires
# 'extra' - registers a replay extra and stands its own systems down
# a string- deliberately nothing; the string is why, and it has to stay true
COVERAGE = {
    'src/traps/swingTraps.ts': 'cue',
    'src/traps/wallSpikes.ts': 'cue',
    'src/lightning.ts': 'cue',
    'src/enemies/skeletons.ts': 'extra',
    'src/traps/fallDeath.ts':
        'the fall IS the player track - the ghost falls, nothing else moves',
    'src/traps/fenceTips.ts':
        'static geometry - the ghost walks onto it, there is nothing to re-fire',
    'src/traps/chandelierCrush.ts':
        'a Creator Hub smart item on core::Tween; the tween owns its Transform '
        'every frame, so it can be neither cued nor puppeted',
}

# The stage lifecycle. deathCam drives all of it; a half-wired refactor that
# records but never plays back (or plays back but never resets) is exactly the
# kind of thing that reads fine in a diff.
LIFECYCLE = [
    'stageAdvance',   # the shared clock
    'stageSample',    # extras, in lockstep with the player samples
    'stageWipe',      # respawn
    'stageFreeze',    # death
    'stageBegin',     # press
    'stageTick',      # per frame
    'stageEnd',       # release
    'stageClear',     # round reset
]

problems = []
notes = []


def read(rel):
    path = os.path.join(ROOT, rel.replace('/', os.sep))
    if not os.path.exists(path):
        problems.append(f'{rel} is missing')
        return ''
    with open(path, encoding='utf-8') as fh:
        return fh.read()


def strip_comments(text):
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    return re.sub(r'(?m)^\s*//.*$', '', text)


sources = {}
for dirpath, _, names in os.walk(SRC):
    for n in names:
        if not n.endswith(('.ts', '.tsx')):
            continue
        full = os.path.join(dirpath, n)
        rel = os.path.relpath(full, ROOT).replace('\\', '/')
        with open(full, encoding='utf-8') as fh:
            sources[rel] = fh.read()

# ── 1. every kill path has a decision ───────────────────────────────────────
killers = sorted(
    rel for rel, text in sources.items()
    if rel != 'src/gameState.ts' and re.search(r'\bkillPlayer\(', strip_comments(text))
)

print('-- kill paths and how the recap stages them --')
for rel in killers:
    how = COVERAGE.get(rel)
    if how is None:
        problems.append(
            f'{rel} calls killPlayer() but is not in COVERAGE - decide whether its '
            f'recap needs a cue, an extra, or neither, and record it in this file'
        )
        print(f'  UNDECIDED  {rel}')
        continue
    label = how if how in ('cue', 'extra') else 'none'
    print(f'  {label:<10} {rel}' + ('' if label != 'none' else f'  ({how})'))

for rel in COVERAGE:
    if rel not in killers:
        notes.append(f'{rel} is listed in COVERAGE but no longer calls killPlayer()')

# ── 2. cue modules actually record AND can be fired again ───────────────────
for rel, how in COVERAGE.items():
    text = strip_comments(sources.get(rel, ''))
    if how == 'cue':
        if 'recordHazardEvent(' not in text:
            problems.append(f'{rel} is a cue hazard but never calls recordHazardEvent()')
        if 'registerReplayActor(' not in text:
            problems.append(f'{rel} is a cue hazard but never calls registerReplayActor()')
    elif how == 'extra':
        if 'registerReplayExtra(' not in text:
            problems.append(f'{rel} is an extra but never calls registerReplayExtra()')
        if 'replayIsPlaying()' not in text:
            problems.append(
                f'{rel} is an extra but never checks replayIsPlaying() - its own systems '
                f'would keep writing the Transform the replay is puppeting'
            )
    else:
        if 'replayStage' in text:
            problems.append(
                f'{rel} is recorded as staging nothing ("{how}") but imports replayStage - '
                f'update COVERAGE to say what it does now'
            )

# ── 3. every cue key that is recorded can also be fired ─────────────────────
# Keys are computed (replayKey(name), unit.key, REPLAY_KEY), so this matches the
# EXPRESSION rather than the string: a hazard that records under one and
# registers under another is the bug worth catching, and it shows up textually.
print()
print('-- cue keys: recorded vs registered --')
for rel, how in COVERAGE.items():
    if how != 'cue':
        continue
    text = strip_comments(sources.get(rel, ''))
    # An identifier, optionally followed by ONE parenthesised argument group:
    # matches REPLAY_KEY, unit.key and replayKey(u.name) alike. A plain
    # non-greedy match stops at the inner ')' and mangles the last of those.
    arg = r'((?:[A-Za-z0-9_.\[\]]+)(?:\([^()]*\))?)'
    recorded = set(re.findall(r'recordHazardEvent\(\s*' + arg, text))
    registered = set(re.findall(r'registerReplayActor\(\s*' + arg, text))

    # replayKey(u.name) and replayKey(name) are the same key through the same
    # helper, and unit.key is the same field as key. Compare on the shape.
    def norm(k):
        return re.sub(r'\([^()]*\)', '()', k).replace('unit.', '')
    rec = {norm(k) for k in recorded}
    reg = {norm(k) for k in registered}
    print(f'  {rel}')
    print(f'      records   {sorted(rec)}')
    print(f'      registers {sorted(reg)}')
    for k in rec - reg:
        problems.append(f'{rel} records cue {k} but never registers an actor for it')
    for k in reg - rec:
        problems.append(f'{rel} registers actor {k} but nothing ever records that cue')

# ── 4. the stage lifecycle is fully wired to the cam ────────────────────────
stage_src = read(STAGE)
cam_src = strip_comments(read(CAM))
print()
print('-- stage lifecycle --')
for fn in LIFECYCLE:
    if f'export function {fn}(' not in stage_src:
        problems.append(f'{STAGE} does not export {fn}()')
        continue
    if not re.search(rf'\b{fn}\(', cam_src):
        problems.append(f'{CAM} never calls {fn}() - the replay is only half wired')
        continue
    print(f'  ok  {fn}')

# Two calls the loop above cannot tell apart from their harmless siblings.
#
# stageTick is called TWICE - once with 0 to seed the opening frame, once per
# frame with the playhead - so "is stageTick called anywhere" passes even with
# the per-frame one deleted, which is a replay where no cue ever fires. Ask for
# the one that matters. (This gap was found by deleting the line and watching
# the gate stay green.)
if not re.search(r'stageTick\(\s*playhead\s*\)', cam_src):
    problems.append(
        f'{CAM} never ticks the stage on the playhead - the hazards would be reset and '
        f'then never fired, which is the bug this whole feature exists to fix'
    )

# The stage has to be told the sample times, or every cue lands on the wrong
# frame. Cheap to check, and it is the one argument that is easy to drop.
if not re.search(r'stageFreeze\(\s*recording\.map', cam_src):
    problems.append(f'{CAM} calls stageFreeze() without handing it the sample timestamps')

# ── 5. the recap leaves the live world where it found it ────────────────────
# Puppeting an extra and then just letting go strands it at the end of the
# recording: watching a recap would teleport every skeleton in the scene back
# to where it stood at a death that is long over. stageBegin has to snapshot
# and stageEnd has to write it back.
print()
print('-- the recap must not move the live world --')
def body_of(src, name):
    """The text of one exported function, up to the next export."""
    head = 'export function ' + name + '('
    i = src.find(head)
    if i < 0:
        return ''
    j = src.find('export function ', i + len(head))
    return src[i:] if j < 0 else src[i:j]


begin_src = body_of(stage_src, 'stageBegin')
end_src = body_of(stage_src, 'stageEnd')
world_checks = [
    ('stageBegin snapshots where the extras actually are',
     'held = extras.map(' in begin_src),
    ('stageEnd writes those poses back',
     'held[k].p' in end_src),
    ('stageEnd rests the hazards it fired',
     '.reset()' in end_src),
]
for label, ok in world_checks:
    print(f'  {"ok " if ok else "FAIL"} {label}')
    if not ok:
        problems.append(f'the recap would change the live world: {label}')

# ── 6. no tombstone in the recap ────────────────────────────────────────────
# The other half of the request: graves are hidden for the length of the shot
# and the recap raises its own stone on the frame of the hit.
print()
print('-- tombstones --')
fx = strip_comments(read(EFFECTS))
checks = [
    ('graves hide while the recap is up',
     re.search(r'gravesHidden\s*!==\s*deathCamActive', fx) is not None),
    ('hiding is local, via VisibilityComponent (never a synced component)',
     'VisibilityComponent.createOrReplace(grave' in fx),
    ('the hover hitbox goes with them',
     re.search(r'MeshCollider\.setBox\(hitbox,.*CL_NONE', fx) is not None),
    ('the recap is told which headstone this death left',
     'setReplayStoneModel(' in fx),
    ('the recap raises its own stone at the death, not before',
     re.search(r'playhead >= death\b', cam_src) is not None),
]
for label, ok in checks:
    print(f'  {"ok " if ok else "FAIL"} {label}')
    if not ok:
        problems.append(f'tombstone rule broken: {label}')

# Nothing may write a synced tombstone component to hide it - that would blank
# the grave on every other player's screen too.
for bad in re.findall(r'(?m)^.*Transform\.getMutable\(grave\).*$', fx):
    problems.append(f'tombstone hiding writes a SYNCED component: {bad.strip()}')

# ── report ──────────────────────────────────────────────────────────────────
print()
print('=' * 78)
if notes:
    print('NOTES')
    for n in notes:
        print(f'  - {n}')
    print()
if problems:
    print('PROBLEMS')
    for p in problems:
        print(f'  - {p}')
    print('=' * 78)
    sys.exit(1)
print('the death replay stages every kill path, and no grave stands in the recap.')
print('=' * 78)
