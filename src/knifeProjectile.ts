/**
 * Reusable flying-knife projectile. Spawns a knife model, tweens it in a
 * straight line from `from` to `to`, and kills the player if they're within
 * hitRadius of the knife's current position at any point mid-flight.
 * Used by the portrait pressure-plate trap; the same helper can be called
 * from anywhere else you want a thrown-knife hazard.
 */

import { engine, Transform, GltfContainer, Entity, Tween, EasingFunction } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { killPlayer, isInvulnerable } from './gameState'
import { distanceToPlayer } from './playerTracker'
import { addSafeSystem } from './safeSystem'

export function spawnKnifeProjectile(
  modelSrc: string,
  from: Vector3,
  to: Vector3,
  speedMetersPerSecond: number,
  hitRadius: number,
  deathCause: string
) {
  const knife = engine.addEntity()

  const direction = Vector3.subtract(to, from)
  const distance = Vector3.length(direction)
  const durationMs = Math.max(50, (distance / speedMetersPerSecond) * 1000)

  // Orient the knife to point along its flight path.
  const forward = Vector3.normalize(direction)
  const rotation = Quaternion.lookRotation(forward)

  Transform.create(knife, { position: from, rotation, scale: Vector3.create(1.4, 1.4, 1.4) })
  GltfContainer.create(knife, { src: modelSrc })

  Tween.create(knife, {
    mode: Tween.Mode.Move({ start: from, end: to }),
    duration: durationMs,
    easingFunction: EasingFunction.EF_LINEAR
  })

  let elapsed = 0
  let resolved = false

  function flightSystem(dt: number) {
    if (resolved) return
    elapsed += dt * 1000

    if (!isInvulnerable() && Transform.has(knife)) {
      const knifePos = Transform.get(knife).position
      if (distanceToPlayer(knifePos) <= hitRadius) {
        resolved = true
        killPlayer(deathCause)
        cleanup()
        return
      }
    }

    if (elapsed >= durationMs) {
      resolved = true
      cleanup()
    }
  }

  function cleanup() {
    engine.removeSystem(flightSystem)
    engine.removeEntity(knife)
  }

  // `resolved` guards every branch above, so this is safely inert once done
  // even though the removeSystem(flightSystem) call below can no longer find
  // the actually-registered (wrapped) system to remove — harmless, not a leak
  // risk like the dart/chandelier patterns were (no re-firing on completion).
  addSafeSystem(flightSystem, 'knifeFlightSystem')

  return knife
}
