/**
 * THE BOARDS — two rankings, drawn entirely in code.
 *
 * WE BUILD OUR OWN BOARD NOW. It used to render onto leadboard.glb's baked art
 * (a 736x1104 JPEG on a `leader board` quad), which meant every column had to be
 * measured against a texture this file could not see, and the plate art dictated
 * the layout. That cost us the "zCayel (you)1:08" overlap and squeezed names
 * down to nine characters once hearts needed a column.
 *
 * The placed entity is still used, for exactly two things: WHERE the board is
 * and HOW BIG it is. Its GltfContainer is removed on adoption, so the old art
 * stops rendering and what remains is an invisible anchor you can still drag and
 * spin in Creator Hub — everything here is a child of it, so nothing needs
 * re-measuring when it moves. Delete the model from the scene and the board
 * falls back to nothing rather than drawing in a wrong place.
 *
 * Owning the panel means owning the whole 4.39m of it, so names get 14
 * characters instead of nine, and the rank numerals are drawn rather than baked.
 *
 * TWO SECTIONS. Fastest escapes (name, hearts left, best time) and most deaths.
 * They rank different people on purpose — the quickest escapist is rarely the
 * one who has died most, and both are worth reading.
 *
 * The text is only rewritten when a value actually changes, not every frame.
 */

import {
  engine,
  Transform,
  TextShape,
  Font,
  TextAlignMode,
  Entity,
  MeshRenderer,
  Material,
  GltfContainer
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { escapeRanking, formatTime } from './gameLoop'
import { persistedDeaths } from './scores'
import { ROUND_HEARTS } from './config'
import { addSafeSystem, reportFailure } from './safeSystem'

/**
 * The hand-placed anchor, by Creator Hub name.
 *
 * A LIST, because the name is a hand-typed label in another program and this
 * whole file is dead the moment it stops matching. Add to this rather than
 * editing it, and a rename cannot silently blank the board.
 */
const BOARD_ENTITY_NAMES = ['leadboard.glb', 'leaderboard', 'leaderboard.glb', 'leadboard']

/**
 * Where the board stands when there is NO placed anchor to hang it on.
 *
 * Measured out of main.crdt while the anchor still existed, so deleting
 * leadboard.glb from Creator Hub leaves the board exactly where it was rather
 * than deleting it too. That matters because this file draws every pixel
 * itself now — the model was only ever supplying a position, a rotation and a
 * scale, and all three are just numbers.
 *
 * The scale is not cosmetic: every offset in this file is in the anchor's local
 * space, so the board is 2.22x wider and 2.11x taller in world than the
 * constants above suggest. Reproduce it or the layout silently shrinks.
 *
 * Prefer the placed anchor when one exists — dragging it in Creator Hub stays
 * the easiest way to move the board, and these numbers are only the fallback.
 */
const FALLBACK_POSITION = Vector3.create(4.75, 1.0, 7.156)
const FALLBACK_YAW = -89.7
const FALLBACK_SCALE = Vector3.create(2.22, 2.11, 1.07)

/** Frames to wait for a placed anchor before standing the board up ourselves. */
const ANCHOR_WAIT_FRAMES = 120

/** Places on the escape board. Matches TOP_N on the server, which sends 10. */
const ROWS = 10
/** Places on the deaths board. */
const DEATH_ROWS = 5

// ── PANEL FOOTPRINT ─────────────────────────────────────────────────────────
//
// Kept identical to the art quad inside leadboard.glb so the new board lands
// exactly where the old one was, in the entity's own local space:
//
//   x -2.041 .. 2.346  (4.387m wide)
//   y -0.454 .. 5.130  (5.584m tall)
//
// The quad's normal is (0, 0.03, -1.00) — the face looks down LOCAL -Z, so "in
// front of the board" is more negative z. Text therefore sits at a NEGATIVE
// offset and the backing sits behind it at zero.
const FACE_MIN_X = -2.041
const FACE_MAX_X = 2.346
const FACE_MIN_Y = -0.454
const FACE_MAX_Y = 5.130

const FACE_WIDTH = FACE_MAX_X - FACE_MIN_X
const FACE_HEIGHT = FACE_MAX_Y - FACE_MIN_Y

/**
 * Sideways nudge, in WORLD METRES, positive = the VIEWER'S LEFT.
 *
 * World metres rather than local units because the anchor is scaled (2.22x as
 * placed today), so a local offset means something different every time the
 * board is resized. This is divided by the anchor's live scale at build time,
 * which keeps "half an inch" meaning half an inch.
 *
 * SIGN, derived rather than guessed: the art quad's normal is local -Z, and the
 * anchor is yawed -89.7 degrees, which turns local -Z into world +X. So the
 * board faces +X and a viewer reads it looking down -X; for that viewer, left
 * is world +Z, which is the board's own local +X. Positive therefore moves it
 * to the left as you look at it. Flip the sign if it goes the wrong way.
 *
 * FOR SCALE, because the units are deceptive: the anchor's 2.22x scale makes
 * this board ~9.7m wide in world. Half an inch (0.0127m) is about 0.1% of that
 * — genuinely invisible, which is why the first attempt at it looked like
 * nothing had happened. 0.25m is roughly a hand's width and reads as a nudge.
 *
 * The flanking pillars, measured from main.crdt: pilar.glb_2 sits at z=1.000
 * (the viewer's RIGHT, its face 0.18m off the board's edge) and pilar.glb_7 at
 * z=13.250 (the viewer's LEFT). Positive moves toward the latter.
 */
const BOARD_SHIFT_METRES = -0.60 // overlaps pilar.glb_2's face by ~0.42m

/** Backing sits at the panel plane; text floats in front of it, toward -Z. */
const PANEL_Z = 0
const TEXT_Z = -0.03

/**
 * NO TURN. Confirmed in world, not reasoned out.
 *
 * This was 180 on the theory that a face whose normal points down -Z needs its
 * text turned to match. It does not — a TextShape already reads from that side,
 * and the half-turn came back with the numerals right and the text mirrored.
 * Still correct however the anchor is rotated in Creator Hub, because
 * everything here is a child and this stays a purely local offset.
 */
const FACE_YAW = 0

// ── COLOURS ─────────────────────────────────────────────────────────────────
//
// Amber throughout, on request. The old board used bone-white for everyone and
// amber only for your own row; now amber IS the board and your row is picked
// out by being brighter rather than by being a different colour.
const GOLD = Color4.create(1, 0.85, 0.55, 1)
const GOLD_BRIGHT = Color4.create(1, 0.96, 0.80, 1)
const GOLD_DIM = Color4.create(0.72, 0.58, 0.36, 1)
/** Near-black, faintly lit so the panel doesn't disappear in a dark house. */
const PANEL_COLOR = Color4.create(0.045, 0.035, 0.04, 1)
const PANEL_GLOW = Color4.create(0.06, 0.04, 0.02, 1)

// ── VERTICAL LAYOUT ─────────────────────────────────────────────────────────
//
// Fractions of the panel height, measured from the BOTTOM. Tune these and
// nothing else moves — every y below is derived from them.
const ESCAPE_TITLE_Y = 0.965
const ESCAPE_HEADER_Y = 0.925
const ESCAPE_TOP_Y = 0.880
const ESCAPE_BOTTOM_Y = 0.405
const DEATH_TITLE_Y = 0.340
const DEATH_HEADER_Y = 0.300
const DEATH_TOP_Y = 0.258
const DEATH_BOTTOM_Y = 0.047

// ── COLUMNS ─────────────────────────────────────────────────────────────────
//
// Fractions of the panel width. Anchors, not centres: each cell grows away from
// its own edge (see cell()), which is what keeps columns off each other.
const RANK_RIGHT_FRACTION = 0.115
const NAME_LEFT_FRACTION = 0.145
const HEARTS_RIGHT_FRACTION = 0.66
const VALUE_RIGHT_FRACTION = 0.94

const RANK_X = FACE_MIN_X + FACE_WIDTH * RANK_RIGHT_FRACTION
const NAME_X = FACE_MIN_X + FACE_WIDTH * NAME_LEFT_FRACTION
const HEARTS_X = FACE_MIN_X + FACE_WIDTH * HEARTS_RIGHT_FRACTION
const VALUE_X = FACE_MIN_X + FACE_WIDTH * VALUE_RIGHT_FRACTION

/**
 * Row text size, in TextShape's own units rather than metres.
 *
 * SOLVED FOR, not chosen: 10 escape rows + 5 death rows + two titles + two
 * headers have to fit 5.58m of panel. At 1.3 the glyphs land ~0.12m against a
 * ~0.30m row pitch — 42% fill, which reads as spaced rather than cramped — and
 * a name gets 24 characters, comfortably more than the old board's nine.
 */
const FONT_SIZE = 1.3
const TITLE_FONT_SIZE = 1.9
const HEADER_FONT_SIZE = 0.95

/**
 * How wide a character draws, in metres, per unit of FONT_SIZE.
 *
 * Measured in world off a real row and deliberately kept — it is approximate
 * (the font is proportional and this is an average) but it only has to be close
 * enough to keep columns apart, and every budget below is derived from it
 * rather than hand-set, so the two cannot drift out of agreement.
 */
const CHAR_WIDTH_PER_FONT_UNIT = 0.059
const CHAR_WIDTH = FONT_SIZE * CHAR_WIDTH_PER_FONT_UNIT

/** ROUND_HEARTS pips. */
const HEARTS_WIDTH = ROUND_HEARTS * CHAR_WIDTH
/** A time reads "10:00" at most — five glyphs. */
const VALUE_WIDTH = 0.65
/** Dead space between columns, so a rounding error cannot close the gap. */
const COLUMN_GAP = 0.15

/**
 * Longest name a row can hold — COMPUTED, not chosen, so changing the font or
 * the columns cannot silently reintroduce an overlap.
 *
 * Budgeted against the HEARTS column, which sits between the name and the time.
 * Measuring to the time instead would hand the name the space the pips are
 * standing in.
 */
const NAME_MAX_CHARS = Math.max(4, Math.floor((HEARTS_X - HEARTS_WIDTH - COLUMN_GAP - NAME_X) / CHAR_WIDTH))

interface Row {
  rank: Entity
  name: Entity
  hearts: Entity
  value: Entity
}

const escapeRows: Row[] = []
const deathRows: Row[] = []
let board: Entity | null = null
/** Child of the anchor carrying BOARD_SHIFT_METRES; all cells hang off this. */
let root: Entity | null = null
let retries = 0
let lastRendered = ''

/** Absolute local Y from a fraction of the panel height. */
function atY(fraction: number): number {
  return FACE_MIN_Y + FACE_HEIGHT * fraction
}

/** Evenly spread row `i` of `count` between two fractions. */
function rowY(i: number, count: number, topFraction: number, bottomFraction: number): number {
  if (count <= 1) return atY(topFraction)
  return atY(topFraction - ((topFraction - bottomFraction) * i) / (count - 1))
}

/**
 * One text cell, parented to the anchor, ANCHORED AT ITS OWN EDGE.
 *
 * `x` is the edge the text grows away from — the left edge for a *_LEFT
 * alignment, the right edge for a *_RIGHT one.
 *
 * WIDTH 0, DELIBERATELY. TextShape alignment resolves against the entity
 * origin, not against the width/height box, at least with textWrapping off.
 * The previous board passed a column width and positioned each cell at the
 * column's CENTRE, which pushed every name half a column right and drove it
 * into the time. A zero-width box centred on the origin has both edges at the
 * origin, so this is correct under either interpretation.
 */
function cell(align: TextAlignMode, x: number, y: number, size: number, color: Color4): Entity {
  const e = engine.addEntity()
  Transform.create(e, {
    position: Vector3.create(x, y, TEXT_Z),
    rotation: Quaternion.fromEulerDegrees(0, FACE_YAW, 0),
    parent: root ?? board ?? undefined
  })
  TextShape.create(e, {
    text: '',
    font: Font.F_SANS_SERIF,
    fontSize: size,
    textAlign: align,
    width: 0,
    height: 0,
    textWrapping: false,
    textColor: color
  })
  return e
}

/** A cell whose text never changes — titles, column headers, rank numerals. */
function staticCell(text: string, align: TextAlignMode, x: number, y: number, size: number, color: Color4): void {
  const e = cell(align, x, y, size, color)
  TextShape.getMutable(e).text = text
}

/** The dark backing the text reads against. */
function buildPanel(): void {
  const panel = engine.addEntity()
  Transform.create(panel, {
    position: Vector3.create((FACE_MIN_X + FACE_MAX_X) / 2, (FACE_MIN_Y + FACE_MAX_Y) / 2, PANEL_Z),
    // A DCL plane is 1x1 in its own XY, so scale IS the size in metres.
    scale: Vector3.create(FACE_WIDTH, FACE_HEIGHT, 1),
    rotation: Quaternion.fromEulerDegrees(0, FACE_YAW, 0),
    parent: root ?? board ?? undefined
  })
  MeshRenderer.setPlane(panel)
  Material.setPbrMaterial(panel, {
    albedoColor: PANEL_COLOR,
    // A touch of emissive so the panel reads as a lit object in a very dark
    // house rather than a black hole the text floats in front of.
    emissiveColor: PANEL_GLOW,
    emissiveIntensity: 0.6,
    metallic: 0,
    roughness: 1
  })
}

/** Build both sections, once, as soon as the anchor has been found. */
function buildBoard(): void {
  // The anchor's scale multiplies every child offset, so convert the world-space
  // nudge into the local units the children actually live in. Guard against a
  // zero/absent scale rather than dividing by it.
  const anchorScale = board !== null ? Transform.get(board).scale.x : 1
  const localShift = anchorScale !== 0 ? BOARD_SHIFT_METRES / anchorScale : 0
  root = engine.addEntity()
  Transform.create(root, { position: Vector3.create(localShift, 0, 0), parent: board ?? undefined })

  buildPanel()

  staticCell('FASTEST ESCAPES', TextAlignMode.TAM_MIDDLE_CENTER, (FACE_MIN_X + FACE_MAX_X) / 2, atY(ESCAPE_TITLE_Y), TITLE_FONT_SIZE, GOLD)
  staticCell('NAME', TextAlignMode.TAM_MIDDLE_LEFT, NAME_X, atY(ESCAPE_HEADER_Y), HEADER_FONT_SIZE, GOLD_DIM)
  staticCell('HEARTS', TextAlignMode.TAM_MIDDLE_RIGHT, HEARTS_X, atY(ESCAPE_HEADER_Y), HEADER_FONT_SIZE, GOLD_DIM)
  staticCell('BEST TIME', TextAlignMode.TAM_MIDDLE_RIGHT, VALUE_X, atY(ESCAPE_HEADER_Y), HEADER_FONT_SIZE, GOLD_DIM)

  for (let i = 0; i < ROWS; i++) {
    const y = rowY(i, ROWS, ESCAPE_TOP_Y, ESCAPE_BOTTOM_Y)
    // The rank numeral is drawn, not baked, now that we own the panel — so it
    // can never drift out of step with the row beside it.
    staticCell(`${i + 1}`, TextAlignMode.TAM_MIDDLE_RIGHT, RANK_X, y, FONT_SIZE, GOLD_DIM)
    escapeRows.push({
      rank: engine.RootEntity, // unused for escape rows; the numeral is static
      name: cell(TextAlignMode.TAM_MIDDLE_LEFT, NAME_X, y, FONT_SIZE, GOLD),
      hearts: cell(TextAlignMode.TAM_MIDDLE_RIGHT, HEARTS_X, y, FONT_SIZE, GOLD),
      value: cell(TextAlignMode.TAM_MIDDLE_RIGHT, VALUE_X, y, FONT_SIZE, GOLD)
    })
  }

  staticCell('MOST DEATHS', TextAlignMode.TAM_MIDDLE_CENTER, (FACE_MIN_X + FACE_MAX_X) / 2, atY(DEATH_TITLE_Y), TITLE_FONT_SIZE, GOLD)
  staticCell('NAME', TextAlignMode.TAM_MIDDLE_LEFT, NAME_X, atY(DEATH_HEADER_Y), HEADER_FONT_SIZE, GOLD_DIM)
  staticCell('DEATHS', TextAlignMode.TAM_MIDDLE_RIGHT, VALUE_X, atY(DEATH_HEADER_Y), HEADER_FONT_SIZE, GOLD_DIM)

  for (let i = 0; i < DEATH_ROWS; i++) {
    const y = rowY(i, DEATH_ROWS, DEATH_TOP_Y, DEATH_BOTTOM_Y)
    staticCell(`${i + 1}`, TextAlignMode.TAM_MIDDLE_RIGHT, RANK_X, y, FONT_SIZE, GOLD_DIM)
    deathRows.push({
      rank: engine.RootEntity,
      name: cell(TextAlignMode.TAM_MIDDLE_LEFT, NAME_X, y, FONT_SIZE, GOLD),
      hearts: engine.RootEntity, // deaths rows have no hearts column
      value: cell(TextAlignMode.TAM_MIDDLE_RIGHT, VALUE_X, y, FONT_SIZE, GOLD)
    })
  }
}

/** Name, trimmed to what the row can hold. */
function label(name: string): string {
  return name.length > NAME_MAX_CHARS ? `${name.slice(0, NAME_MAX_CHARS - 1)}…` : name
}

/**
 * Hearts left, as the same pips the running HUD draws.
 *
 * Blank for -1 ("not recorded") — rows stored before hearts were tracked, and
 * players seen only as live in-room peers. Three hollow pips would claim they
 * finished on zero hearts, a different and wrong statement.
 */
function heartPips(hearts: number): string {
  if (hearts < 0) return ''
  let pips = ''
  for (let i = 0; i < ROUND_HEARTS; i++) pips += i < hearts ? '♥' : '♡'
  return pips
}

function write(e: Entity, value: string, mine: boolean): void {
  if (e === engine.RootEntity) return
  const t = TextShape.getMutable(e)
  t.text = value
  t.textColor = mine ? GOLD_BRIGHT : GOLD
}

/**
 * Fill both sections. Empty places are left BLANK rather than dashed: the panel
 * already draws every row's numeral, so an unclaimed place reads as unclaimed
 * on its own, and a column of filler is just noise from across a room.
 */
function render(): void {
  const escapes = escapeRanking().slice(0, ROWS)
  for (let i = 0; i < escapeRows.length; i++) {
    const r = escapes[i]
    if (r === undefined) {
      write(escapeRows[i].name, '', false)
      write(escapeRows[i].hearts, '', false)
      write(escapeRows[i].value, '', false)
      continue
    }
    write(escapeRows[i].name, label(r.name), r.me)
    write(escapeRows[i].hearts, heartPips(r.hearts), r.me)
    write(escapeRows[i].value, formatTime(r.bestTime), r.me)
  }
  if (escapes.length === 0 && escapeRows.length > 0) {
    write(escapeRows[0].name, 'Be the first', false)
  }

  const deaths = persistedDeaths().slice(0, DEATH_ROWS)
  for (let i = 0; i < deathRows.length; i++) {
    const d = deaths[i]
    if (d === undefined) {
      write(deathRows[i].name, '', false)
      write(deathRows[i].value, '', false)
      continue
    }
    write(deathRows[i].name, label(d.name), false)
    write(deathRows[i].value, `${d.deaths}`, false)
  }
}

/** What both boards currently show, as one string, purely to detect a change. */
function signature(): string {
  const a = escapeRanking()
    .slice(0, ROWS)
    .map((r) => `${r.name}|${r.bestTime}|${r.hearts}|${r.me ? 1 : 0}`)
    .join(',')
  const b = persistedDeaths()
    .slice(0, DEATH_ROWS)
    .map((d) => `${d.name}|${d.deaths}`)
    .join(',')
  return `${a}#${b}`
}

function findBoard(): Entity | null {
  for (const name of BOARD_ENTITY_NAMES) {
    const e = engine.getEntityOrNullByName(name)
    if (e !== null) return e
  }
  return null
}

function refreshSystem(_dt: number): void {
  // The composite may not have produced the anchor on the very first frames —
  // same reason the chandelier and the swing traps keep looking for theirs.
  if (board === null) {
    board = findBoard()

    if (board === null) {
      // The composite may not have produced the anchor on the very first frames,
      // so give it a moment before concluding there isn't one.
      if (++retries < ANCHOR_WAIT_FRAMES) return

      // No anchor at all — it was never placed, was renamed, or was deleted
      // from Creator Hub. Stand the board up ourselves rather than silently
      // rendering nothing, which is what used to happen.
      board = engine.addEntity()
      Transform.create(board, {
        position: FALLBACK_POSITION,
        rotation: Quaternion.fromEulerDegrees(0, FALLBACK_YAW, 0),
        scale: FALLBACK_SCALE
      })
      console.log(`[leaderboard] no placed anchor (tried ${BOARD_ENTITY_NAMES.join(', ')}); using the built-in position`)
    } else if (GltfContainer.has(board)) {
      // Stop the old baked art rendering, keeping the entity as a pure transform
      // anchor. Removing the model rather than hiding the entity matters: hiding
      // could take the children — our whole board — down with it.
      GltfContainer.deleteFrom(board)
    }

    buildBoard()
    console.log(`[leaderboard] built ${ROWS} escape rows and ${DEATH_ROWS} death rows on the placed anchor`)

    // DRAW ONCE HERE, and do not let the change-detector have a say. signature()
    // is nearly empty when nobody has escaped yet — which is exactly what
    // lastRendered starts as, so "has anything changed?" answered NO on the
    // first frame and the board sat blank, including the "Be the first" line
    // that exists for precisely this case.
    lastRendered = signature()
    render()
    return
  }

  const next = signature()
  if (next === lastRendered) return
  lastRendered = next
  render()
}

export function initLeaderboard() {
  addSafeSystem(refreshSystem, 'leaderboardRefresh')
}
