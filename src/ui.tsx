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
import { isPlayerDead, lastDeathCause, respawnCountdown, gameStarted, startGame } from './gameState'
import { knifeCollected } from './quest'
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
  portalCountdown,
  escapeRanking
} from './gameLoop'
import { BLOOD_OVERLAY_TEXTURE, RESPAWN_DELAY_SECONDS, KNIFE_ITEMS, ROUND_SECONDS, ROUND_HEARTS, WEAPONS_ENABLED, DEBUG_HUD, DARKNESS_VEIL_ENABLED } from './config'
import { darknessAlpha } from './candles'
import { blackoutAlpha } from './lightning'
import { trySlash, tryThrow } from './combat'
import { isInvulnerable } from './gameState'
import { isSimulationHost, readRemoteStats, otherPlayerPositions } from './multiplayer'
import { playerPosition } from './playerTracker'
import { playerInYard, nearestSkeletonDist } from './enemies/skeletons'
import { overFence } from './traps/fenceTips'
import { activeToasts } from './notifications'
import { failedLabels } from './safeSystem'
import {
  px,
  fs,
  a,
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
  T_HEAD,
  T_SCORE,
  STRIP_HEIGHT,
  STRIP_GAP,
  uiIsMobile
} from './uiTheme'

export function setupUi() {
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
  return 0.62 + 0.38 * Math.abs(Math.sin(portalCountdown * 2.2))
}

function candlesRemaining(): number {
  return Math.max(0, getCandlesRequired() - candlesLit)
}

// ── Copy ───────────────────────────────────────────────────────────────────
// Written from the player's side of the screen: plain verbs, sentence case,
// and never a claim the game does not actually know. The old copy asserted
// things like which room a candle was in; no state in this codebase records
// that, so it would have been a lie most of the time.

function exitLine(): string {
  if (portalReady) return `EXIT OPEN · ${Math.max(0, Math.ceil(portalCountdown))}s`
  const n = candlesRemaining()
  return n === 1 ? 'SEALED · 1 candle left' : `SEALED · ${n} candles left`
}

function winSubline(): string {
  if (lastWinWasBest && lastWinDelta === 0) return 'You escaped. Your first way out.'
  if (lastWinWasBest) return `You escaped. Fastest yet — ${Math.abs(lastWinDelta)}s under your old best.`
  return `You escaped. ${lastWinDelta}s off your best of ${formatTime(bestWinTimes[0])}.`
}

function defeatHeadline(): string {
  return defeatReason === 'time' ? 'The clock ran out.' : 'You ran out of hearts.'
}

function defeatSubline(): string {
  const lit = `You lit ${candlesLit} of ${getCandlesRequired()} candles`
  if (defeatReason === 'time') return `${lit}.`
  return `${lit} with ${formatTime(roundRemaining)} still on the clock.`
}

// 0 right after death (blood splat fully visible) -> 1 (solid black) about
// two-thirds of the way through the respawn countdown.
function fadeToBlackAlpha(): number {
  const progress = 1 - respawnCountdown / RESPAWN_DELAY_SECONDS
  return Math.min(1, Math.max(0, progress * 1.5))
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
        position: { top: px(12), left: 0 },
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
            maxWidth: px(480),
            height: px(T_SMALL * 1.8),
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
function overlayShell(tint: Color4, children: ReactEcs.JSX.ReactNode) {
  return (
    <UiEntity
      uiTransform={{ width: '100%', height: '100%', positionType: 'absolute' }}
      uiBackground={{ color: tint }}
    >
      <ScreenInsetArea
        uiTransform={{ flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}
      >
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
// SKEL is the flat distance to the nearest skeleton (kill happens under 1.2).
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

        {/* Exit status, top-left under the strip — paired with the strip's
            own candle-progress cells since both describe "how close to
            unlocked". Carries the candle count as a NUMBER: counting five to
            seven cells on a phone strip is above what anyone can do at a
            glance mid-panic, so the strip alone is not enough here. */}
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
            color: portalReady ? VEIL : ASH
          }}
        />

        {/* Clock + hearts, bottom-right. On mobile the explorer draws its own
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
            {heartPips(T_BODY)}
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
            positionType: 'absolute',
            position: { bottom: '22%', left: 0 },
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

    {/* Knife hotbar, bottom-centre. Parked behind WEAPONS_ENABLED. */}
    {WEAPONS_ENABLED && gameStarted && roundPhase === 'playing' && !isPlayerDead && (
      <ScreenInsetArea uiTransform={{ pointerFilter: 'none' }}>
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { bottom: px(14), left: 0 },
            width: '100%',
            flexDirection: 'row',
            justifyContent: 'center'
          }}
        >
          {KNIFE_ITEMS.map((item, i) => (
          <UiEntity
            key={item.entityName}
            uiTransform={{
              width: px(88),
              height: px(108),
              margin: { left: px(6), right: px(6) },
              flexDirection: 'column',
              alignItems: 'center',
              padding: { top: px(9) }
            }}
            uiBackground={{ color: a(VOID, knifeCollected[i] ? 0.8 : 0.55) }}
            // Tap-to-act on mobile (no keyboard for keys 1/2): slot 0 slashes,
            // slot 1 throws. Desktop keeps using the keys too — same functions.
            onMouseDown={i === 0 ? trySlash : i === 1 ? tryThrow : undefined}
          >
            <UiEntity
              uiTransform={{ width: px(66), height: px(66) }}
              uiBackground={
                knifeCollected[i]
                  ? { textureMode: 'stretch', texture: { src: item.icon } }
                  : { color: a(WAX, 0.07) }
              }
            />
            <UiEntity
              uiTransform={{ width: px(66), height: px(28) }}
              uiText={{
                value: `${i + 1}`,
                fontSize: fs(T_SMALL),
                font: FONT_DATA,
                textAlign: 'middle-center',
                color: knifeCollected[i] ? WAX : ASH
              }}
            />
            </UiEntity>
          ))}
        </UiEntity>
      </ScreenInsetArea>
    )}

    {/* ── INTRO GATE ───────────────────────────────────────────────────── */}
    {!gameStarted &&
      overlayShell(a(VOID, 0.94), [
        <UiEntity
          key="title"
          uiTransform={{ width: '100%', height: px(T_MICRO * 2) }}
          uiText={{
            value: 'SPOOKY HOUSE',
            fontSize: fs(T_MICRO),
            font: FONT_DATA,
            textAlign: 'middle-center',
            color: ASH
          }}
        />,
        <UiEntity
          key="head"
          uiTransform={{ width: '100%', height: px(T_HEAD * 1.4) }}
          uiText={{
            // Round-aware: says 5 on round one and 7 after, so the number the
            // player is told is the number they actually have to light.
            value: `Light ${getCandlesRequired()} candles. Get out.`,
            fontSize: fs(T_HEAD),
            font: FONT_DISPLAY,
            textAlign: 'middle-center',
            color: WAX
          }}
        />,
        <UiEntity
          key="sub"
          uiTransform={{ width: '100%', height: px(T_BODY * 3.4), margin: { top: px(6) } }}
          uiText={{
            value:
              'They are hidden across the yard and the house — the front door is straight ahead. ' +
              'Skeletons hunt you and the wall spikes fire on their own. Three hearts, one touch kills, three minutes.',
            fontSize: fs(T_BODY),
            font: FONT_BODY,
            textAlign: 'middle-center',
            color: BONE
          }}
        />,
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
      ])}

    {/* ── WIN ──────────────────────────────────────────────────────────── */}
    {roundPhase === 'won' && (
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
          />
        ])}
        {/* Frozen at the exact gap you escaped on — the thing you read all
            round becomes the trophy. Same safe-area treatment as the live
            strip, so the trophy sits exactly where the HUD did. */}
        <ScreenInsetArea uiTransform={{ pointerFilter: 'none' }}>{strip(true)}</ScreenInsetArea>
      </UiEntity>
    )}

    {/* ── DEFEAT ───────────────────────────────────────────────────────── */}
    {roundPhase === 'defeated' &&
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
        />
      ])}

    {/* ── DEATH ────────────────────────────────────────────────────────── */}
    {/* Scrim, blood and fade cover the FULL canvas (a splatter that stops at
        the notch line reads as a bug); only the readable column is
        constrained to the safe area. */}
    {isPlayerDead && roundPhase === 'playing' && (
      <UiEntity
        uiTransform={{ width: '100%', height: '100%', positionType: 'absolute' }}
        uiBackground={{ color: a(RUST, 0.35) }}
      >
        {/* Blood splatter around the screen edges, behind the text. With no
            red anywhere on the HUD, this is one of the only reds in the game
            and it lands harder for it. */}
        <UiEntity
          uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', position: { top: 0, left: 0 } }}
          uiBackground={{ textureMode: 'stretch', texture: { src: BLOOD_OVERLAY_TEXTURE } }}
        />
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
