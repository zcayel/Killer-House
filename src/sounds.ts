/**
 * SOUNDS — ambient loop + one-shot effects.
 *
 * playSoundAt() spawns a temporary positional audio entity and removes it a
 * few seconds later; any trap/enemy can call it. The ambient loop rides on
 * the player so it never fades with distance. The player-death splat is
 * hooked up here via onPlayerDeath so no other file has to remember it.
 */

import { engine, Transform, AudioSource, Entity } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { onPlayerDeath, gameStarted, isPlayerDead } from './gameState'
import { playerPosition } from './playerTracker'
import { nearestSkeletonDistance, playerInYard } from './enemies/skeletons'
import { addSafeSystem } from './safeSystem'
import { MASTER_VOLUME } from './config'

export const SOUND_AMBIENT = 'assets/sounds/ambient.mp3'
export const SOUND_SKELETON_ATTACK = 'assets/sounds/skeleton_attack.mp3'
/**
 * SIX DEATH SOUNDS, picked at random — on request 2026-08-20.
 *
 * One sample is fine the first time you die and grating by the tenth, and this
 * scene kills you a lot. [1] is the original; [2]-[6] are the same splat
 * re-pitched and re-filtered (deeper and heavier, sharper and closer, muffled
 * as if a room away, a brittle bone crack, and a cavernous one with a tail).
 * Derived from the shipped sample on purpose — five unrelated downloads would
 * not sit in the same sonic world as each other or as the rest of the scene.
 */
export const SOUND_DEATH = 'assets/sounds/death_splat.wav'
const DEATH_SOUNDS = [
  SOUND_DEATH,
  'assets/sounds/death_2.wav',
  'assets/sounds/death_3.wav',
  'assets/sounds/death_4.wav',
  'assets/sounds/death_5.wav',
  'assets/sounds/death_6.wav'
]
/** Last one played, so the same death never lands twice in a row. */
let lastDeathSound = -1

function pickDeathSound(): string {
  if (DEATH_SOUNDS.length < 2) return DEATH_SOUNDS[0]
  let i = lastDeathSound
  while (i === lastDeathSound) i = Math.floor(Math.random() * DEATH_SOUNDS.length)
  lastDeathSound = i
  return DEATH_SOUNDS[i]
}
export const SOUND_SPIKE = 'assets/sounds/spike_thrust.mp3'
export const SOUND_SWING = 'assets/sounds/swing.mp3'
/**
 * The axes get their own whoosh — the planks keep SOUND_SWING.
 *
 * A 9m blade and a falling board should not make the same noise. Synthesised
 * rather than downloaded, so it carries no licence with it: three layers of
 * filtered noise (mid band for the air being cut, a low band for the weight
 * behind it, a bright spike for the edge passing you), 0.8s.
 */
export const SOUND_AXE_SWING = 'assets/sounds/axe_swing.wav'
export const SOUND_HEARTBEAT = 'assets/sounds/heartbeat.mp3' // CC0, freesound #485076
export const SOUND_BONE_RATTLE = 'assets/sounds/bone_rattle.mp3' // CC0, freesound #202102
export const SOUND_CANDLE_LIGHT = 'assets/sounds/candle_lit.mp3' // plays once a candle is fully lit
export const SOUND_CANDLE_LIGHTING_START = 'assets/sounds/candle_lighting_start.mp3' // plays the instant a channel begins
// Synthesised rather than sourced — see forcefield-source/make_forcefield_sound.py
// for the five layers and how to regenerate it. Replaces the spike-thrust
// stand-in the barrier used to borrow.
export const SOUND_FORCE_FIELD = 'assets/sounds/forcefield_hit.wav'
// The swinging plank landing. Synthesised (wood-source/make_wood_impact.py):
// contact crack + the board's own struck-bar modes + a floor thump. Played
// twice per landing — the hit, then a quieter settle — see SWING_TRAP_PLANK_*.
export const SOUND_WOOD_IMPACT = 'assets/sounds/wood_impact.wav'
export const SOUND_PORTAL_APPEAR = 'assets/sounds/portal_appear.mp3'
export const SOUND_VICTORY = 'assets/sounds/victory.mp3'

const oneShots: { entity: Entity; ttl: number }[] = []

/**
 * `global` (on request, for the win/portal-appear sounds specifically):
 * plays at constant volume for every player in the scene regardless of
 * distance, instead of the normal positional falloff — a match/reward beat
 * everyone should hear, not just whoever's standing close.
 */
/**
 * MASTER_VOLUME applied, clamped to what the engine will actually honour.
 *
 * DCL caps an AudioSource at 1.0 and silently ignores anything above, so a
 * sound already at full volume cannot be raised — clamping here makes that
 * explicit rather than leaving a number in the code that looks like it does
 * something. Every AudioSource in this file goes through it.
 */
export function gain(v: number): number {
  return Math.min(1, v * MASTER_VOLUME)
}

export function playSoundAt(src: string, pos: Vector3, volume = 1, pitch = 1, global = false) {
  const e = engine.addEntity()
  Transform.create(e, { position: Vector3.create(pos.x, pos.y, pos.z) })
  AudioSource.create(e, {
    audioClipUrl: src,
    playing: true,
    loop: false,
    volume: gain(volume),
    pitch,
    global
  })
  oneShots.push({ entity: e, ttl: 6 })
}

function cleanupSystem(dt: number) {
  for (let i = oneShots.length - 1; i >= 0; i--) {
    oneShots[i].ttl -= dt
    if (oneShots[i].ttl <= 0) {
      engine.removeEntity(oneShots[i].entity)
      oneShots.splice(i, 1)
    }
  }
}

// --- tension layer ---------------------------------------------------------
// A heartbeat rides on the player: silent normally, swelling as the nearest
// standing skeleton closes in (full pounding at ~2m). While the heart races,
// the ambient track ducks so the world goes quiet around the danger.
const AMBIENT_VOLUME = 0.3
const HEARTBEAT_MAX_DISTANCE = 14 // starts to be audible inside this range
let ambientEntity: Entity
let heartbeatEntity: Entity
let tensionClock = 0

function tensionSystem(dt: number) {
  tensionClock -= dt
  if (tensionClock <= 0) {
    tensionClock = 0.25
    const d = nearestSkeletonDistance()
    let fear = d >= HEARTBEAT_MAX_DISTANCE ? 0 : Math.min(1, (HEARTBEAT_MAX_DISTANCE - d) / (HEARTBEAT_MAX_DISTANCE - 2))
    // Skeletons can't enter the house — indoors the heartbeat stays a
    // muffled dread instead of a full false alarm.
    if (!playerInYard()) fear *= 0.35
    const hb = AudioSource.getMutable(heartbeatEntity)
    hb.volume = gain(fear * 0.9)
    hb.playing = gameStarted && !isPlayerDead && fear > 0.03
    AudioSource.getMutable(ambientEntity).volume = gain(AMBIENT_VOLUME * (1 - 0.65 * fear))
  }
}

export function initSounds() {
  // Spooky ambience, parented to the player so it's always audible
  ambientEntity = engine.addEntity()
  Transform.create(ambientEntity, { parent: engine.PlayerEntity })
  AudioSource.create(ambientEntity, { audioClipUrl: SOUND_AMBIENT, playing: true, loop: true, volume: gain(AMBIENT_VOLUME) })

  heartbeatEntity = engine.addEntity()
  Transform.create(heartbeatEntity, { parent: engine.PlayerEntity })
  AudioSource.create(heartbeatEntity, { audioClipUrl: SOUND_HEARTBEAT, playing: false, loop: true, volume: 0 })

  onPlayerDeath(() => playSoundAt(pickDeathSound(), playerPosition, 1))

  addSafeSystem(cleanupSystem, 'soundsCleanupSystem')
  addSafeSystem(tensionSystem, 'soundsTensionSystem')
}
