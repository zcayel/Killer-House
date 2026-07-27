/**
 * INTERIOR DUST — small motes drifting slowly through the house, catching
 * the candle/chandelier glow for atmosphere.
 *
 * No dust/particle texture asset exists in this project, so each mote is a
 * tiny plain sphere rather than a textured sprite — a sphere is naturally
 * soft-edged from any viewing angle without needing one, which a flat
 * textureless quad would not be. Kept deliberately cheap: pure per-frame
 * sine-wave drift around a fixed anchor point, no physics, no raycasts — the
 * mobile freeze earlier in this project came specifically from continuous
 * raycasts, so this effect avoids that whole category of risk.
 */

import { engine, Transform, MeshRenderer, Material, MaterialTransparencyMode, Entity } from '@dcl/sdk/ecs'
import { Vector3, Color4 } from '@dcl/sdk/math'
import { DUST_MOTE_POSITIONS, DUST_MOTE_SCALE, DUST_DRIFT_RADIUS, DUST_DRIFT_SPEED } from './config'
import { gameStarted } from './gameState'
import { addSafeSystem } from './safeSystem'

interface Mote {
  entity: Entity
  anchor: Vector3
  phase: number
}

const motes: Mote[] = []

function dustSystem(dt: number) {
  if (!gameStarted) return
  for (const m of motes) {
    m.phase += dt * DUST_DRIFT_SPEED
    const t = Transform.getMutable(m.entity)
    t.position = Vector3.create(
      m.anchor.x + Math.sin(m.phase) * DUST_DRIFT_RADIUS,
      m.anchor.y + Math.sin(m.phase * 0.6 + 1.7) * DUST_DRIFT_RADIUS * 0.5,
      m.anchor.z + Math.cos(m.phase * 0.8) * DUST_DRIFT_RADIUS
    )
  }
}

export function initDust() {
  for (const anchor of DUST_MOTE_POSITIONS) {
    const e = engine.addEntity()
    Transform.create(e, {
      position: Vector3.clone(anchor),
      scale: Vector3.create(DUST_MOTE_SCALE, DUST_MOTE_SCALE, DUST_MOTE_SCALE)
    })
    MeshRenderer.setSphere(e)
    Material.setPbrMaterial(e, {
      albedoColor: Color4.create(0.9, 0.85, 0.7, 0.35),
      emissiveColor: Color4.create(0.9, 0.85, 0.7, 1),
      emissiveIntensity: 0.4,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
      metallic: 0,
      roughness: 1
    })
    // Random phase offset per mote so they don't all drift in lockstep.
    motes.push({ entity: e, anchor: Vector3.clone(anchor), phase: motes.length * 1.7 })
  }

  addSafeSystem(dustSystem, 'dustSystem')
}
