/**
 * Core survival-horror game loop: one hit = dead, short "You Died" beat,
 * then respawn back at the spawn point. Every trap/enemy in this project
 * calls killPlayer(cause) - nothing else moves or teleports the player.
 */

import { engine, InputModifier } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { movePlayerTo } from '~system/RestrictedActions'
import { RESPAWN_DELAY_SECONDS, RESPAWN_GRACE_SECONDS, SPAWN_POSITION, SPAWN_ROTATION } from './config'
import { addSafeSystem, reportFailure } from './safeSystem'

// False until the player clicks through the intro screen. While false the
// avatar can't move (InputModifier) and every hazard treats them as
// invulnerable, so nothing can happen before they've read the rules.
export let gameStarted = false

export function startGame() {
  if (gameStarted) return
  gameStarted = true
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({ disableAll: false })
  })
}

// THE INTRO NEVER STARTS ITSELF. It waits for the player, however long that
// takes (on request).
//
// There WAS a 12-second auto-start here, and the reason was not impatience: if
// the tap on "Enter the house" fails to register — and this scene has hit real,
// confirmed tap-reliability gaps on the mobile client — then gameStarted stays
// false forever. Everything gates on it, so the player would sit permanently
// invulnerable on an intro screen with no HUD and no way out. The timer was the
// escape hatch from that soft-lock.
//
// Deleting it needs that hatch replaced, not just removed, so the whole intro
// overlay is a tap target now (see the intro gate in ui.tsx) rather than the
// button alone. "The one button didn't register" stops being a failure mode
// when every pixel on the screen is the button. The visible button stays as the
// affordance — it just isn't the only thing listening any more.

// Short self-clearing movement lock, used by combat so the knife-slash emote
// isn't overridden by walking (scene emotes only play while standing still).
let freezeTimer = 0
export function freezePlayer(seconds: number) {
  if (!gameStarted) return
  freezeTimer = Math.max(freezeTimer, seconds)
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({ disableAll: true })
  })
}

export let isPlayerDead = false
export let lastDeathCause = ''
export let respawnCountdown = 0

type DeathListener = (cause: string) => void
const deathListeners: { cb: DeathListener; label: string }[] = []

/**
 * Register a callback fired the instant the player dies (for effects/sfx/UI).
 * `label` identifies it in the debug HUD's FAILED row if it ever throws —
 * without one, "a death listener threw on mobile" is as far as we could ever
 * narrow it down (there's no console on a phone to read `console.error`).
 */
export function onPlayerDeath(cb: DeathListener, label = 'deathListener') {
  deathListeners.push({ cb, label })
}

/**
 * Kills the player. Safe to call from multiple traps in the same frame -
 * once isPlayerDead is true, further calls are ignored until respawn,
 * so the player can't be "double killed" or skip the death beat.
 */
export function killPlayer(cause: string) {
  if (isPlayerDead || questInvulnerable) return
  isPlayerDead = true
  lastDeathCause = cause
  respawnCountdown = RESPAWN_DELAY_SECONDS
  // Dead players don't walk: the death screen covers the view, so without
  // this you could blindly wander during the whole respawn countdown. The
  // lock holds until respawnPlayer() re-enables input at the spawn point.
  // (Any combat freeze in flight is absorbed — this lock outlives it.)
  freezeTimer = 0
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({ disableAll: true })
  })
  // Each listener is independent (sound, tombstone/blood, hearts/defeat,
  // stats sync) — isolate them so one throwing (e.g. a stale synced
  // component from a hot-reloaded preview session) can't silently take the
  // rest of death handling down with it. Without this, a single failing
  // listener registered early (multiplayer.ts's is first) would abort this
  // loop and skip every listener after it, including gameLoop.ts's own
  // hearts-decrement/defeat logic — "death" would visibly happen but almost
  // nothing about it would actually work.
  for (const { cb, label } of deathListeners) {
    try {
      cb(cause)
    } catch (err) {
      reportFailure(`death:${label}`, err instanceof Error ? err.message : String(err))
      console.error(`onPlayerDeath listener '${label}' threw:`, err)
    }
  }
}

// Set by the quest while the win screen is up, so traps can't kill you
// mid-celebration.
let questInvulnerable = false
export function setQuestInvulnerable(v: boolean) {
  questInvulnerable = v
}

// Brief shield right after respawning, so a skeleton/trap sitting on the
// spawn point can't chain-kill you before you can move.
let graceCountdown = 0

/** Also called by the quest when the win-reset teleports you back to spawn. */
export function grantSpawnGrace() {
  graceCountdown = RESPAWN_GRACE_SECONDS
}

// Set while the last-candle preview camera has taken over (gameLoop.ts) —
// the player can't see or move themselves during that cut, so nothing should
// be able to hit them either. Kept separate from questInvulnerable rather
// than reusing it, since the two are unrelated features that could otherwise
// stomp on each other's on/off timing if they ever overlapped.
let cameraLockInvulnerable = false
export function setCameraLockInvulnerable(v: boolean) {
  cameraLockInvulnerable = v
}

/** Traps should skip their hit checks while this is true (intro/mid-death/respawn/win/camera-locked). */
export function isInvulnerable(): boolean {
  return !gameStarted || isPlayerDead || questInvulnerable || graceCountdown > 0 || cameraLockInvulnerable
}

function respawnPlayer() {
  // The client owns the player's Transform and rewrites it every frame, so
  // direct Transform writes get stomped. movePlayerTo is the sanctioned
  // teleport (scene.json already has ALLOW_TO_MOVE_PLAYER_INSIDE_SCENE).
  const lookDir = Vector3.rotate(Vector3.Forward(), SPAWN_ROTATION)
  movePlayerTo({
    newRelativePosition: SPAWN_POSITION,
    cameraTarget: Vector3.add(SPAWN_POSITION, Vector3.scale(lookDir, 5))
  }).catch((err) => {
    console.error('respawn movePlayerTo failed:', err)
  })
  isPlayerDead = false
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({ disableAll: false })
  })
  grantSpawnGrace()
}

/**
 * Skip the rest of the countdown — the death screen's "Respawn now" button.
 *
 * Safe to call at any point during the death, not just once the effects have
 * played out: everything that unwinds a death is edge-triggered on
 * isPlayerDead going false (deathEffects' shakeSystem watches for that flip to
 * clear the tombstone and un-hide the avatar) rather than run off a timer, so
 * nothing is left stranded by cutting the wait short. The camera shake keeps
 * running on its own clock and hands the camera back when it expires.
 *
 * No-op unless actually dead, so a stray click can't teleport a living player
 * back to spawn. The death overlay that hosts the button only renders while
 * roundPhase is 'playing', so this also can't fire on the third death, where
 * the defeat screen is up and the round is resetting anyway.
 */
export function respawnNow() {
  if (!isPlayerDead) return
  respawnCountdown = 0
  respawnPlayer()
}

function respawnSystem(dt: number) {
  if (graceCountdown > 0) graceCountdown -= dt
  if (freezeTimer > 0) {
    freezeTimer -= dt
    if (freezeTimer <= 0 && gameStarted) {
      InputModifier.createOrReplace(engine.PlayerEntity, {
        mode: InputModifier.Mode.Standard({ disableAll: false })
      })
    }
  }
  if (!isPlayerDead) return
  respawnCountdown -= dt
  if (respawnCountdown <= 0) {
    respawnCountdown = 0
    respawnPlayer()
  }
}

export function initGameState() {
  // Freeze the avatar until the intro screen is dismissed
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({ disableAll: true })
  })
  addSafeSystem(respawnSystem, 'respawnSystem')
}
