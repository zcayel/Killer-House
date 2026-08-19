/**
 * DEBUG — draw every volume in the scene that can kill you.
 *
 * One flag, SHOW_KILL_VOLUMES in config.ts, turns on a wireframe-ish overlay
 * for each hazard. It exists because a kill volume you cannot see is a kill
 * volume you cannot check: this scene shipped a swing-trap hit box that was the
 * MIRROR IMAGE of the blade for days, and no amount of offline measurement
 * found it — drawing both candidates in-world and looking at them took one
 * preview. See toWorld() in traps/swingTraps.ts.
 *
 * Every hazard uses a different shape, so they get different colours:
 *
 *   red      swinging blades and planks   oriented boxes, baked per keyframe
 *   orange   wall spikes                  axis-aligned boxes from the model
 *   yellow   chandelier                   cylinder, kills while descending
 *   cyan     lightning strike             cylinder around the strike point
 *   green    skeleton                     cylinder around the skeleton
 *   magenta  fence tips                   the lethal band over a fence line
 *
 * NOT drawn: fall damage (traps/fallDeath.ts), which has no volume at all —
 * it is a descent-height rule, so there is nothing to stand inside.
 *
 * These are inert markers: MeshRenderer only, no collider, never parented to
 * anything that matters. Leave SHOW_KILL_VOLUMES false in a shipped build —
 * it spawns an entity per box per hazard and updates them every frame.
 */

import { engine, Transform, MeshRenderer, Material, Entity, VisibilityComponent } from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { SHOW_KILL_VOLUMES } from '../config'

export const VOLUME_COLOURS = {
  swing: Color4.create(1, 0.15, 0.1, 0.32),
  spike: Color4.create(1, 0.55, 0.05, 0.32),
  chandelier: Color4.create(1, 0.95, 0.15, 0.28),
  lightning: Color4.create(0.2, 0.85, 1, 0.28),
  skeleton: Color4.create(0.25, 1, 0.35, 0.28),
  fence: Color4.create(1, 0.25, 0.9, 0.28)
}

/**
 * A pool of marker entities per hazard key.
 *
 * Keyed rather than global so each system owns its own markers and can shrink
 * its set (a skeleton despawns, a strike ends) without disturbing anyone
 * else's. Entities are hidden rather than removed when the count drops —
 * churning entities every frame is how you get a frame-time spike in a tool
 * that is supposed to be diagnosing one.
 */
const pools = new Map<string, Entity[]>()

function marker(key: string, index: number, colour: Color4): Entity {
  let pool = pools.get(key)
  if (pool === undefined) {
    pool = []
    pools.set(key, pool)
  }
  while (pool.length <= index) {
    const e = engine.addEntity()
    Transform.create(e)
    MeshRenderer.setBox(e)
    Material.setPbrMaterial(e, {
      albedoColor: colour,
      emissiveColor: Color4.create(colour.r, colour.g, colour.b, 1),
      emissiveIntensity: 0.55
    })
    pool.push(e)
  }
  const e = pool[index]
  VisibilityComponent.createOrReplace(e, { visible: true })
  return e
}

/** Hide every marker past `used` for this key. Call at the end of a frame. */
export function endVolumes(key: string, used: number): void {
  if (!SHOW_KILL_VOLUMES) return
  const pool = pools.get(key)
  if (pool === undefined) return
  for (let i = used; i < pool.length; i++) {
    VisibilityComponent.createOrReplace(pool[i], { visible: false })
  }
}

/** An axis-aligned box, given its world min/max corners. */
export function volumeBox(
  key: string,
  index: number,
  min: Vector3,
  max: Vector3,
  colour: Color4
): void {
  if (!SHOW_KILL_VOLUMES) return
  const t = Transform.getMutable(marker(key, index, colour))
  t.position = Vector3.create((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2)
  t.rotation = Quaternion.Identity()
  t.scale = Vector3.create(
    Math.max(max.x - min.x, 0.02),
    Math.max(max.y - min.y, 0.02),
    Math.max(max.z - min.z, 0.02)
  )
}

/**
 * An UPRIGHT CYLINDER, drawn as a box of the same footprint.
 *
 * Deliberately a box: the kill tests it stands for (chandelier, lightning,
 * skeleton) all measure a FLAT distance and a height band, so the volume is a
 * cylinder — and a box that circumscribes it is honest about the corners being
 * safe while a cylinder mesh would hide how the test actually reads. The
 * important thing is the radius and the band, and both are exact here.
 */
export function volumeCylinder(
  key: string,
  index: number,
  centre: Vector3,
  radius: number,
  bottomY: number,
  topY: number,
  colour: Color4
): void {
  if (!SHOW_KILL_VOLUMES) return
  const t = Transform.getMutable(marker(key, index, colour))
  t.position = Vector3.create(centre.x, (bottomY + topY) / 2, centre.z)
  t.rotation = Quaternion.Identity()
  t.scale = Vector3.create(radius * 2, Math.max(topY - bottomY, 0.02), radius * 2)
}
