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

import {
  engine,
  Transform,
  MeshCollider,
  ColliderLayer,
  InputAction,
  pointerEventsSystem,
  Entity
} from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import {
  CHANDELIER_ENTITY_NAME,
  CHANDELIER_BOTTOM_OFFSET,
  CHANDELIER_KILL_RADIUS,
  CHANDELIER_HOVER_TEXT,
  CHANDELIER_HOVER_SIZE
} from '../config'
import { volumeCylinder, VOLUME_COLOURS } from '../debug/killVolumes'
import { playerPosition } from '../playerTracker'
import { killPlayer, isInvulnerable } from '../gameState'
import { addSafeSystem } from '../safeSystem'

/**
 * "Jump to ride" when you look at the chandelier.
 *
 * A CHILD of the lift, so it rides up and down with it for free — no per-frame
 * work and no way for the hint to be left behind when the elevator moves, which
 * is the bug the swing traps had with their hit boxes.
 *
 * CL_POINTER only. A CL_PHYSICS box here would be an invisible solid slab
 * riding through the room at head height; invisibleMeshesCollisionMask defaults
 * to physics in this SDK and that default has bitten this scene before, so the
 * layer is named explicitly.
 */
function addHoverHint(chandelier: Entity): void {
  const hint = engine.addEntity()
  Transform.create(hint, {
    position: Vector3.create(0, 0, 0),
    scale: Vector3.clone(CHANDELIER_HOVER_SIZE),
    parent: chandelier
  })
  MeshCollider.setBox(hint, ColliderLayer.CL_POINTER)
  pointerEventsSystem.onPointerDown(
    {
      entity: hint,
      opts: {
        // IA_POINTER, not IA_ANY: the hover UI prints the action name before
        // the text, and IA_ANY prints "Any" — the hint read "Any Jump to ride".
        button: InputAction.IA_POINTER,
        hoverText: CHANDELIER_HOVER_TEXT,
        // Roughly the height of one storey: close enough that the hint is
        // about the lift in front of you, not one three floors up.
        maxDistance: 8
      }
    },
    () => {} // hint only — riding it is a jump, not a click
  )
}

export function initChandelierCrush() {
  let chandelier = engine.getEntityOrNullByName(CHANDELIER_ENTITY_NAME)
  let prevBottomY: number | null = null
  let hinted = false
  if (chandelier !== null) {
    addHoverHint(chandelier)
    hinted = true
  }

  function crushSystem(_dt: number) {
    // The smart item may not exist on the very first frames - keep looking.
    if (chandelier === null) {
      chandelier = engine.getEntityOrNullByName(CHANDELIER_ENTITY_NAME)
      if (chandelier === null) return
    }
    if (!Transform.has(chandelier)) return
    // The smart item can arrive a few frames after init, so the hint is
    // attached the first time we actually have the entity.
    if (!hinted) {
      addHoverHint(chandelier)
      hinted = true
    }

    const t = Transform.get(chandelier)
    const bottomY = t.position.y + CHANDELIER_BOTTOM_OFFSET
    const descending = prevBottomY !== null && bottomY < prevBottomY - 0.0005
    prevBottomY = bottomY

    // Debug overlay. The band is the one the kill test uses below: from the
    // descending bottom edge up through a standing body. It follows the
    // chandelier down, so you can see the moment it becomes lethal.
    volumeCylinder(
      'chandelier',
      0,
      t.position,
      CHANDELIER_KILL_RADIUS,
      bottomY - 1.9,
      bottomY,
      VOLUME_COLOURS.chandelier
    )

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
