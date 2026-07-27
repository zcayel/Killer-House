/**
 * CORE HIT SYSTEM — shared player hit-testing used by hazards and (future)
 * battle mechanics. One place to tune how "touching" is judged, so every
 * weapon/trap that adopts these helpers behaves consistently.
 *
 * The player is modeled as a vertical capsule: a circle of PLAYER_BODY_RADIUS
 * in the XZ plane, from feet (transform y) up to PLAYER_HEIGHT. All tests
 * INCLUDE the body radius — a hitbox only has to reach the player's skin,
 * not their center — which is what makes hits land "every time it touches".
 */

import { Vector3 } from '@dcl/sdk/math'
import { playerPosition } from './playerTracker'

const PLAYER_BODY_RADIUS = 0.4 // avatar capsule radius, slightly generous
const PLAYER_HEIGHT = 1.9 // feet to top of head

/**
 * Does a horizontal line segment (a -> b, e.g. a spike shaft) of the given
 * thickness touch the player? XZ distance from the player's body circle to
 * the segment, plus a vertical overlap check between the hitbox's y-band
 * and the player's feet-to-head span.
 */
export function segmentHitsPlayer(a: Vector3, b: Vector3, thickness: number, yCenter: number, yHalfHeight: number): boolean {
  // Vertical: does [yCenter ± yHalfHeight] overlap [feet .. feet + height]?
  const feet = playerPosition.y
  if (yCenter + yHalfHeight < feet || yCenter - yHalfHeight > feet + PLAYER_HEIGHT) return false

  // Horizontal: closest point on the segment to the player, in XZ
  const abx = b.x - a.x
  const abz = b.z - a.z
  const len2 = abx * abx + abz * abz
  let t = 0
  if (len2 > 0) {
    t = ((playerPosition.x - a.x) * abx + (playerPosition.z - a.z) * abz) / len2
    t = Math.max(0, Math.min(1, t))
  }
  const cx = a.x + abx * t
  const cz = a.z + abz * t
  const dist = Math.hypot(playerPosition.x - cx, playerPosition.z - cz)
  return dist < thickness + PLAYER_BODY_RADIUS
}
