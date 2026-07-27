/**
 * TRAP 6 — Chandelier elevator crush (replaces the old spawned-chandelier drop).
 *
 * Your scene already has the chandelier set up as a smart-item elevator
 * (entity "Vertical Red Pad" wearing chandelift.glb, riding y 3.18 <-> 13.18
 * on a 7-second loop). This system spawns nothing - it just watches that
 * entity every frame. If the chandelier is DESCENDING and its bottom passes
 * through a player standing underneath, they're crushed.
 *
 * Riding on top as an elevator stays safe: the kill only fires while the
 * bottom is moving down through the player's body, and a rider's feet are
 * always above the bottom.
 */

import { engine, Transform } from '@dcl/sdk/ecs'
import { CHANDELIER_ENTITY_NAME, CHANDELIER_BOTTOM_OFFSET, CHANDELIER_KILL_RADIUS } from '../config'
import { playerPosition } from '../playerTracker'
import { killPlayer, isInvulnerable } from '../gameState'
import { addSafeSystem } from '../safeSystem'

export function initChandelierCrush() {
  let chandelier = engine.getEntityOrNullByName(CHANDELIER_ENTITY_NAME)
  let prevBottomY: number | null = null

  function crushSystem(_dt: number) {
    // The smart item may not exist on the very first frames - keep looking.
    if (chandelier === null) {
      chandelier = engine.getEntityOrNullByName(CHANDELIER_ENTITY_NAME)
      if (chandelier === null) return
    }
    if (!Transform.has(chandelier)) return

    const t = Transform.get(chandelier)
    const bottomY = t.position.y + CHANDELIER_BOTTOM_OFFSET
    const descending = prevBottomY !== null && bottomY < prevBottomY - 0.0005
    prevBottomY = bottomY

    if (!descending || isInvulnerable()) return

    const flatDist = Math.hypot(playerPosition.x - t.position.x, playerPosition.z - t.position.z)
    if (flatDist > CHANDELIER_KILL_RADIUS) return

    // Player transform sits at the feet; kill while the descending bottom is
    // inside the body (above the ankles, below the head). A rider on top has
    // their feet above the bottom, so this never fires for them.
    const feetY = playerPosition.y
    if (bottomY > feetY + 0.25 && bottomY < feetY + 1.9) {
      killPlayer('Crushed under the chandelier')
    }
  }

  addSafeSystem(crushSystem, 'crushSystem')
}
