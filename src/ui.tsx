/**
 * HUD — "the strip that burns from both ends".
 *
 * The whole running HUD is one full-bleed bar across the top of the screen.
 * It is a candle laid on its side: you fill it with wax from the LEFT as you
 * light candles, and the night eats it from the RIGHT as the clock runs. The
 * gap between the two is the only thing the player has to read, and it answers
 * "will I get there before it does" with no numbers at all.
 *
 * Three consequences, which are why this replaced a stack of centred readouts:
 *   - The strip has exactly getCandlesRequired() cells, so the candle count is
 *     structural. It cannot fall out of sync with the data.
 *   - The 3.5s channel hold fills the cell of the candle you are ACTUALLY
 *     lighting, at its position on the strip.
 *   - Time pressure needs no separate timer bar, so the old green/amber/red
 *     bar is gone. The clock never turns red. Urgency is the strip guttering
 *     like a candle about to go out.
 *
 * Layout rules that exist for mobile, not for looks:
 *   - Every dimension goes through px()/fs() in uiTheme. No raw pixel numbers.
 *   - The HUD sits top-LEFT and the only tappable control sits bottom-RIGHT,
 *     so the thing you read and the thing you touch can never be confused, and
 *     nothing overlaps the joystick.
 *   - The strip is full-bleed at the very top edge: it occludes none of the
 *     play view, which matters when the threat is a skeleton walking at you.
 */

import ReactEcs, { ReactEcsRenderer, UiEntity, ScreenInsetArea } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { isPlayerDead, lastDeathCause, respawnCountdown, respawnNow, gameStarted, startGame } from './gameState'
import {
  deathCamActive,
  replayDeath,
  canReplayDeath
} from './effects/deathCam'
import {
  roundPhase,
  defeatReason,
  phaseCountdown,
  hearts,
  candlesLit,
  getCandlesRequired,
  roundRemaining,
  lastWinSeconds,
  lastWinWasBest,
  lastWinDelta,
  roundDeaths,
  bestWinTimes,
  channelFill,
  canLightNearby,
  formatTime,
  portalReady,
  portalOpenSeconds,
  previewActive,
  previewKind,
  escapeRanking,
  playAgainNow,
  furthestAreaLabel,
  deathLog,
  winScreenHeld
} from './gameLoop'
import {
  BLOOD_OVERLAY_TEXTURE,
  KILLER_HOUSE_TITLE_TEXTURE,
  KILLER_HOUSE_TITLE_ASPECT,
  RESPAWN_DELAY_SECONDS,
  DEATH_SCREEN_DELAY_SECONDS,
  ELECTROCUTION_CAUSE,
  ELECTROCUTION_SCREEN_AT,
  PORTAL_ENTRY_DELAY_SECONDS,
  ROUND_SECONDS,
  ROUND_HEARTS,
  DEBUG_HUD,
  DARKNESS_VEIL_ENABLED,
  LIGHTNING_FLASH_COLOR
} from './config'
import { darknessAlpha } from './candles'
import { blackoutAlpha, flashAlpha } from './lightning'
import { isInvulnerable } from './gameState'
import { isSimulationHost, readRemoteStats, otherPlayerPositions } from './multiplayer'
import { playerPosition } from './playerTracker'
import { playerInYard, nearestSkeletonDist } from './enemies/skeletons'
import { overFence } from './traps/fenceTips'
import { activeToasts } from './notifications'
import { failedLabels, addSafeSystem } from './safeSystem'
import {
  px,
  fs,
  a,
  uiCanvasWidth,
  VOID,
  COLD,
  ASH,
  BONE,
  WAX,
  FLAME,
  VEIL,
  RUST,
  FONT_DISPLAY,
  FONT_BODY,
  FONT_DATA,
  T_MICRO,
  T_SMALL,
  T_BODY,
  T_CLOCK,
  T_HEART,
  T_HEAD,
  T_SCORE,
  STRIP_HEIGHT,
  STRIP_GAP,
  uiIsMobile
} from './uiTheme'

/**
 * The HUD's OWN animation clock, in seconds since the scene started.
 *
 * Everything animated in here used to phase off roundRemaining, on the
 * reasoning that the game loop already ticks it every frame so no extra system
 * was needed. That reasoning has a hole: roundRemaining only advances while
 * roundPhase is 'playing' and the round is actually running, and it is an
 * imported `export let` binding, which puts the HUD's motion at the mercy of
 * another module's state and of the bundler preserving a live binding. The
 * candle flame came out completely static because of it.
 *
 * This ticks unconditionally, owns nothing else, and cannot be stopped by any
 * game state — which is what an animation clock has to be. Guarded by
 * addSafeSystem like every other system here.
 */
let uiClock = 0

export function setupUi() {
  addSafeSystem((dt: number) => {
    uiClock += dt
  }, 'uiClockSystem')
  ReactEcsRenderer.setUiRenderer(safeUi)
}

/**
 * Crash barrier for the whole HUD — the render-path twin of addSafeSystem().
 *
 * react-ecs drives uiMenu() from a system, and in this runtime an unhandled
 * throw inside ANY system aborts the entire scene update loop for that frame.
 * A single bad read in the HUD therefore does not just blank the UI, it stops
 * doors, candles, skeletons and the round timer along with it — a failure this
 * scene has already suffered twice from other causes.
 *
 * So: if the HUD throws, swallow it, keep the rest of the scene alive, and
 * draw the error where it can actually be read. A player can screenshot this;
 * a blank screen tells nobody anything.
 */
let uiErrorMessage: string | null = null

function safeUi() {
  try {
    const tree = uiMenu()
    uiErrorMessage = null
    return tree
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
    if (uiErrorMessage !== msg) {
      uiErrorMessage = msg
      console.error('[ui] HUD render threw — falling back to the error card:', err)
    }
    return errorCard(msg)
  }
}

function errorCard(msg: string) {
  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: '100%',
        positionType: 'absolute',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center'
      }}
      uiBackground={{ color: Color4.create(0.35, 0, 0.28, 0.92) }}
    >
      <UiEntity
        uiTransform={{ width: '90%', height: 40 }}
        uiText={{ value: 'HUD ERROR', fontSize: 28, textAlign: 'middle-center', color: Color4.White() }}
      />
      <UiEntity
        uiTransform={{ width: '90%', height: 260 }}
        uiText={{ value: msg.slice(0, 600), fontSize: 14, textAlign: 'top-left', color: Color4.White() }}
      />
    </UiEntity>
  )
}

// ── Derived values ─────────────────────────────────────────────────────────

/**
 * Seconds elapsed in this run — the number the player is scored on.
 *
 * Math.round here is NOT cosmetic. gameLoop computes the recorded score as
 * `lastWinSeconds = Math.round(ROUND_SECONDS - roundRemaining)` while
 * formatTime() applies Math.ceil internally. Feeding the raw float to
 * formatTime would ceil it, so the clock the player watched could read 1:07
 * while the time they actually scored was 1:06. Rounding first makes the
 * watched number byte-identical to the scored one.
 */
function elapsedSeconds(): number {
  return Math.max(0, Math.round(ROUND_SECONDS - roundRemaining))
}

/** 1 at the start of the round -> 0 when the clock runs out. */
function timeFraction(): number {
  return Math.max(0, Math.min(1, roundRemaining / ROUND_SECONDS))
}

/**
 * Guttering alpha for the last 30 seconds — the strip's dying-candle flicker.
 *
 * Phase is driven off roundRemaining, which the game loop already ticks every
 * frame, so this needs no system of its own and adds no crash surface. Rate is
 * deliberately slow (|sin| doubles the perceived frequency, so 3.0 reads as
 * roughly two pulses a second); a faster flicker on a full-bleed element reads
 * as a rendering fault rather than a candle.
 */
function gutterAlpha(base: number): number {
  if (roundRemaining > 30 || roundPhase !== 'playing') return base
  return base * (0.62 + 0.38 * Math.abs(Math.sin(roundRemaining * 3.0)))
}

/** Slow breath for the portal-open strip, phased off the portal's own countdown. */
function portalBreath(): number {
  return 0.62 + 0.38 * Math.abs(Math.sin(portalOpenSeconds * 2.2))
}

/**
 * Candle-flame flicker for the HUD icon, 0.6 → 1.0.
 *
 * TWO sine waves at unrelated speeds, deliberately: one alone reads as a
 * mechanical pulse, and a flame that pulses on a beat looks more artificial
 * than one that doesn't move at all. Summed like this the peaks never line up
 * on any short cycle, so it wanders the way a real flame does.
 *
 * Clocked off uiClock, NOT roundRemaining — see the note on uiClock for why
 * that distinction is the whole reason this animates at all.
 */
function flameFlicker(): number {
  const t = uiClock
  const w = 0.6 * Math.sin(t * 5.3) + 0.4 * Math.sin(t * 8.7) // -1 .. 1
  return 0.6 + 0.4 * ((w + 1) / 2)
}

// ── Copy ───────────────────────────────────────────────────────────────────
// Written from the player's side of the screen: plain verbs, sentence case,
// and never a claim the game does not actually know. The old copy asserted
// things like which room a candle was in; no state in this codebase records
// that, so it would have been a lie most of the time.

function exitLine(): string {
  // The portal no longer wins the round on a timer, so there is no countdown
  // left to show — the only number worth a player's attention here is how long
  // until they are allowed THROUGH it. After that it is an instruction, not a
  // readout, because nothing is running out.
  const arming = PORTAL_ENTRY_DELAY_SECONDS - portalOpenSeconds
  return arming > 0 ? `EXIT OPENING · ${Math.ceil(arming)}s` : 'EXIT OPEN · GET TO THE BACKYARD'
}

function winSubline(): string {
  if (lastWinWasBest && lastWinDelta === 0) return 'You escaped. Your first way out.'
  if (lastWinWasBest) return `You escaped. Fastest yet — ${Math.abs(lastWinDelta)}s under your old best.`
  return `You escaped. ${lastWinDelta}s off your best of ${formatTime(bestWinTimes[0])}.`
}

function defeatHeadline(): string {
  return defeatReason === 'time' ? 'The clock ran out.' : 'You ran out of hearts.'
}

/**
 * THE CELEBRATION CARD — the only thing on screen during the victory shot.
 *
 * The full win screen (scrim at 0.93, leaderboard, Play Again) is held back for
 * VICTORY_CINEMATIC_HOLD_SECONDS so the cinematic is actually visible; a
 * near-opaque overlay over a composed frame is the same as not having composed
 * it. But a camera that cuts away from the player with NOTHING on screen reads
 * as the game breaking rather than as a reward — the identical argument the
 * DEATH RECAP banner further down is there to settle.
 *
 * So: two lines, pinned to the top out of the hero's third of the frame, no
 * scrim, nothing to press. The time is the score and gets the size; everything
 * else waits for the real screen, which arrives while the camera is still
 * moving.
 */
function victoryCard() {
  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', pointerFilter: 'none' }}>
      <ScreenInsetArea uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
        <UiEntity
          uiTransform={{ width: '100%', height: px(T_MICRO * 2.2), margin: { top: px(28) } }}
          uiText={{
            value: 'ESCAPED IN',
            fontSize: fs(T_MICRO),
            font: FONT_DATA,
            textAlign: 'middle-center',
            color: ASH
          }}
        />
        <UiEntity
          uiTransform={{ width: '100%', height: px(T_SCORE * 1.1) }}
          uiText={{
            value: formatTime(lastWinSeconds),
            fontSize: fs(T_SCORE * 0.8),
            font: FONT_DATA,
            textAlign: 'middle-center',
            color: lastWinWasBest ? VEIL : WAX
          }}
        />
      </ScreenInsetArea>
    </UiEntity>
  )
}


/**
 * THE DEATH RECAP — every death this round, in order.
 *
 * The subline names only the death that ENDED the run; on a three-heart loss
 * that is one death out of three, and the pattern is the useful part. "The axe
 * got you twice" is a lesson; "you died" is not.
 *
 * Returns one string per death, already numbered and timestamped. Empty when
 * the run ended on the clock without dying, which is a real outcome and should
 * not render an empty box.
 */
function deathRecapLines(): string[] {
  const out: string[] = []
  for (let i = 0; i < deathLog.length; i++) {
    const d = deathLog[i]
    // Causes are authored as "Killed by ..." so they read as a death-screen
    // headline. In a numbered list that repeats badly, so strip it.
    const cause = d.cause.replace(/^Killed by /i, '').replace(/^Struck by /i, 'struck by ')
    const named = cause !== '' ? cause : 'something in the dark'
    out.push(`${i + 1}.  ${formatTime(d.atRemaining)}   ${named}  ·  ${d.area}`)
  }
  return out
}

/** "The swinging axe got you twice" — only when one cause actually repeats. */
function deathRecapPattern(): string {
  if (deathLog.length < 2) return ''
  const counts = new Map<string, number>()
  for (const d of deathLog) {
    const c = d.cause.replace(/^Killed by /i, '')
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  let worst = ''
  let n = 0
  for (const [c, k] of counts) {
    if (k > n) {
      n = k
      worst = c
    }
  }
  if (n < 2 || worst === '') return ''
  return `${worst} got you ${n === 2 ? 'twice' : `${n} times`}.`
}

function defeatSubline(): string {
  const lit = `You lit ${candlesLit} of ${getCandlesRequired()} candles, made it to ${furthestAreaLabel()}`
  if (defeatReason === 'time') return `${lit}.`
  // Name the death that actually ended the run. On the third death the death
  // screen never gets shown — the defeat screen takes over immediately — so
  // without this the one death that cost you the round is the only one the
  // game never tells you about.
  //
  // Some causes are already phrased as "Killed by ..." because that is how they
  // read as the death screen's own headline; strip that off here so the line
  // doesn't come out "Killed by: killed by fallen plank."
  const cause = lastDeathCause.toLowerCase().replace(/^killed by /, '')
  const killedBy = cause !== '' ? ` Killed by: ${cause}.` : ''
  return `${lit}, with ${formatTime(roundRemaining)} still on the clock.${killedBy}`
}

// 0 right after death (blood splat fully visible) -> 1 (solid black) about
// two-thirds of the way through the respawn countdown.
function fadeToBlackAlpha(): number {
  // HOLD WHILE THE DEATH CAM IS UP. Otherwise the fade covers the very shot it
  // was added to show — the trap finishing its swing through where you stood.
  if (deathCamActive) return 0
  // Rebased past the hold-off, so the fade starts from clear on the frame the
  // screen appears. Measured from RESPAWN_DELAY_SECONDS it would already be
  // part-way dark and pop in grey.
  const span = RESPAWN_DELAY_SECONDS - deathScreenDelay()
  const progress = 1 - respawnCountdown / span
  return Math.min(1, Math.max(0, progress * 1.5))
}

/**
 * The death screen waits a beat before taking over.
 *
 * Without this the scrim lands on the same frame as the kill and swallows the
 * death effect — the electrocution skeleton in particular, which is a 0.9s
 * flash that nobody ever got to see. Driven off respawnCountdown rather than a
 * clock of its own so there is only one death timer to keep in step, and so
 * "Respawn Now" (which zeroes it) cannot strand the screen hidden.
 */
function deathScreenDelay(): number {
  // Lightning runs a longer sequence — sprite, then headstone, then this — so
  // it gets its own figure rather than sharing the default and cutting the
  // last two beats off. See ELECTROCUTION_SCREEN_AT.
  return lastDeathCause === ELECTROCUTION_CAUSE ? ELECTROCUTION_SCREEN_AT : DEATH_SCREEN_DELAY_SECONDS
}

function deathScreenVisible(): boolean {
  return RESPAWN_DELAY_SECONDS - respawnCountdown >= deathScreenDelay()
}

// ── The strip ──────────────────────────────────────────────────────────────

/**
 * One cell per required candle. The gaps are the parent's VOID showing
 * through rather than drawn dividers, so the cell count is the candle count
 * by construction.
 */
function stripCells() {
  const total = getCandlesRequired()
  const fill = channelFill()
  const cells = []
  for (let i = 0; i < total; i++) {
    const lit = i < candlesLit
    const channelling = i === candlesLit && fill !== null
    cells.push(
      <UiEntity
        key={i}
        uiTransform={{
          flexGrow: 1,
          height: '100%',
          margin: { right: i === total - 1 ? 0 : STRIP_GAP() }
        }}
        uiBackground={{ color: lit ? WAX : a(COLD, gutterAlpha(0.75)) }}
      >
        {/* The 3.5s hold fills the cell of the candle you are actually
            lighting — which is what let the separate channel bar shrink to a
            single line of text. */}
        {channelling && (
          <UiEntity
            uiTransform={{ width: `${Math.round((fill ?? 0) * 100)}%`, height: '100%' }}
            uiBackground={{ color: FLAME }}
          />
        )}
      </UiEntity>
    )
  }
  return cells
}

/**
 * CANDLE COUNTER — a candle glyph and "3 / 7", top-right.
 *
 * The strip along the top already encodes the same number as cells, but it
 * encodes it as a SHAPE — you have to count segments to read it, which Week 2
 * testers did not do mid-run. This states it in digits, with nothing to
 * decode.
 *
 * DRAWN, NOT AN IMAGE. It was assets/ui/candle.png briefly; that art is a thin
 * yellow-flamed taper and the scene's actual candle is a squat cream pillar on
 * a flared foot, so the HUD was advertising a prop that doesn't exist in the
 * house. Boxes let the silhouette match the real model — wide body, wider
 * base, tall flame — and let the flame be built in PARTS, which is what the
 * animation needs. (A single alpha-pulsed rectangle over a flat image is what
 * the first version did, and it read as an orange block, because it was one.)
 *
 * THE FLAME IS ALIVE: an outer body and a brighter inner core, both changing
 * height on flameFlicker(), narrowing as they rise so the silhouette tapers
 * the way the model's flame does. Once every candle is lit the flame is
 * dropped entirely and the wax goes full WAX — the icon going out is the
 * "ritual finished" signal, matching the strip turning violet above it.
 */
function candleCounter() {
  const total = getCandlesRequired()
  const done = candlesLit >= total
  const flick = flameFlicker()

  // Proportions taken off the real model: a tall plain pillar with a small
  // flare at the foot, and a flame about a third of the body's height.
  //
  // Sized up substantially from the first pass. At ~9px tall the flame's
  // animation was mathematically running but invisible — a 3px swing reads as
  // a static dot, which is why it looked frozen. The motion needs room, so
  // the whole glyph got bigger and the flame now moves in WIDTH as well as
  // height, which is what makes it look like it's guttering rather than just
  // growing.
  const bodyW = px(16, 12)
  const baseW = px(21, 15)
  const flameH = px(20, 14) * (0.62 + 0.5 * flick)
  const flameW = px(9, 7) * (0.72 + 0.36 * flick)
  const coreH = px(11, 8) * (0.55 + 0.5 * flick)
  const coreW = px(4, 3) * (0.7 + 0.4 * flick)

  // NO POSITION OF ITS OWN. This used to plant itself top-right under the
  // strip; on request it now sits in the bottom-right stack directly above the
  // clock, so the three things you read mid-run — candles, time, hearts — are
  // one column in one corner instead of scattered across three. The caller owns
  // where it goes.
  //
  // pointerFilter belongs INSIDE uiTransform. As a bare JSX attribute react-ecs
  // treats it as an unknown component and runs `'onChange' in "none"`, which
  // throws and takes down the whole UI tree. That shipped once from this very
  // function; tools/check_undefined.py now fails the build on it.
  return (
    <UiEntity
      uiTransform={{
        flexDirection: 'row',
        alignItems: 'center',
        margin: { bottom: px(6) },
        pointerFilter: 'none' // never eat a tap meant for the world underneath
      }}
    >
      <UiEntity
        uiTransform={{
          width: baseW,
          height: px(T_BODY * 2.9),
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'flex-end',
          margin: { right: px(8, 6) }
        }}
      >
        {!done && (
          <UiEntity
            uiTransform={{
              width: flameW,
              height: flameH,
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'flex-end',
              margin: { bottom: px(2, 1) }
            }}
            uiBackground={{ color: a(FLAME, 0.62 + 0.38 * flick) }}
          >
            {/* Hot core, brighter and narrower — the bit that reads as fire
                rather than as a coloured rectangle. */}
            <UiEntity uiTransform={{ width: coreW, height: coreH }} uiBackground={{ color: a(WAX, 0.7 + 0.3 * flick) }} />
          </UiEntity>
        )}

        {/* Wax pillar, then the small flare at the foot. No background box
            behind any of this — the glyph sits straight on the world. */}
        <UiEntity uiTransform={{ width: bodyW, height: px(30, 21) }} uiBackground={{ color: done ? WAX : a(WAX, 0.94) }} />
        <UiEntity uiTransform={{ width: baseW, height: px(4, 3) }} uiBackground={{ color: done ? WAX : a(WAX, 0.94) }} />
      </UiEntity>

      <UiEntity
        uiTransform={{ height: px(T_BODY * 2.9) }}
        uiText={{
          value: `${candlesLit} / ${total}`,
          fontSize: fs(T_BODY),
          font: FONT_DATA,
          textAlign: 'middle-left',
          color: done ? WAX : BONE
        }}
      />
    </UiEntity>
  )
}

/**
 * THE TITLE — "KILLER HOUSE" in dripping blood, at the top of the welcome
 * screen (on request). Replaces the old "SPOOKY HOUSE" eyebrow, which was
 * 13px of grey monospace and named a game nobody is calling it.
 *
 * A BAKED IMAGE, not text. react-ecs offers three fonts — serif, sans-serif,
 * monospace — with no custom-font path and no runtime shaders, so a horror
 * title has to arrive as a PNG. title-source/title_build.py renders it, and
 * config.ts's KILLER_HOUSE_TITLE_* pair is the contract with that script.
 *
 * SIZED FROM THE CANVAS, not from px() alone. react-ecs has no aspect-ratio
 * property, so both dimensions have to be real numbers; a px()-only width would
 * compute past the screen edge on a narrow phone under the mobile boost and
 * overflow the intro column. px(560) is the ceiling on a big screen, 84% of the
 * canvas is the ceiling on a small one, whichever is smaller wins.
 *
 * THE DROPS FALL. Three of them, below the baked drips, on unrelated phases so
 * they never fall in step. They accelerate (y goes as u², which is what makes
 * it read as falling rather than sliding) and fade out before they reach the
 * headline underneath, so nothing ever obscures the copy. Clocked off uiClock
 * like every other animation here — see the note on that binding.
 */
const TITLE_WIDTH_PX = 840 // 50% up from 560, on request
const TITLE_DROP_COUNT = 14
// The ceiling on a screen too narrow for the above. Not 1.0, and not even 0.94:
// uiCanvasWidth() is the WHOLE canvas, while the title is drawn inside
// ScreenInsetArea, which on a notched phone in landscape gives up ~40px to each
// cutout. The slack covers those insets so a wide title can't run under one.
const TITLE_CANVAS_FRACTION = 0.9
// Mid stop of the baked ramp (#8E100B), so a falling drop is the same blood as
// the drip it left. Local to the title: the palette's RUST means "loss" and is
// spent on death/defeat headlines, and this is art, not a state colour.
const TITLE_BLOOD = Color4.create(0.557, 0.063, 0.043, 1)

/**
 * Stable pseudo-random in 0..1 for drop `i`, channel `salt`.
 *
 * The classic sin-fract hash, and the reason it is here rather than
 * Math.random(): this runs inside the render function on EVERY frame, so a real
 * random would re-roll each drop's lane, size and phase sixty times a second
 * and the whole band would read as static. Being a pure function of (i, salt)
 * makes the layout fixed while only uiClock moves it. It also means
 * TITLE_DROP_COUNT is a single knob — no hand-written coordinate table to keep
 * in step with it.
 */
function dropHash(i: number, salt: number): number {
  const v = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453
  return v - Math.floor(v)
}

function killerHouseTitle() {
  const w = Math.min(px(TITLE_WIDTH_PX), Math.round(uiCanvasWidth() * TITLE_CANVAS_FRACTION))
  const h = Math.max(2, Math.round(w / KILLER_HOUSE_TITLE_ASPECT))

  // SPACING ONLY, and deliberately almost none (on request — close the gap to
  // the copy). This was 62% of the title's height at one point purely because
  // the drops needed runway; they no longer need anything like that much, and
  // the room was only pushing the headline down the screen.
  const gap = px(T_BODY * 0.5)

  // THE BLOOD BELONGS TO THE TITLE, not to the screen (reverted on request).
  //
  // There was a version where these were a full-screen layer at zIndex 2,
  // raining across the headline, the body copy and the button. It worked, but
  // it read as weather happening to the page rather than as the title bleeding
  // — and it put moving marks over text the player is trying to read on the one
  // screen that explains the game. Back inside the title's own box, every drop
  // starts on the artwork and dies just below it, so it reads as coming off the
  // letters, which is the whole idea.
  //
  // The fall is derived from the title's height rather than from `gap`, so
  // closing the gap did not also kill the animation: drops start up inside the
  // artwork near the baked drip tips and finish flush with the bottom of the
  // box. Nothing ever leaves the parent, so there is no question of whether an
  // overflowing child gets clipped.
  const drops = []
  for (let i = 0; i < TITLE_DROP_COUNT; i++) {
    const period = 1.5 + 1.6 * dropHash(i, 3)
    const u = ((uiClock + dropHash(i, 2) * period) % period) / period
    // Fade in fast, hold, fade out over the last stretch — a drop that vanishes
    // at full opacity reads as a dropped frame.
    const fade = u < 0.14 ? u / 0.14 : u < 0.58 ? 1 : Math.max(0, 1 - (u - 0.58) / 0.42)
    const alpha = fade * (0.55 + 0.45 * dropHash(i, 5))
    if (alpha <= 0.03) continue

    const scale = 0.55 + 0.95 * dropHash(i, 4)
    const dw = Math.max(2, Math.round(w * 0.0045 * scale))
    const dh = Math.max(2, Math.round(w * 0.0085 * scale))
    const from = h - Math.round(h * 0.12) // up among the drips, not in clear air
    const to = h + gap - dh               // flush with the bottom of the box
    // u² so it accelerates; constant speed reads as sliding, not falling.
    const top = from + Math.round((to - from) * u * u)

    drops.push(
      <UiEntity
        key={i}
        uiTransform={{
          positionType: 'absolute',
          position: { top, left: Math.round(w * (0.05 + 0.9 * dropHash(i, 1))) },
          width: dw,
          height: dh
        }}
        uiBackground={{ color: a(TITLE_BLOOD, alpha) }}
      />
    )
  }

  return (
    <UiEntity key="title" uiTransform={{ width: w, height: h + gap }}>
      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: w, height: h }}
        uiBackground={{ textureMode: 'stretch', texture: { src: KILLER_HOUSE_TITLE_TEXTURE } }}
      />
      {drops}
    </UiEntity>
  )
}

/**
 * DEATH BLOOD — the splatter thrown across the screen when you die.
 *
 * Every death used to draw the SAME texture at the SAME orientation, so the
 * fifth death looked identical to the first — which quietly undercuts the one
 * moment the game is trying to make feel violent and surprising.
 *
 * There is still only one blood image in the project, and no new art was
 * added: the variety comes from uiBackground's `uvs`, which lets a stretched
 * texture be sampled flipped and cropped. Eight variants below combine
 * horizontal flip, vertical flip and a zoomed-in crop, and TWO of them are
 * layered per death at different alphas — so the composite is different again,
 * and the count of distinct-looking deaths is far past eight.
 *
 * Keyed off roundDeaths, not a random number: it must stay identical for every
 * frame of one death screen (a splat resampling itself each frame would read
 * as a rendering fault) while changing on the next. Real blood textures can
 * still be dropped in later — point BLOOD_SPLAT_UVS' consumers at a list of
 * srcs instead and this whole approach retires cleanly.
 */
const BLOOD_SPLAT_UVS: number[][] = [
  [0, 0, 0, 1, 1, 1, 1, 0], // as authored
  [1, 0, 1, 1, 0, 1, 0, 0], // mirrored left-right
  [0, 1, 0, 0, 1, 0, 1, 1], // mirrored top-bottom
  [1, 1, 1, 0, 0, 0, 0, 1], // rotated 180 (both flips)
  [0.12, 0.12, 0.12, 0.88, 0.88, 0.88, 0.88, 0.12], // punched in — reads as a closer, heavier hit
  [0.88, 0.12, 0.88, 0.88, 0.12, 0.88, 0.12, 0.12],
  [0.12, 0.88, 0.12, 0.12, 0.88, 0.12, 0.88, 0.88],
  [0.88, 0.88, 0.88, 0.12, 0.12, 0.12, 0.12, 0.88]
]

function bloodSplats() {
  const n = BLOOD_SPLAT_UVS.length
  // Two co-prime strides so the pair of layers doesn't fall into a short
  // repeating cycle as the death count climbs.
  const near = BLOOD_SPLAT_UVS[roundDeaths % n]
  const far = BLOOD_SPLAT_UVS[(roundDeaths * 3 + 5) % n]

  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', position: { top: 0, left: 0 } }}>
      <UiEntity
        uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', position: { top: 0, left: 0 } }}
        uiBackground={{ textureMode: 'stretch', texture: { src: BLOOD_OVERLAY_TEXTURE }, uvs: far, color: a(Color4.White(), 0.55) }}
      />
      <UiEntity
        uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', position: { top: 0, left: 0 } }}
        uiBackground={{ textureMode: 'stretch', texture: { src: BLOOD_OVERLAY_TEXTURE }, uvs: near }}
      />
    </UiEntity>
  )
}

/**
 * PREVIEW ARROWS — four blinking arrows converging on the thing the camera is
 * orbiting, drawn only while the location preview is running.
 *
 * The preview takes the camera off the player and swings it around their last
 * candle (or the portal). It's a striking shot, but on its own it's ambiguous:
 * the player is being shown a room, and nothing in the frame says WHICH object
 * in it they're supposed to care about. These point at it.
 *
 * They can be a fixed screen-space cross because of how the preview camera is
 * built — updatePreviewCamera aims it with lookRotation straight at
 * previewCenter every frame, so the target is pinned to the exact middle of
 * the screen for the whole orbit no matter where the camera has swung to.
 * Arrows converging on the centre are therefore always pointing at it, with no
 * world-to-screen projection needed (react-ecs has none to offer anyway).
 *
 * They BLINK and BREATHE together: alpha and inset both ride the same wave, so
 * the four arrows pulse inward in unison rather than sitting there. Motion is
 * what makes them read as "look at this" instead of as frame decoration.
 */
function previewArrows() {
  // ~2.5 blinks a second. |sin| doubles the perceived rate, so this is a
  // deliberately brisk pulse — it's on screen for only a few seconds and has
  // to be noticed inside the first one.
  const pulse = Math.abs(Math.sin(uiClock * 8.0))
  const alpha = 0.35 + 0.65 * pulse
  const inset = px(150) - px(26) * pulse // arrows creep inward on each beat
  const size = px(30)
  // Label and colour both follow what the preview is ACTUALLY showing — see
  // PreviewKind in gameLoop.ts. The stuck hint can fire with several candles
  // still standing, so it must not claim this is the last one.
  const isPortal = previewKind === 'portal'
  const label =
    previewKind === 'portal' ? 'THE WAY OUT' : previewKind === 'lastCandle' ? 'YOUR LAST CANDLE' : 'LIGHT THE CANDLE TO PROGRESS'
  const colour = isPortal ? VEIL : FLAME

  const arrow = (glyph: string, style: Record<string, unknown>) => (
    <UiEntity
      key={glyph}
      uiTransform={{ positionType: 'absolute', width: size, height: size, ...style }}
      uiText={{ value: glyph, fontSize: fs(T_HEAD * 0.6), font: FONT_DATA, textAlign: 'middle-center', color: a(colour, alpha) }}
    />
  )

  return (
    <UiEntity
      uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', pointerFilter: 'none' }}
    >
      {/* Each arrow sits one inset out from centre and points back at it. */}
      {arrow('▼', { position: { top: `50%`, left: `50%` }, margin: { top: -inset - size, left: -size / 2 } })}
      {arrow('▲', { position: { top: `50%`, left: `50%` }, margin: { top: inset, left: -size / 2 } })}
      {arrow('▶', { position: { top: `50%`, left: `50%` }, margin: { top: -size / 2, left: -inset - size } })}
      {arrow('◀', { position: { top: `50%`, left: `50%` }, margin: { top: -size / 2, left: inset } })}

      {/* Offset as a PERCENTAGE of the viewport, not px(190). A scaled pixel
          offset is a fixed distance from the centre no matter how tall the
          screen is, and on a landscape phone (≈390 tall, mobile boost 1.6) that
          put this line ~300px below a centre that is only 195px from the
          bottom — i.e. the label was off screen entirely on exactly the device
          this preview matters most on. 22% lands it at 72% down on every
          aspect ratio. */}
      <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: { top: '50%', left: 0 },
          width: '100%',
          margin: { top: '22%' }
        }}
        uiText={{
          value: label,
          fontSize: fs(T_SMALL),
          font: FONT_DATA,
          textAlign: 'middle-center',
          color: a(colour, alpha)
        }}
      />

      {/* THE WAY OUT OF THE CUT. The preview takes the player's controls away
          for several seconds; anyone who has already seen what they're being
          shown should be able to leave immediately (gameLoop's
          previewSkipPressed ends it on the spot).

          It does NOT say Esc, which is what was asked for: Esc is the
          explorer's own menu key and is never delivered to a scene, so there is
          no InputAction to bind and a line promising it would be a lie. Click
          and tap are the same action (IA_POINTER) on the two platforms, so the
          wording is the only thing that changes.

          Anchored to the BOTTOM edge, which is where a skip prompt belongs and
          is the one anchor that cannot fall off a short screen. Lifted clear of
          the mobile client's own touch cluster, same as the clock/hearts.

          Steady, not blinking like the arrows above it — the arrows are an
          alert and want the eye, this is an instruction and wants to be read
          once. */}
      <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: uiIsMobile() ? { bottom: px(120), left: 0 } : { bottom: px(48), left: 0 },
          width: '100%'
        }}
        uiText={{
          value: uiIsMobile() ? 'Tap to exit camera' : 'Click or press E to exit camera',
          fontSize: fs(T_MICRO),
          font: FONT_DATA,
          textAlign: 'middle-center',
          color: a(BONE, 0.7)
        }}
      />
    </UiEntity>
  )
}

/**
 * The signature element. `frozen` keeps it mounted on the win overlay at the
 * exact wax/shadow gap the player escaped on, so the thing they read all round
 * becomes the trophy — and the HUD and the win screen read as one object.
 */
function strip(frozen: boolean) {
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: 0, left: 0 },
        width: '100%',
        height: STRIP_HEIGHT(),
        flexDirection: 'row',
        pointerFilter: 'none'
      }}
      uiBackground={{ color: a(VOID, 0.9) }}
    >
      {/* Portal open: the fragmented, half-eaten bar becomes one unbroken
          violet line across the top of the world. VEIL appears nowhere else in
          an entire run, so this is legible from peripheral vision without
          reading a word. */}
      {portalReady ? (
        <UiEntity
          uiTransform={{ width: '100%', height: '100%' }}
          uiBackground={{ color: a(VEIL, frozen ? 1 : portalBreath()) }}
        />
      ) : (
        stripCells()
      )}

      {/* The night eating the strip from the right. Declared last so it paints
          over the cells. Capped at 0.55 alpha, NOT opaque: late in the round
          the shadow covers most of the unlit cells, and at full strength it
          would destroy the candle readout at exactly the moment it matters
          most. */}
      {!portalReady && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: 0, right: 0 },
            width: `${Math.round((1 - timeFraction()) * 100)}%`,
            height: '100%',
            pointerFilter: 'none'
          }}
          uiBackground={{ color: a(VOID, 0.55) }}
        />
      )}
    </UiEntity>
  )
}

/** Hearts as bone pips. No red on the running HUD — red is reserved for loss. */
function heartPips(size: number) {
  const pips = []
  for (let i = 0; i < ROUND_HEARTS; i++) {
    pips.push(
      <UiEntity
        key={i}
        uiTransform={{ width: px(size * 1.15), height: px(size * 1.5) }}
        uiText={{
          value: i < hearts ? '♥' : '♡',
          fontSize: fs(size),
          font: FONT_DATA,
          textAlign: 'middle-center',
          color: i < hearts ? WAX : ASH
        }}
      />
    )
  }
  return pips
}

/** "Someone died" / "someone lit a candle" — shared events, newest at the bottom. */
function toastStack() {
  const toasts = activeToasts()
  if (toasts.length === 0) return null
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        // Raised back up, on request — px(64) of clearance left an obvious gap.
        //
        // STRIP_HEIGHT is the FLOOR here, not decoration. The strip is declared
        // after the toasts in uiMenu, so it paints over them: the original
        // px(12) put the toast's top edge underneath the strip, which is what
        // was clipping it — not the explorer's own bar. Anything measured from
        // the strip's bottom edge is safe; anything smaller starts losing the
        // first line again.
        position: { top: STRIP_HEIGHT() + px(20), left: 0 },
        width: '100%',
        flexDirection: 'column',
        alignItems: 'center',
        pointerFilter: 'none'
      }}
    >
      {toasts.map((t) => (
        <UiEntity
          key={t.id}
          uiTransform={{
            width: 'auto',
            // Wide enough for the longest toast this scene sends — the sealed
            // boundary line runs 57 characters, which overflowed px(480) and
            // wrapped. Clamped to the canvas as well, because px() alone does
            // not know how wide the screen is: on a 390px phone the mobile
            // boost turns px(560) into 728px and the plate would hang off both
            // edges. Same reason killerHouseTitle sizes off uiCanvasWidth.
            maxWidth: Math.min(px(560), Math.round(uiCanvasWidth() * 0.9)),
            // TALL ENOUGH FOR TWO LINES. The height is fixed (uiText does not
            // grow its entity), and at one line's worth a wrapped toast spilled
            // straight out of its own background: the second line rendered with
            // no plate behind it and the first was pushed up under the screen
            // edge. On a narrow phone even 560px wraps, so this has to hold two
            // lines regardless of how wide the plate gets.
            height: px(T_SMALL * 2.8),
            margin: { bottom: px(4) },
            padding: { left: px(14), right: px(14) }
          }}
          uiBackground={{ color: a(VOID, 0.75) }}
          uiText={{
            value: t.text,
            fontSize: fs(T_SMALL),
            font: FONT_BODY,
            textAlign: 'middle-center',
            color: BONE
          }}
        />
      ))}
    </UiEntity>
  )
}

/**
 * A ranking row's hearts as pips — the same language as the running HUD's
 * heartPips(), but for an arbitrary row rather than the live round.
 *
 * '' when hearts is -1 ("not recorded"): rows stored before hearts were
 * tracked, and players seen only as live in-room peers. Drawing three hollow
 * pips instead would assert they scraped through on zero, which is a claim the
 * board has no basis for.
 */
function rowHeartPips(hearts: number): string {
  if (hearts < 0) return ''
  let pips = ''
  for (let i = 0; i < ROUND_HEARTS; i++) pips += i < hearts ? '♥' : '♡'
  return pips
}

function leaderboardRows() {
  const ranking = escapeRanking().slice(0, 5)
  if (ranking.length === 0) {
    // Distinguish "nobody's escaped yet" from "I can't see anyone else this
    // session" — an empty board reads as broken if the player doesn't know
    // which one it is. readRemoteStats() reflects whether this device has
    // detected any other connected player at all, independent of whether
    // anyone has won.
    const noOthersDetected = readRemoteStats().length === 0
    return [
      <UiEntity
        key="none"
        uiTransform={{ width: '100%', height: px(26) }}
        uiText={{
          value: noOthersDetected ? 'No other players detected this session.' : 'No escapes yet. Be the first.',
          fontSize: fs(T_SMALL),
          font: FONT_BODY,
          textAlign: 'middle-center',
          color: ASH
        }}
      />
    ]
  }
  // Real rows, not one concatenated string: monospace only buys column
  // alignment if the columns are actually columns, and player names vary in
  // length enough to smear a single line into mush.
  return ranking.map((r, i) => (
    <UiEntity
      key={i}
      uiTransform={{ width: '100%', height: px(26), flexDirection: 'row', alignItems: 'center' }}
    >
      <UiEntity
        uiTransform={{ width: px(34) }}
        uiText={{ value: `${i + 1}`, fontSize: fs(T_SMALL), font: FONT_DATA, textAlign: 'middle-left', color: ASH }}
      />
      <UiEntity
        uiTransform={{ flexGrow: 1 }}
        uiText={{
          value: r.me ? `${r.name} (you)` : r.name,
          fontSize: fs(T_SMALL),
          font: FONT_BODY,
          textAlign: 'middle-left',
          color: r.me ? WAX : BONE
        }}
      />
      <UiEntity
        uiTransform={{ width: px(56) }}
        uiText={{
          value: rowHeartPips(r.hearts),
          fontSize: fs(T_SMALL),
          font: FONT_DATA,
          textAlign: 'middle-right',
          // Dimmer than the time even on your own row: hearts are colour on the
          // run, the time is the score.
          color: r.me ? WAX : ASH
        }}
      />
      <UiEntity
        uiTransform={{ width: px(80) }}
        uiText={{
          value: formatTime(r.bestTime),
          fontSize: fs(T_SMALL),
          font: FONT_DATA,
          textAlign: 'middle-right',
          color: r.me ? WAX : BONE
        }}
      />
    </UiEntity>
  ))
}

/**
 * Shared shell for the four full-screen states.
 *
 * Two layers on purpose: the tint scrim covers the WHOLE canvas (a scrim
 * that stops at the notch line reads as a rendering bug), while the readable
 * content is constrained to ScreenInsetArea — the mobile guide's safe area
 * (notch, status bar, home indicator, rounded corners). On desktop the
 * insets are zero, so this renders identically to the old single-layer shell.
 */
function overlayShell(tint: Color4, children: ReactEcs.JSX.ReactNode, banner?: ReactEcs.JSX.ReactNode) {
  return (
    <UiEntity
      uiTransform={{ width: '100%', height: '100%', positionType: 'absolute' }}
      uiBackground={{ color: tint }}
    >
      <ScreenInsetArea
        uiTransform={{ flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}
      >
        {/* Above the column and NOT inside it. The 620px cap is a line-length
            limit for prose — it exists so a paragraph doesn't run the width of
            a monitor. A title is a piece of art with no line length to control,
            and once it went 50% bigger it was wider than that cap and would
            have overflowed a parent it never belonged in. Anything passed here
            is free to be as wide as the safe area. */}
        {banner}
        <UiEntity
          uiTransform={{
            width: '88%',
            maxWidth: px(620),
            flexDirection: 'column',
            alignItems: 'center'
          }}
        >
          {children}
        </UiEntity>
      </ScreenInsetArea>
    </UiEntity>
  )
}

// TEMP diagnostic readout (gated by DEBUG_HUD). `f` increments every render
// (proves react-ecs is alive), `t` is the round clock (proves the game loop is
// alive), and `pos` is the player position the SCENE sees — if that doesn't
// change as you walk on mobile, a stuck player-position is the root cause.
let dbgFrame = 0

/**
 * Zero-dependency liveness line — touches nothing but a local counter, so it
 * can NEVER throw. If this doesn't show up on a device, react-ecs itself
 * isn't drawing anything for us there (a platform-level fact, not a bug in
 * our game logic) — that rules out every other theory in one glance.
 */
function aliveText(): string {
  dbgFrame += 1
  return `ALIVE f${dbgFrame % 100000}`
}

// Death-diagnostic line, kept SHORT and BIG so it's readable on a phone. The
// three that decide whether a threat can kill you: Y (is the reported height
// sane, ~0-2 in the yard, or camera-height ~1.7 that pushes you "out of" the
// yard), YARD (are you counted as in the yard), INV (are you invulnerable).
// SKEL is the flat distance to the nearest skeleton (kill happens under
// SKELETON_KILL_RADIUS, currently 0.9 — see the derivation in config.ts).
// Wrapped in its own try/catch — a throw in HERE must not take the entire HUD
// down with it (safeUi()'s barrier is coarser: it would replace the WHOLE
// screen with a red error card, hiding the RUN HUD/candles/hearts along with
// this one line). A local catch keeps the blast radius to this one line.
function debugText(): string {
  try {
    const p = playerPosition
    const inYard = playerInYard()
    const inv = isInvulnerable()
    const skel = nearestSkeletonDist()
    // oth = how many OTHER players this specific device currently detects at
    // the platform level (PlayerIdentityData+Transform, native avatar
    // tracking — nothing to do with our own game code). host = does THIS
    // device believe it's the one simulating the shared skeletons. If one
    // device shows oth0 while the other shows oth1+, that device isn't
    // seeing the other player at all — which, on its own, explains a mismatched
    // host election (each device could conclude something different about who's
    // in charge) without needing any bug in our own game logic.
    const oth = otherPlayerPositions().length
    const host = isSimulationHost()
    // When a skeleton is basically touching you, say in plain words why
    // you're still alive — that single word is the whole diagnosis.
    let verdict = ''
    if (skel < 1.5) {
      if (inv) verdict = ' -> INVULNERABLE'
      else if (!inYard) verdict = ' -> NOT-IN-YARD (Y too high)'
      else verdict = ' -> SHOULD BE DYING'
    }
    // fn = horizontally over a fence line (fence tips kill only when this is
    // 1 AND Y is inside the tip band — both visible here, so one screenshot
    // from a fence standee is a complete diagnosis).
    return `Y${p.y.toFixed(1)} yard${inYard ? 1 : 0} inv${inv ? 1 : 0} fn${overFence() ? 1 : 0} oth${oth} host${host ? 1 : 0} skel${skel.toFixed(1)}${verdict}`
  } catch (err) {
    return `debugText ERROR: ${err instanceof Error ? err.message : String(err)}`
  }
}

export const uiMenu = () => (
  <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'absolute' }}>
    {/* Darkness veil (night gloom + thunder blackout). Gated by
        DARKNESS_VEIL_ENABLED — see the long comment on that flag in
        config.ts for why it was off and why it's safe again now. */}
    {DARKNESS_VEIL_ENABLED && (darknessAlpha > 0.01 || blackoutAlpha > 0.01) && (
      <UiEntity
        uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', pointerFilter: 'none' }}
        uiBackground={{ color: Color4.create(0, 0, 0, Math.min(1, Math.max(darknessAlpha, blackoutAlpha))) }}
      />
    )}

    {/* THE STRIKE FLASH. Drawn AFTER the darkness veil so it washes over it
        rather than under it — the bolt is the brightest thing on screen for
        the half second it lasts, and layering it beneath a 0.85-alpha
        blackout would make it invisible at exactly the moment it fires.
        Not gated on DARKNESS_VEIL_ENABLED: that flag exists to control the
        night gloom, and the flash should still read with the gloom off. */}
    {flashAlpha > 0.01 && (
      <UiEntity
        uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', pointerFilter: 'none' }}
        uiBackground={{
          color: Color4.create(
            LIGHTNING_FLASH_COLOR.r,
            LIGHTNING_FLASH_COLOR.g,
            LIGHTNING_FLASH_COLOR.b,
            Math.min(1, flashAlpha)
          )
        }}
      />
    )}

    {/* "So-and-so has died" / "lit a candle" — visible in any game state, not
        just mid-round, since the event that triggered it already happened. */}
    {gameStarted && <ScreenInsetArea uiTransform={{ pointerFilter: 'none' }}>{toastStack()}</ScreenInsetArea>}

    {/* ── RUNNING HUD ──────────────────────────────────────────────────── */}
    {/* ScreenInsetArea pins the strip/clock/hearts inside the device safe
        area — on a notched phone the old full-canvas wrapper put the strip
        (and the clock under it) straight under the camera cutout. Desktop
        insets are zero, so nothing changes there. */}
    {gameStarted && roundPhase === 'playing' && (
      <ScreenInsetArea uiTransform={{ pointerFilter: 'none' }}>
        {strip(false)}

        {/* Only while the camera is off the player, orbiting their target. */}
        {previewActive && previewArrows()}

        {/* Exit status, top-left under the strip — and ONLY once the exit is
            actually doing something.
            
            It used to sit there permanently reading "SEALED · 3 candles left",
            which made candle progress the third readout on screen saying the
            same thing: the strip along the top already draws one cell per
            candle required, and the counter top-right already states it as
            digits. Three places for one number is not redundancy that helps,
            it is clutter that hides the two readouts which are unique — the
            clock and the hearts. Now this line appears when it has news
            nothing else carries: the exit arming, and then the way out. */}
        {portalReady && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: STRIP_HEIGHT() + px(10), left: px(16) },
            pointerFilter: 'none'
          }}
          uiText={{
            value: exitLine(),
            fontSize: fs(T_MICRO),
            font: FONT_DATA,
            textAlign: 'middle-left',
            color: VEIL
          }}
        />
        )}

        {/* Candles + clock + hearts, bottom-right, in that order — the whole
            run state in one column. On mobile the explorer draws its own
            jump/E/F touch cluster inside the safe area at the bottom-right —
            lifted clear of it (same reasoning as where FLARE used to sit
            before it was removed); desktop has no such cluster so it can sit
            lower. */}
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: uiIsMobile() ? { bottom: px(140), right: px(18) } : { bottom: px(24), right: px(18) },
            flexDirection: 'column',
            alignItems: 'flex-end',
            pointerFilter: 'none'
          }}
        >
          {candleCounter()}
          <UiEntity
            uiTransform={{ height: px(T_CLOCK * 1.25) }}
            uiText={{
              value: formatTime(elapsedSeconds()),
              fontSize: fs(T_CLOCK),
              font: FONT_DATA,
              textAlign: 'middle-right',
              color: WAX
            }}
          />
          <UiEntity
            uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { top: px(4) } }}
          >
            {heartPips(T_HEART)}
          </UiEntity>
        </UiEntity>
      </ScreenInsetArea>
    )}

    {/* Channel prompt, low-centre. The strip already shows the fill in the
        right cell, but the player is looking at the candle in front of them,
        not at the top edge — without a word down here they don't know
        holding is what's required, or that letting go loses the fill. Two
        states: actively channeling (fill in progress) vs. in range but not
        yet holding (canLightNearby, discoverability for the new hold model —
        without this the first candle of a run has no cue at all). Text
        only: the bar lives in the strip. */}
    {gameStarted && roundPhase === 'playing' && !isPlayerDead && (channelFill() !== null || canLightNearby()) && (
      <ScreenInsetArea uiTransform={{ pointerFilter: 'none' }}>
        <UiEntity
          uiTransform={{
            // Moved up from 22% toward center, on request (playtest feedback:
            // players weren't sure whether to tap or hold, in part because
            // this prompt sat low enough to be outside where a mid-panic
            // player is actually looking).
            positionType: 'absolute',
            position: { bottom: '42%', left: 0 },
            width: '100%',
            pointerFilter: 'none'
          }}
          uiText={{
            value: channelFill() !== null ? 'Lighting — keep holding' : 'Hold to light',
            fontSize: fs(T_BODY),
            font: FONT_BODY,
            textAlign: 'middle-center',
            color: FLAME
          }}
        />
      </ScreenInsetArea>
    )}

    {/* The knife hotbar was DELETED on 2026-08-19 on request, along with the
        thrown knife and every pickup. It rendered KNIFE_ITEMS bottom-centre
        and doubled as the mobile tap target for slashing, since there is no
        keyboard there. Desktop key 1 still calls trySlash(); mobile now has
        no way to slash at all, which is moot while WEAPONS_ENABLED is false
        and is the thing to restore first if weapons come back. */}

    {/* ── INTRO GATE ───────────────────────────────────────────────────── */}
    {/* Wrapped so the blood rain can be a sibling of the whole shell and paint
        OVER the copy — same pattern the win overlay uses for its frozen
        strip.

        THE WHOLE SCREEN STARTS THE GAME. The intro waits for the player now
        instead of auto-starting after 12s (on request), and that timer was the
        only thing standing between a mis-registered tap and an unrecoverable
        soft-lock — nothing can kill, draw a HUD or advance a round until
        gameStarted flips. Listening on the full-screen wrapper as well as the
        button removes the single point of failure the timer was insuring
        against. startGame() is idempotent, so the button firing both handlers
        is a no-op. */}
    {!gameStarted && (
      <UiEntity
        uiTransform={{ width: '100%', height: '100%', positionType: 'absolute' }}
        onMouseDown={() => {
          startGame()
        }}
      >
        {overlayShell(
        a(VOID, 0.94),
        [
        <UiEntity
          key="head"
          uiTransform={{ width: '100%', height: px(T_HEAD * 1.4) }}
          uiText={{
            // ONE SENTENCE, ONE CAUSE AND EFFECT (on request). Not "Light N
            // candles. Get out." — that was two instructions, and it read as
            // two separate objectives when it is really one thing leading to
            // the other. "to get out" is doing the work that the full stop
            // used to break.
            //
            // NO NUMBER HERE, deliberately. It was round-aware (5 on round one,
            // 7 after) and correct, but a count in the headline invites the
            // player to memorise a target before they have seen a single
            // candle. The count is already on screen the entire run, twice
            // over — the strip along the top has exactly one cell per required
            // candle, and candleCounter() states it in digits as "3 / 7". This
            // line's job is what the game IS; those two say how far through it
            // you are.
            value: 'Light candles to get out.',
            fontSize: fs(T_HEAD),
            font: FONT_DISPLAY,
            textAlign: 'middle-center',
            color: WAX
          }}
        />,
        <UiEntity
          key="dread"
          uiTransform={{ width: '100%', height: px(T_BODY * 4.6), margin: { top: px(12) } }}
          uiText={{
            // THE HOUSE TALKING, directly under the objective and above the
            // rules. The headline says what to do and the block below says how
            // the game works; this is the only line on the screen whose job is
            // how it FEELS, so it gets the position right under the title and
            // its own breathing room above the mechanics.
            //
            // BONE, not RUST. Red would suit the threat, but RUST (#8E2B22) on
            // this scrim is about 2.3:1 — under half what body copy needs to
            // stay legible, and this is the longest paragraph on the screen.
            // BONE is the palette's own prose colour and clears 6:1. The
            // headline above it stays WAX, so the hierarchy still reads
            // title -> voice -> rules without spending contrast on it.
            //
            // Height is 4.6 lines for ~3.8 lines of wrapped text at this size
            // in the 620px column — the same slack the block below carries,
            // because a fixed height that runs short CLIPS rather than grows.
            value:
              'Why are you here? Are you lost? This house isn\'t just haunted, it has real murderous intent! ' +
              'Beware of your surroundings — everything can put you to death! ' +
              'No one has ever come out here alive. Your grave is already waiting…',
            fontSize: fs(T_BODY),
            font: FONT_BODY,
            textAlign: 'middle-center',
            color: BONE
          }}
        />,
        // (The rules paragraph lived here — "They are hidden across the yard
        // and the house ... Three hearts, one touch kills, N minutes." Removed
        // on request.
        //
        // Everything it stated is on screen for the whole run anyway: the
        // candle strip along the top has one cell per candle required, the
        // heart pips show the three lives, and the clock counts the round down.
        // The one thing it alone carried was "the front door is straight
        // ahead", which is a hint rather than a rule. The screen now reads
        // objective -> atmosphere -> scoring, and the mechanics are learned by
        // playing rather than by reading a wall of text before you start.)
        <UiEntity
          key="score"
          uiTransform={{ width: '100%', height: px(T_SMALL * 1.8), margin: { top: px(10) } }}
          uiText={{
            value: 'Your escape time is your score.',
            fontSize: fs(T_SMALL),
            font: FONT_BODY,
            textAlign: 'middle-center',
            color: WAX
          }}
        />,
        // (The "Every candle you can see is yours — you will see other players,
        // but never their candles" line lived here. Removed on request.
        //
        // It was written for a rule that needed explaining: flames used to be
        // SHARED, so a candle in front of you might be someone else's and would
        // quietly ignore your hold. Once candles went fully private (see the
        // header in gameLoop.ts) the rule stopped having an exception, and a
        // sentence describing a rule with no exception is just more to read on
        // a screen that already asks for a lot. Nothing on screen belongs to
        // anyone else now, so nothing has to say so.)
        <UiEntity
          key="best"
          uiTransform={{ width: '100%', height: px(T_MICRO * 1.8) }}
          uiText={{
            value: bestWinTimes.length > 0 ? `Your best escape: ${formatTime(bestWinTimes[0])}` : 'You have never made it out.',
            fontSize: fs(T_MICRO),
            font: FONT_DATA,
            textAlign: 'middle-center',
            color: ASH
          }}
        />,
        <UiEntity
          key="btn"
          uiTransform={{
            width: '70%',
            maxWidth: px(320),
            height: px(62, 48),
            margin: { top: px(24) },
            alignItems: 'center',
            justifyContent: 'center'
          }}
          // A wax plate, not a flame one: FLAME means an actual candle burning
          // and nothing else, so it does not get spent on a button. WAX on
          // near-black is still far and away the brightest thing on this
          // screen, which is all the button needs to be.
          uiBackground={{ color: WAX }}
          onMouseDown={() => {
            startGame()
          }}
        >
          <UiEntity
            uiTransform={{ width: '100%', height: '100%' }}
            uiText={{
              value: 'Enter the house',
              fontSize: fs(T_BODY),
              font: FONT_BODY,
              textAlign: 'middle-center',
              color: VOID
            }}
          />
        </UiEntity>
        ],
        killerHouseTitle()
        )}
      </UiEntity>
    )}

    {/* ── WIN ──────────────────────────────────────────────────────────── */}
    {/* The celebration shot owns the screen first — see victoryCard(). This
        overlay arrives partway through the camera move, not after it, so the
        last seconds of the arc play behind it. gameLoop freezes its reset
        countdown for exactly the same window. */}
    {roundPhase === 'won' && winScreenHeld && victoryCard()}

    {roundPhase === 'won' && !winScreenHeld && (
      <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'absolute' }}>
        {overlayShell(a(VOID, 0.93), [
          <UiEntity
            key="eyebrow"
            uiTransform={{ width: '100%', height: px(T_MICRO * 1.8) }}
            uiText={{
              value: 'ESCAPED IN',
              fontSize: fs(T_MICRO),
              font: FONT_DATA,
              textAlign: 'middle-center',
              color: ASH
            }}
          />,
          // The time IS the headline, because the time is the score.
          <UiEntity
            key="time"
            uiTransform={{ width: '100%', height: px(T_SCORE * 1.2) }}
            uiText={{
              value: formatTime(lastWinSeconds),
              fontSize: fs(T_SCORE),
              font: FONT_DATA,
              textAlign: 'middle-center',
              color: lastWinWasBest ? VEIL : WAX
            }}
          />,
          <UiEntity
            key="sub"
            uiTransform={{ width: '100%', height: px(T_BODY * 1.8), margin: { top: px(4) } }}
            uiText={{
              value: winSubline(),
              fontSize: fs(T_BODY),
              font: FONT_DISPLAY,
              textAlign: 'middle-center',
              color: BONE
            }}
          />,
          <UiEntity
            key="stats"
            uiTransform={{ width: '100%', height: px(T_MICRO * 1.8), margin: { top: px(2) } }}
            uiText={{
              value: `${hearts} of ${ROUND_HEARTS} hearts left · ${roundDeaths} death${roundDeaths === 1 ? '' : 's'} this round`,
              fontSize: fs(T_MICRO),
              font: FONT_DATA,
              textAlign: 'middle-center',
              color: ASH
            }}
          />,
          <UiEntity
            key="rule"
            uiTransform={{ width: '100%', height: px(1, 1), margin: { top: px(18), bottom: px(10) } }}
            uiBackground={{ color: a(WAX, 0.18) }}
          />,
          // Rank is the ONLY real sequence in this product, so it is the only
          // place a 1/2/3 numbering tells the truth.
          <UiEntity
            key="lbhead"
            uiTransform={{ width: '100%', height: px(T_MICRO * 1.8) }}
            uiText={{
              value: 'FASTEST ESCAPES',
              fontSize: fs(T_MICRO),
              font: FONT_DATA,
              textAlign: 'middle-center',
              color: ASH
            }}
          />,
          <UiEntity key="lb" uiTransform={{ width: '100%', flexDirection: 'column', margin: { top: px(4) } }}>
            {leaderboardRows()}
          </UiEntity>,
          <UiEntity
            key="footer"
            uiTransform={{ width: '100%', height: px(T_MICRO * 1.8), margin: { top: px(16) } }}
            uiText={{
              value: `Next round in ${Math.max(0, Math.ceil(phaseCountdown))}`,
              fontSize: fs(T_MICRO),
              font: FONT_DATA,
              textAlign: 'middle-center',
              color: ASH
            }}
          />,
          <UiEntity
            key="playAgain"
            uiTransform={{
              width: '70%',
              maxWidth: px(320),
              height: px(62, 48),
              margin: { top: px(14) },
              alignItems: 'center',
              justifyContent: 'center'
            }}
            uiBackground={{ color: WAX }}
            onMouseDown={() => playAgainNow()}
          >
            <UiEntity
              uiTransform={{ width: '100%', height: '100%' }}
              uiText={{
                value: 'Play Again',
                fontSize: fs(T_BODY),
                font: FONT_BODY,
                textAlign: 'middle-center',
                color: VOID
              }}
            />
          </UiEntity>
        ])}
        {/* Frozen at the exact gap you escaped on — the thing you read all
            round becomes the trophy. Same safe-area treatment as the live
            strip, so the trophy sits exactly where the HUD did. */}
        <ScreenInsetArea uiTransform={{ pointerFilter: 'none' }}>{strip(true)}</ScreenInsetArea>
      </UiEntity>
    )}

    {/* ── DEFEAT ───────────────────────────────────────────────────────── */}
    {/* Stands down for the death replay. The recap is launched FROM this
        screen, and leaving a full-canvas 93% scrim over it meant pressing
        Death Replay lit up a shot nobody could see. The countdown behind it is
        paused for the same window (loopSystem in gameLoop.ts), so nothing is
        lost by hiding it - the screen comes back exactly as it was. */}
    {roundPhase === 'defeated' && !deathCamActive &&
      overlayShell(a(VOID, 0.93), [
        <UiEntity
          key="head"
          uiTransform={{ width: '100%', height: px(T_HEAD * 1.4) }}
          uiText={{
            value: defeatHeadline(),
            fontSize: fs(T_HEAD),
            font: FONT_DISPLAY,
            textAlign: 'middle-center',
            color: RUST
          }}
        />,
        <UiEntity
          key="sub"
          uiTransform={{ width: '100%', height: px(T_BODY * 1.8), margin: { top: px(8) } }}
          uiText={{
            value: defeatSubline(),
            fontSize: fs(T_BODY),
            font: FONT_BODY,
            textAlign: 'middle-center',
            color: BONE
          }}
        />,
        // THE RECAP. Rendered as ONE text block rather than a row per death:
        // the overlay is a fixed-height shell, and N children of unknown count
        // is how you get a list that pushes the Play Again button off a phone
        // screen. A joined string grows in a way the shell already handles.
        ...(deathLog.length > 0
          ? [
              <UiEntity
                key="recapHead"
                uiTransform={{ width: '100%', height: px(T_MICRO * 1.6), margin: { top: px(16) } }}
                uiText={{
                  value: 'HOW IT WENT WRONG',
                  fontSize: fs(T_MICRO),
                  font: FONT_DATA,
                  textAlign: 'middle-center',
                  color: RUST
                }}
              />,
              <UiEntity
                key="recap"
                uiTransform={{
                  width: '100%',
                  height: px(T_MICRO * 1.7 * deathLog.length),
                  margin: { top: px(4) }
                }}
                uiText={{
                  value: deathRecapLines().join('\n'),
                  fontSize: fs(T_MICRO),
                  font: FONT_DATA,
                  textAlign: 'middle-center',
                  color: BONE
                }}
              />
            ]
          : []),
        ...(deathRecapPattern() !== ''
          ? [
              <UiEntity
                key="recapPattern"
                uiTransform={{ width: '100%', height: px(T_MICRO * 1.8), margin: { top: px(6) } }}
                uiText={{
                  value: deathRecapPattern(),
                  fontSize: fs(T_MICRO),
                  font: FONT_BODY,
                  textAlign: 'middle-center',
                  color: RUST
                }}
              />
            ]
          : []),
        <UiEntity
          key="footer"
          uiTransform={{ width: '100%', height: px(T_MICRO * 1.8), margin: { top: px(20) } }}
          uiText={{
            value: `Next attempt in ${Math.max(0, Math.ceil(phaseCountdown))}`,
            fontSize: fs(T_MICRO),
            font: FONT_DATA,
            textAlign: 'middle-center',
            color: ASH
          }}
        />,
        // DEATH REPLAY — replays the shot on demand. Present on the DEFEAT
        // screen too, because the run-ending death is the one you most want to
        // see and it is the only one the death screen never shows (defeat takes
        // over immediately on the last heart).
        ...(canReplayDeath()
          ? [
              <UiEntity
                key="replay"
                uiTransform={{
                  width: '70%',
                  maxWidth: px(320),
                  height: px(52, 42),
                  margin: { top: px(14) },
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
                uiBackground={{ color: a(RUST, 0.9) }}
                onMouseDown={() => replayDeath()}
              >
                <UiEntity
                  uiTransform={{ width: '100%', height: '100%' }}
                  uiText={{
                    value: 'Death Replay',
                    fontSize: fs(T_BODY),
                    font: FONT_BODY,
                    textAlign: 'middle-center',
                    color: BONE
                  }}
                />
              </UiEntity>
            ]
          : []),
        <UiEntity
          key="playAgain"
          uiTransform={{
            width: '70%',
            maxWidth: px(320),
            height: px(62, 48),
            margin: { top: px(14) },
            alignItems: 'center',
            justifyContent: 'center'
          }}
          uiBackground={{ color: WAX }}
          onMouseDown={() => playAgainNow()}
        >
          <UiEntity
            uiTransform={{ width: '100%', height: '100%' }}
            uiText={{
              value: 'Play Again',
              fontSize: fs(T_BODY),
              font: FONT_BODY,
              textAlign: 'middle-center',
              color: VOID
            }}
          />
        </UiEntity>
      ])}

    {/* ── DEATH ────────────────────────────────────────────────────────── */}
    {/* Scrim, blood and fade cover the FULL canvas (a splatter that stops at
        the notch line reads as a bug); only the readable column is
        constrained to the safe area. */}
    {/* DEATH RECAP banner — shown ONLY while the death cam has the camera.
        The scrim, blood and text below are suppressed for that window (see the
        deathCamActive guard on the block after this) so the shot is clean; this
        is the one label that stays, because a camera that cuts away from your
        body with no explanation reads as a bug rather than a replay. */}
    {/* NOT gated on isPlayerDead. The recap can now be pressed from the HUD
        chip after you are back on your feet, and that is the case that most
        needs the label — a camera that cuts away from a living player with
        nothing on screen reads as the game breaking. */}
    {/* NOT gated on roundPhase any more. The run-ending third death leaves
        roundPhase 'defeated', so this label - the one thing that explains why
        the camera has cut away - was the one death it never appeared for. */}
    {deathCamActive && (
      <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'absolute' }}>
        <ScreenInsetArea uiTransform={{ flexDirection: 'column', alignItems: 'center' }}>
          <UiEntity
            uiTransform={{ width: '100%', height: px(T_MICRO * 2.2), margin: { top: px(28) } }}
            uiText={{
              value: 'DEATH RECAP',
              fontSize: fs(T_MICRO),
              font: FONT_DATA,
              textAlign: 'middle-center',
              color: RUST
            }}
          />
          <UiEntity
            uiTransform={{ width: '100%', height: px(T_HEAD * 1.3) }}
            uiText={{
              value: lastDeathCause !== '' ? lastDeathCause : 'Something caught you.',
              fontSize: fs(T_HEAD * 0.75),
              font: FONT_DISPLAY,
              textAlign: 'middle-center',
              color: BONE
            }}
          />
        </ScreenInsetArea>
      </UiEntity>
    )}

    {isPlayerDead && roundPhase === 'playing' && !deathCamActive && deathScreenVisible() && (
      <UiEntity
        uiTransform={{ width: '100%', height: '100%', positionType: 'absolute' }}
        uiBackground={{ color: a(RUST, 0.35) }}
      >
        {/* Blood splatter around the screen edges, behind the text. With no
            red anywhere on the HUD, this is one of the only reds in the game
            and it lands harder for it. */}
        {bloodSplats()}
        {/* Fade to black: swallows the blood splat as the countdown runs. */}
        <UiEntity
          uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', position: { top: 0, left: 0 } }}
          uiBackground={{ color: Color4.create(0, 0, 0, fadeToBlackAlpha()) }}
        />
        <ScreenInsetArea
          uiTransform={{ flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}
        >
        <UiEntity uiTransform={{ width: '88%', maxWidth: px(620), flexDirection: 'column', alignItems: 'center' }}>
          {/* The cause of death IS the headline. "YOU DIED" tells the player
              nothing they do not already know; "Crushed under the chandelier"
              tells them what to avoid next time. */}
          <UiEntity
            uiTransform={{ width: '100%', height: px(T_HEAD * 1.4) }}
            uiText={{
              value: lastDeathCause !== '' ? lastDeathCause : 'Something caught you.',
              fontSize: fs(T_HEAD),
              font: FONT_DISPLAY,
              textAlign: 'middle-center',
              color: WAX
            }}
          />
          <UiEntity
            uiTransform={{ width: '100%', height: px(T_MICRO * 1.8), margin: { top: px(4) } }}
            uiText={{
              value: `${formatTime(elapsedSeconds())} into the run`,
              fontSize: fs(T_MICRO),
              font: FONT_DATA,
              textAlign: 'middle-center',
              color: ASH
            }}
          />
          <UiEntity
            uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { top: px(12) } }}
          >
            {heartPips(T_HEAD * 0.6)}
          </UiEntity>
          <UiEntity
            uiTransform={{ width: '100%', height: px(T_MICRO * 1.8), margin: { top: px(14) } }}
            uiText={{
              value: `Back in ${Math.max(0, Math.ceil(respawnCountdown))}`,
              fontSize: fs(T_MICRO),
              font: FONT_DATA,
              textAlign: 'middle-center',
              color: ASH
            }}
          />
          {/* Skip the wait. Same shape as the win/defeat "Play Again" button so
              the two read as the same affordance, and it sits AFTER the
              fade-to-black in the tree so it stays visible once the screen has
              gone solid black two-thirds of the way through the countdown. */}
          {/* DEATH REPLAY — runs the shot again on demand. Above Respawn Now
              on purpose: pressing respawn ends the moment you might want to
              look at, so the destructive button should not be the first one
              your thumb lands on. */}
          {canReplayDeath() && (
            <UiEntity
              uiTransform={{
                width: '70%',
                maxWidth: px(320),
                height: px(52, 42),
                margin: { top: px(14) },
                alignItems: 'center',
                justifyContent: 'center'
              }}
              uiBackground={{ color: a(RUST, 0.9) }}
              onMouseDown={() => replayDeath()}
            >
              <UiEntity
                uiTransform={{ width: '100%', height: '100%' }}
                uiText={{
                  value: 'Death Replay',
                  fontSize: fs(T_BODY),
                  font: FONT_BODY,
                  textAlign: 'middle-center',
                  color: BONE
                }}
              />
            </UiEntity>
          )}
          <UiEntity
            uiTransform={{
              width: '70%',
              maxWidth: px(320),
              height: px(62, 48),
              margin: { top: px(14) },
              alignItems: 'center',
              justifyContent: 'center'
            }}
            uiBackground={{ color: WAX }}
            onMouseDown={() => respawnNow()}
          >
            <UiEntity
              uiTransform={{ width: '100%', height: '100%' }}
              uiText={{
                value: 'Respawn Now',
                fontSize: fs(T_BODY),
                font: FONT_BODY,
                textAlign: 'middle-center',
                color: VOID
              }}
            />
          </UiEntity>
        </UiEntity>
        </ScreenInsetArea>
      </UiEntity>
    )}

    {/* TEMP debug readout — top of the SAFE area (was the literal canvas
        corner, which on a notched phone could bury the one readout this
        project depends on under the camera cutout), still in raw, unscaled
        numbers (deliberately NOT going through px()/fs()/uiTheme, to rule out
        our own scaling math as a reason this might not show up). Last child
        so it sits on top of absolutely everything else. Two rows: ALIVE is a
        zero-dependency counter that cannot throw — if THIS doesn't appear on
        a device, react-ecs isn't drawing anything for us there at all, which
        is a platform fact, not a bug in our game code. */}
    {DEBUG_HUD && (
      <ScreenInsetArea uiTransform={{ flexDirection: 'column', pointerFilter: 'none' }}>
        <UiEntity
          uiTransform={{ width: '100%', height: 36, alignItems: 'center', justifyContent: 'center' }}
          uiBackground={{ color: Color4.create(0.85, 0, 0.85, 0.95) }}
          uiText={{ value: aliveText(), fontSize: 22, textAlign: 'middle-center', color: Color4.White() }}
        />
        <UiEntity
          uiTransform={{ width: '100%', height: 36, alignItems: 'center', justifyContent: 'center' }}
          uiBackground={{ color: Color4.create(0, 0, 0, 0.9) }}
          uiText={{ value: debugText(), fontSize: 20, textAlign: 'middle-center', color: Color4.create(1, 0.6, 0.18, 1) }}
        />
        {/* THIRD row: names any init() or system that has thrown on THIS
            device. There is no scene-console access from a mobile device, so
            this is the only way to find out whether e.g. initSkeletons()
            silently failed there — bright red, only appears if something
            actually broke, so its mere presence is itself the answer. */}
        {failedLabels().length > 0 && (
          <UiEntity
            uiTransform={{ width: '100%', height: 36, alignItems: 'center', justifyContent: 'center' }}
            uiBackground={{ color: Color4.create(0.9, 0, 0, 0.95) }}
            uiText={{ value: `FAILED: ${failedLabels().join(', ')}`, fontSize: 20, textAlign: 'middle-center', color: Color4.White() }}
          />
        )}
      </ScreenInsetArea>
    )}
  </UiEntity>
)
