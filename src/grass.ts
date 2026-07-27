/**
 * BACK-YARD GRASS — Decentraland's official wind-animated grass patch,
 * scattered across the back yard for atmosphere (on request). The wind sway
 * is baked into the asset's own shader/material — nothing here drives it,
 * this just places instances. Purely static (placed once at init, no
 * per-frame system).
 */

import { engine, Transform, GltfContainer } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { MODEL_GRASS, GRASS_COUNT, GRASS_SCALE_MIN, GRASS_SCALE_MAX, SKELETON_PATROL_BOUNDS } from './config'

export function initGrass() {
  for (let i = 0; i < GRASS_COUNT; i++) {
    const x = SKELETON_PATROL_BOUNDS.minX + Math.random() * (SKELETON_PATROL_BOUNDS.maxX - SKELETON_PATROL_BOUNDS.minX)
    const z = SKELETON_PATROL_BOUNDS.minZ + Math.random() * (SKELETON_PATROL_BOUNDS.maxZ - SKELETON_PATROL_BOUNDS.minZ)
    const scale = GRASS_SCALE_MIN + Math.random() * (GRASS_SCALE_MAX - GRASS_SCALE_MIN)

    const e = engine.addEntity()
    Transform.create(e, {
      position: Vector3.create(x, 0, z),
      rotation: Quaternion.fromEulerDegrees(0, Math.random() * 360, 0),
      scale: Vector3.create(scale, scale, scale)
    })
    GltfContainer.create(e, { src: MODEL_GRASS })
  }
}
