/**
 * TRAP 8 — Swinging blade ("pblade").
 *
 * A player-placed pendulum prop that swings continuously via its own baked
 * Animator clip — never hidden or triggered, always live, so there's no
 * arm/telegraph state machine here the way the other traps have.
 *
 * See the header comment on the BLADE_* constants in config.ts for the full
 * reasoning. Short version: on desktop this asks the model's OWN real
 * physics collider directly (an immediate, synchronously-called raycast —
 * NOT the continuous background kind that caused this project's documented
 * mobile freeze), so it always matches wherever the blade actually is, with
 * no config to keep in sync. On mobile, real raycasts are exactly the risk
 * category that caused that freeze, so it falls back to a geometric
 * approximation driven by real measured swing data instead.
 */

import { engine, Transform, raycastSystem, RaycastQueryType, ColliderLayer, Entity } from '@dcl/sdk/ecs'
import {
  BLADE_ENTITY_NAME,
  BLADE_POSITION,
  BLADE_SCALE,
  BLADE_CYCLE_SECONDS,
  BLADE_KILL_MARGIN,
  BLADE_TOUCH_DISTANCE,
  BLADE_OUTER_GATE_RADIUS,
  BLADE_RAYCAST_DIRECTIONS,
  BLADE_SWING_KEYFRAMES
} from '../config'
import { playerPosition } from '../playerTracker'
import { killPlayer, isInvulnerable } from '../gameState'
import { addSafeSystem } from '../safeSystem'
import { isMobileNow, platformKnown } from '../platform'

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Mobile-only fallback: the blade's real measured reach at any point in its cycle, scaled to the model's actual placed size. */
function currentReach(phase: number): { radius: number; yMin: number; yMax: number } {
  const frames = BLADE_SWING_KEYFRAMES
  let i = 0
  while (i < frames.length - 2 && frames[i + 1].t <= phase) i++
  const a = frames[i]
  const b = frames[i + 1]
  const span = b.t - a.t
  const t = span > 0 ? (phase - a.t) / span : 0

  const reachA = Math.max(Math.abs(a.rightMin), Math.abs(a.rightMax))
  const reachB = Math.max(Math.abs(b.rightMin), Math.abs(b.rightMax))

  return {
    radius: lerp(reachA, reachB, t) * BLADE_SCALE + BLADE_KILL_MARGIN,
    yMin: BLADE_POSITION.y + lerp(a.upMin, b.upMin, t) * BLADE_SCALE - BLADE_KILL_MARGIN,
    yMax: BLADE_POSITION.y + lerp(a.upMax, b.upMax, t) * BLADE_SCALE + BLADE_KILL_MARGIN
  }
}

let elapsed = 0

function mobileFallbackCheck(): boolean {
  // elapsed is advanced by the caller (the main safeSystem callback) before this runs.
  const phase = (elapsed % BLADE_CYCLE_SECONDS) / BLADE_CYCLE_SECONDS
  const reach = currentReach(phase)
  if (playerPosition.y < reach.yMin || playerPosition.y > reach.yMax) return false
  const flat = Math.hypot(playerPosition.x - BLADE_POSITION.x, playerPosition.z - BLADE_POSITION.z)
  return flat <= reach.radius
}

/**
 * Casts BLADE_RAYCAST_DIRECTIONS short rays out from the player, filtered to
 * physics colliders, and checks whether any hit landed on the blade itself
 * within BLADE_TOUCH_DISTANCE. Uses the IMMEDIATE raycastSystem.registerRaycast
 * (synchronous, called from inside this already-safeSystem-wrapped function)
 * rather than a continuous background-registered callback — see the header
 * comment on why that distinction is the whole point.
 */
function touchingBladeCollider(feeler: Entity, bladeEntity: Entity): boolean {
  for (const dir of BLADE_RAYCAST_DIRECTIONS) {
    let result: ReturnType<typeof raycastSystem.registerRaycast>
    try {
      result = raycastSystem.registerRaycast(
        feeler,
        raycastSystem.globalDirectionOptions({
          queryType: RaycastQueryType.RQT_HIT_FIRST,
          direction: dir,
          maxDistance: BLADE_TOUCH_DISTANCE,
          collisionMask: ColliderLayer.CL_PHYSICS
        })
      )
    } catch (_) {
      continue // one bad ray must not stop the others from being checked
    }
    const hits = result?.hits
    if (hits !== undefined && hits.length > 0 && hits[0].entityId === bladeEntity) {
      return true
    }
  }
  return false
}

export function initSwingingBlade() {
  const bladeEntity = engine.getEntityOrNullByName(BLADE_ENTITY_NAME)

  // The feeler needs a Transform to anchor each raycast's origin — reused
  // every frame, moved to the player's current position each check.
  const feeler = engine.addEntity()
  Transform.create(feeler, { position: { x: playerPosition.x, y: playerPosition.y + 1, z: playerPosition.z } })

  addSafeSystem((dt: number) => {
    elapsed += dt
    if (isInvulnerable()) return

    // Cheap pre-filter regardless of platform — nothing below runs at all
    // unless the player is even roughly near the blade.
    const flatToBlade = Math.hypot(playerPosition.x - BLADE_POSITION.x, playerPosition.z - BLADE_POSITION.z)
    if (flatToBlade > BLADE_OUTER_GATE_RADIUS) return

    if (!isMobileNow() && platformKnown() && bladeEntity !== null) {
      Transform.getMutable(feeler).position = { x: playerPosition.x, y: playerPosition.y + 1, z: playerPosition.z }
      if (touchingBladeCollider(feeler, bladeEntity)) {
        killPlayer('Cut down by the swinging blade')
      }
      return
    }

    // Mobile (or platform not yet known, or the entity wasn't found by
    // name) — geometric fallback.
    if (mobileFallbackCheck()) {
      killPlayer('Cut down by the swinging blade')
    }
  }, 'swingingBladeSystem')
}
