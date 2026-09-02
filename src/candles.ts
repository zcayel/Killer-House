/**
 * LIGHTING SUPPORT — the darkness veil, the player's personal "eyes
 * adjusted" glow, and the chandelier's warm light.
 *
 * The ONLY candles in the game are the ritual candles the house assigns you
 * each round (see gameLoop.ts). The hand-placed decorative candle props from
 * the editor are hidden at startup, so the scene never shows a candle that
 * can't be lit.
 */

import { engine, Transform, LightSource, VisibilityComponent, Name, Entity } from '@dcl/sdk/ecs'
import { Vector3, Color3 } from '@dcl/sdk/math'
import { gameStarted } from './gameState'
import { playerPosition } from './playerTracker'
import { addSafeSystem } from './safeSystem'
import { isMobileNow, platformKnown } from './platform'
import {
  CHANDELIER_ENTITY_NAME,
  CANDLE_GLOW_INTENSITY,
  CANDLE_GLOW_RANGE,
  CANDLE_CORE_GLOW_INTENSITY,
  CANDLE_CORE_GLOW_RANGE,
  HOUSE_RECT,
  YARD_DARKNESS,
  DARK_LIGHT_RANGE,
  MOBILE_DARK_LIGHT_INTENSITY,
  MOBILE_DARK_LIGHT_RANGE,
  DARK_LIGHT_INTENSITY,
  INTERIOR_DARKNESS
} from './config'

// screen-darkness: reverted back to per-zone (the "make it the same
// everywhere" pass was undone on request) — near-black in the house, a
// lighter permanent gloom out in the yard. It never adjusts for candle
// brightness or door state; the flames (and a door's own moonlight, a real
// light, not this veil) are the only relief.
export let darknessAlpha = 0

/**
 * The baseline glow the player carries, kept so the mobile boost can find it.
 *
 * Applied from a system rather than at creation because getPlatform() answers
 * ASYNCHRONOUSLY — isMobileNow() reads false until the explorer replies, so a
 * phone asked at init time gets told it is a desktop and keeps the dim light
 * forever. Latched once, the first frame the real answer is in.
 */
let baselineLight: Entity | null = null
let baselineLightTuned = false

const FLAME_COLOR = Color3.create(1.0, 0.72, 0.42)
const DARK_COLOR = Color3.create(0.5, 0.55, 0.75) // cold moonlit gray-blue

function candleSystem(dt: number) {
  if (!baselineLightTuned && platformKnown() && baselineLight !== null) {
    baselineLightTuned = true
    if (isMobileNow()) {
      const l = LightSource.getMutable(baselineLight)
      l.intensity = MOBILE_DARK_LIGHT_INTENSITY
      l.range = MOBILE_DARK_LIGHT_RANGE
    }
  }
  if (!gameStarted) return
  const p = playerPosition
  const insideHouse = p.y > 2 && p.x > HOUSE_RECT.minX && p.x < HOUSE_RECT.maxX && p.z > HOUSE_RECT.minZ && p.z < HOUSE_RECT.maxZ
  const darknessTarget = insideHouse ? INTERIOR_DARKNESS : YARD_DARKNESS
  darknessAlpha += (darknessTarget - darknessAlpha) * Math.min(1, dt * 8)
}

export function initCandles() {
  // baseline "eyes adjusted to the dark" glow — constant, doesn't upgrade;
  // real light comes from the ritual candles you've lit
  const light = engine.addEntity()
  Transform.create(light, { position: Vector3.create(0, 1.1, 0), parent: engine.PlayerEntity })
  LightSource.create(light, {
    type: LightSource.Type.Point({}),
    active: true,
    color: DARK_COLOR,
    intensity: DARK_LIGHT_INTENSITY,
    range: DARK_LIGHT_RANGE,
    shadow: false
  })
  baselineLight = light

  // Hide every hand-placed decorative candle (found by name). Only the
  // ritual candles — spawned by gameLoop.ts — should ever be visible.
  for (const [ent, name] of engine.getEntitiesWith(Name)) {
    if (!name.value.startsWith('Candle')) continue
    VisibilityComponent.createOrReplace(ent, { visible: false })
  }

  // The chandelier elevator carries a warm candle-glow too — same flame
  // color AND the exact same attributes as the ritual candles (on request),
  // riding up and down with it. The smart item may not exist on the very
  // first frames, so keep trying until found.
  // Guarded by a flag rather than self-removing-by-identity, because
  // addSafeSystem wraps this function in its own closure — removing "this"
  // reference wouldn't remove the actually-registered wrapper, and the glow
  // would get re-added every single frame.
  let chandelierGlowAttached = false
  addSafeSystem((_dt: number) => {
    if (chandelierGlowAttached) return
    const chandelier = engine.getEntityOrNullByName(CHANDELIER_ENTITY_NAME)
    if (chandelier === null) return
    chandelierGlowAttached = true
    const glow = engine.addEntity()
    Transform.create(glow, { position: Vector3.create(0, 0.4, 0), parent: chandelier })
    LightSource.create(glow, {
      type: LightSource.Type.Point({}),
      active: true,
      color: FLAME_COLOR,
      intensity: CANDLE_GLOW_INTENSITY,
      range: CANDLE_GLOW_RANGE,
      shadow: false
    })

    // Same two-light treatment as the ritual candles: a tight, brighter core
    // layered right on top of the wide room-fill light above.
    const coreGlow = engine.addEntity()
    Transform.create(coreGlow, { position: Vector3.create(0, 0.4, 0), parent: chandelier })
    LightSource.create(coreGlow, {
      type: LightSource.Type.Point({}),
      active: true,
      color: FLAME_COLOR,
      intensity: CANDLE_CORE_GLOW_INTENSITY,
      range: CANDLE_CORE_GLOW_RANGE,
      shadow: false
    })
  }, 'chandelierGlowAttach')

  addSafeSystem(candleSystem, 'candleSystem')
}
