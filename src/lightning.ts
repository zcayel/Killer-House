/**
 * LIGHTNING — the storm outside.
 *
 * Every so often the sky double-flashes (a huge cold light over the yard),
 * and a beat later the thunder CRACKS: the screen cuts to black for an
 * instant and the camera rumbles — a smooth, natural shake, not the violent
 * death jitter. The flash-then-thunder gap sells the distance of the storm.
 */

import { engine, Transform, LightSource, Entity } from '@dcl/sdk/ecs'
import { Vector3, Color3 } from '@dcl/sdk/math'
import { gameStarted, isPlayerDead } from './gameState'
import { playerPosition } from './playerTracker'
import { playSoundAt } from './sounds'
import { cameraShake } from './effects/deathEffects'
import { addSafeSystem } from './safeSystem'

export const SOUND_THUNDER = 'assets/sounds/thunder.wav' // CC0, freesound #243614 (trimmed)

/** Screen blackout at the moment the thunder hits (read by the UI overlay). */
export let blackoutAlpha = 0

const FIRST_STRIKE_SECONDS = 12
const STRIKE_INTERVAL_MIN = 30
const STRIKE_INTERVAL_MAX = 75
const THUNDER_AT = 0.9 // seconds after the flash — the storm is close
const BLACKOUT_PEAK = 0.85
// Earthquake-level, on request — was 1.1s @ 0.08 (barely a rumble; death's
// own hit-shake is 0.6s @ 0.35, so the old thunder shake was actually
// WEAKER than getting hit). Now longer AND well past death's amplitude, so
// a strike reads as the ground genuinely shaking, not a light rattle.
const SHAKE_SECONDS = 1.6
const SHAKE_AMPLITUDE = 0.45

let flashLight: Entity
let nextStrike = FIRST_STRIKE_SECONDS
let strikeClock = -1 // -1 = no strike in progress

function lightningSystem(dt: number) {
  if (!gameStarted) return

  if (blackoutAlpha > 0) blackoutAlpha = Math.max(0, blackoutAlpha - dt * 2.2)

  if (strikeClock < 0) {
    nextStrike -= dt
    if (nextStrike <= 0 && !isPlayerDead) strikeClock = 0
    return
  }

  const prev = strikeClock
  strikeClock += dt

  // double flash: on 0-0.12s, off, on again 0.2-0.38s
  const flashOn = strikeClock < 0.12 || (strikeClock >= 0.2 && strikeClock < 0.38)
  const f = LightSource.getMutable(flashLight)
  if (f.active !== flashOn) f.active = flashOn

  // the CRACK: sound + instant black + rumble. Every strike sounds a little
  // different: distance (0..1) picks how loud/deep/hard-hitting this one is.
  if (prev < THUNDER_AT && strikeClock >= THUNDER_AT) {
    const closeness = Math.random() // 0 = far-off roll, 1 = right overhead
    const volume = 0.22 + closeness * 0.26 // ~35% average, 22%-48% span
    const pitch = 0.75 + Math.random() * 0.4 // deep grumble ... sharp crack
    playSoundAt(SOUND_THUNDER, playerPosition, volume, pitch)
    blackoutAlpha = BLACKOUT_PEAK * (0.6 + closeness * 0.4)
    cameraShake(SHAKE_SECONDS, SHAKE_AMPLITUDE * (0.5 + closeness * 0.7), true)
  }

  if (strikeClock > 2.2) {
    strikeClock = -1
    nextStrike = STRIKE_INTERVAL_MIN + Math.random() * (STRIKE_INTERVAL_MAX - STRIKE_INTERVAL_MIN)
  }
}

export function initLightning() {
  // one huge cold light high over the middle of the plot
  flashLight = engine.addEntity()
  Transform.create(flashLight, { position: Vector3.create(16, 26, 16) })
  LightSource.create(flashLight, {
    type: LightSource.Type.Point({}),
    active: false,
    color: Color3.create(0.8, 0.85, 1.0),
    intensity: 40000,
    range: 60,
    shadow: false
  })

  addSafeSystem(lightningSystem, 'lightningSystem')
}
