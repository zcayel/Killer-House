/**
 * THE OLD TABLE — re-asserted from code, because it stopped being drawn.
 *
 * WHAT WAS CHECKED FIRST, so nobody re-walks this ground. The table was
 * reported invisible in world, and none of the usual suspects held up:
 *
 *   * main.crdt (the file the runtime loads, NOT main.composite) still carries
 *     entity 583 with `assets/scene/Models/oldtable/oldtable.glb` at
 *     (18, 3.213, 18.181), scale 1, no parent — byte for byte identical to the
 *     copy in HEAD, so nothing about the placement has drifted.
 *   * the GLB is intact and unchanged since the initial commit: node `oldtable`
 *     carries mesh Cube.044, 1832 verts / 1368 triangles, one material with a
 *     base-colour and a normal map, plus a separate `oldtable_collider` node.
 *   * its two textures (m011_base.jpg, m011_normal.jpg) are valid JPEGs sitting
 *     next to it, and .dclignore excludes neither. They are EXTERNAL rather
 *     than embedded, which is unusual — but wallshelf.glb references the very
 *     same two files the same way and renders fine, with the butcher's knife
 *     resting on it in plain sight.
 *   * it is not buried. Ray-casting KHN.glb (the house model that replaced
 *     KILLERHOUSE_.glb) straight down through the table's footprint puts the
 *     ground-floor surface at y 2.66; the table's own base sits at 2.60 and its
 *     top at 3.93, so it stands ON that floor exactly as it should.
 *
 * WHICH LEAVES the entity itself losing its model at runtime — a component
 * cleared, a composite that came up short on some clients, a stray hide. All of
 * those look identical from in world and none of them can be seen from here, so
 * this stops diagnosing and makes the table's presence something the scene
 * guarantees rather than something it inherits.
 *
 * IT CANNOT DOUBLE THE TABLE. The placed entity is ADOPTED when it exists —
 * its GltfContainer is rewritten and any VisibilityComponent on it cleared — so
 * the common case is one entity with one model on it, exactly as before. Only
 * when the anchor genuinely never appears does this build its own, at the
 * transform read out of main.crdt.
 *
 * The mirror of leaderboard.ts, which adopts the same way and for the same
 * reason: a hand-placed entity is a thing another program owns, and code that
 * depends on one has to say what happens when it is not there.
 */

import { engine, Transform, GltfContainer, ColliderLayer, VisibilityComponent, Entity } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import {
  OLD_TABLE_MODEL,
  OLD_TABLE_POSITION,
  OLD_TABLE_VISIBLE_COLLISION_MASK,
  OLD_TABLE_INVISIBLE_COLLISION_MASK
} from '../config'
import { addSafeSystem, reportFailure } from '../safeSystem'

/**
 * The Creator Hub name, as a LIST for the same reason leaderboard.ts keeps one:
 * it is a hand-typed label in another program, and this file goes quiet the
 * moment it stops matching. Add to this rather than editing it.
 */
const TABLE_ENTITY_NAMES = ['oldtable', 'oldtable.glb', 'old_table', 'Old Table']

/** How long to keep looking before giving up and building our own. */
const ADOPT_FRAMES = 240

let done = false
let frames = 0

function apply(e: Entity): void {
  // A hide is the one failure mode that would survive rewriting the model, so
  // it goes first and unconditionally.
  if (VisibilityComponent.has(e)) VisibilityComponent.deleteFrom(e)
  // createOrReplace, so this is correct whether the component was cleared,
  // mangled, or is already exactly right.
  GltfContainer.createOrReplace(e, {
    src: OLD_TABLE_MODEL,
    // Both masks named explicitly and carried over from the placement rather
    // than defaulted: the table's solidity comes from its `oldtable_collider`
    // node, and invisibleMeshesCollisionMask defaults to CL_PHYSICS only —
    // silently dropping the pointer layer the scene was placed with.
    visibleMeshesCollisionMask: OLD_TABLE_VISIBLE_COLLISION_MASK,
    invisibleMeshesCollisionMask: OLD_TABLE_INVISIBLE_COLLISION_MASK
  })
}

function adoptSystem(_dt: number): void {
  if (done) return

  for (const name of TABLE_ENTITY_NAMES) {
    const e = engine.getEntityOrNullByName(name)
    if (e !== null) {
      apply(e)
      done = true
      return
    }
  }

  // The composite may not have produced the entity on the very first frames —
  // the same wait the leaderboard, the chandelier and the swing traps all make
  // for their own anchors.
  if (++frames < ADOPT_FRAMES) return

  // Nothing to adopt. Build it, at the transform main.crdt places it on, and
  // SAY SO — a table that has to be rebuilt from code every session is a real
  // fact about the scene and there is no console on a phone to notice it with.
  const tried = TABLE_ENTITY_NAMES.join(', ')
  reportFailure('oldTable', `no placed anchor found; tried ${tried} — spawning from config`)
  console.log(`[oldTable] no placed anchor found; tried ${tried} — spawning from config`)

  const e = engine.addEntity()
  Transform.create(e, { position: Vector3.clone(OLD_TABLE_POSITION) })
  apply(e)
  done = true
}

export function initOldTable(): void {
  addSafeSystem(adoptSystem, 'oldTableAdopt')
}
