/**
 * TRAP 4 — Pressure-plate portrait dart.
 *
 * Reuses the scene's existing "carpet" entity (named in Creator Hub) as the
 * pressure plate - if it can't be found by name, falls back to an invisible
 * trigger box at PRESSURE_PLATE_FALLBACK_POSITION so the trap still works.
 * Stepping on it starts a short warning beat (swap in a portrait-rattle
 * sound of your own if you have one), then fires the kitchen knife across
 * the room using the shared knifeProjectile helper.
 */

import { engine, Transform, TriggerArea, triggerAreaEventsSystem, Entity } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import {
  PRESSURE_PLATE_ENTITY_NAME,
  PRESSURE_PLATE_FALLBACK_POSITION,
  DART_LAUNCH_POINT,
  DART_TARGET_POINT,
  DART_WARNING_SECONDS,
  DART_SPEED,
  DART_HIT_RADIUS,
  PRESSURE_PLATE_COOLDOWN_SECONDS,
  MODEL_KITCHEN_KNIFE
} from '../config'
import { spawnKnifeProjectile } from '../knifeProjectile'
import { isInvulnerable } from '../gameState'
import { bus } from '../multiplayer'
import { addSafeSystem } from '../safeSystem'

export function initPressurePlateDart() {
  let plate = engine.getEntityOrNullByName(PRESSURE_PLATE_ENTITY_NAME)

  if (!plate) {
    // Fallback: build our own invisible plate if "carpet" wasn't found by name.
    plate = engine.addEntity()
    Transform.create(plate, { position: PRESSURE_PLATE_FALLBACK_POSITION, scale: Vector3.create(2, 0.2, 2) })
  }

  TriggerArea.setBox(plate)

  let cooldown = 0
  let armed = true
  // > 0 while the telegraph beat is counting down; 0 = idle. A single
  // persistent field + system (below) instead of spawning a fresh one-shot
  // system per trigger — that old pattern self-removed by function identity,
  // which breaks the moment the system is wrapped for crash isolation (the
  // wrapper is what's actually registered, so the raw reference never
  // removes anything and the dart would refire every frame forever).
  let warningRemaining = 0

  function trigger() {
    armed = false
    cooldown = PRESSURE_PLATE_COOLDOWN_SECONDS
    // Telegraph: the portrait/wall rattles for DART_WARNING_SECONDS before firing.
    // (Hook your own rattle sound/animation here if you add one later.)
    warningRemaining = DART_WARNING_SECONDS
  }

  triggerAreaEventsSystem.onTriggerEnter(plate, () => {
    if (!armed || isInvulnerable()) return
    trigger()
    // everyone else's plate fires too — the dart flies (and kills) on every client
    bus.emit('sh_dart', {})
  })

  // Fired because ANOTHER player stepped on the plate. Self-echo is harmless:
  // armed is already false by the time our own message returns.
  bus.on('sh_dart', () => {
    if (!armed) return
    trigger()
  })

  function fireDart() {
    spawnKnifeProjectile(
      MODEL_KITCHEN_KNIFE,
      DART_LAUNCH_POINT,
      DART_TARGET_POINT,
      DART_SPEED,
      DART_HIT_RADIUS,
      'Skewered by a knife from the wall'
    )
  }

  addSafeSystem((dt: number) => {
    if (cooldown > 0) {
      cooldown -= dt
      if (cooldown <= 0) armed = true
    }
    if (warningRemaining > 0) {
      warningRemaining -= dt
      if (warningRemaining <= 0) {
        warningRemaining = 0
        fireDart()
      }
    }
  }, 'pressurePlateDartSystem')
}
