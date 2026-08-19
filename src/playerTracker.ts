/**
 * Tracks the player's position and velocity every frame.
 * Other systems (predictive spikes, hunting knife) read these instead of
 * each re-computing their own player deltas.
 */

import { engine, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { addSafeSystem } from './safeSystem'

export let playerPosition: Vector3 = Vector3.create(0, 0, 0)
export let playerVelocity: Vector3 = Vector3.create(0, 0, 0)

let prevPos: Vector3 | null = null

function trackerSystem(dt: number) {
  if (dt <= 0) return
  if (!Transform.has(engine.PlayerEntity)) return

  const pos = Transform.get(engine.PlayerEntity).position
  playerPosition = Vector3.create(pos.x, pos.y, pos.z)

  if (prevPos) {
    playerVelocity = Vector3.create(
      (pos.x - prevPos.x) / dt,
      (pos.y - prevPos.y) / dt,
      (pos.z - prevPos.z) / dt
    )
  }

  prevPos = Vector3.create(pos.x, pos.y, pos.z)
}

export function initPlayerTracker() {
  addSafeSystem(trackerSystem, 'trackerSystem', 90) // high priority so other systems read fresh data
}

/** Predicts where the player will be `seconds` from now, assuming constant velocity. */
export function predictPlayerPosition(seconds: number): Vector3 {
  return Vector3.create(
    playerPosition.x + playerVelocity.x * seconds,
    playerPosition.y + playerVelocity.y * seconds,
    playerPosition.z + playerVelocity.z * seconds
  )
}
