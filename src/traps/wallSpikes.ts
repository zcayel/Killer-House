/**
 * TRAP 1 — Wall spikes (replaces the old floor tiles version).
 *
 * Spike units hide flush inside the east interior wall. Each one watches the
 * player's predicted position (current position + velocity lookahead); when
 * you're about to walk past its strike point it telegraphs - the tips peek
 * out of the wall with a red glow for a beat - then thrusts fully out.
 * Touching the extended spikes = death. After a moment they slide back into
 * the wall and cool down.
 *
 * Reuses assets/asset-packs/iron_fence_4 (the only fence pack in this export
 * that actually has a bundled .glb).
 */

import { engine, Transform, GltfContainer, MeshRenderer, Material, LightSource, ColliderLayer, Entity } from '@dcl/sdk/ecs'
import { Vector3, Color3, Color4, Quaternion } from '@dcl/sdk/math'
import {
  MODEL_FENCE_SPIKE,
  WALL_SPIKE_UNITS,
  WALL_SPIKE_SCALE,
  WALL_SPIKE_TRIGGER_RADIUS,
  WALL_SPIKE_LOOKAHEAD_SECONDS,
  WALL_SPIKE_WARNING_SECONDS,
  WALL_SPIKE_OUT_SECONDS,
  WALL_SPIKE_KILL_RADIUS,
  WALL_SPIKE_KILL_HEIGHT,
  WALL_SPIKE_COOLDOWN_SECONDS,
  EMISSIVE_GLOW_RANGE,
  EMISSIVE_GLOW_INTENSITY
} from '../config'
import { playerPosition, predictPlayerPosition } from '../playerTracker'
import { killPlayer, isInvulnerable } from '../gameState'
import { segmentHitsPlayer } from '../hits'
import { playSoundAt, SOUND_SPIKE } from '../sounds'
import { otherPlayerPositions } from '../multiplayer'
import { addSafeSystem } from '../safeSystem'

type UnitState = 'hidden' | 'warning' | 'out' | 'retracting' | 'cooldown'

const THRUST_SECONDS = 0.12 // hidden -> fully out
const RETRACT_SECONDS = 0.5 // fully out -> hidden
const WARNING_PEEK = 0.18 // how far the tips peek out during the telegraph (0..1 of full travel)

interface SpikeUnit {
  hidden: Vector3
  extended: Vector3
  spikeEntity: Entity
  warnEntity: Entity
  glowLight: Entity
  state: UnitState
  timer: number
  travel: number // 0 = fully hidden, 1 = fully extended
}

const units: SpikeUnit[] = []

function buildUnit(hidden: Vector3, extended: Vector3, rotation: Vector3): SpikeUnit {
  const spike = engine.addEntity()
  Transform.create(spike, {
    position: Vector3.clone(hidden),
    scale: Vector3.create(WALL_SPIKE_SCALE, WALL_SPIKE_SCALE, WALL_SPIKE_SCALE),
    rotation: Quaternion.fromEulerDegrees(rotation.x, rotation.y, rotation.z)
  })
  // No physical collision — the kill/hit-test here is pure geometry
  // (touchingSpike()/segmentHitsPlayer() below), never physics. Without this,
  // the fence pack's own baked collider stays solid even while the spike is
  // fully retracted into the wall, leaving an invisible obstruction in the
  // hallway (reported live — spikes were blocking movement near the strike
  // point even when hidden).
  GltfContainer.create(spike, { src: MODEL_FENCE_SPIKE, visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })

  // Thin red glow strip on the wall face, invisible until the telegraph.
  const warn = engine.addEntity()
  Transform.create(warn, {
    position: Vector3.lerp(hidden, extended, 0.12),
    scale: Vector3.create(0.06, 1.8, 1.2)
  })
  MeshRenderer.setBox(warn)
  Material.setPbrMaterial(warn, {
    albedoColor: Color4.create(1, 0, 0, 0),
    emissiveColor: Color4.create(1, 0, 0, 1),
    emissiveIntensity: 0
  })

  // Real light matching the emissive strip — the telegraph should spill red
  // onto the wall/floor around it, not just glow on its own tiny surface.
  const glowLight = engine.addEntity()
  Transform.create(glowLight, { position: Vector3.lerp(hidden, extended, 0.12) })
  LightSource.create(glowLight, {
    type: LightSource.Type.Point({}),
    active: false,
    color: Color3.create(1, 0.1, 0.05),
    intensity: 0,
    range: EMISSIVE_GLOW_RANGE,
    shadow: false
  })

  return { hidden, extended, spikeEntity: spike, warnEntity: warn, glowLight, state: 'hidden', timer: 0, travel: 0 }
}

function setGlow(unit: SpikeUnit, intensity: number) {
  Material.setPbrMaterial(unit.warnEntity, {
    albedoColor: Color4.create(1, 0, 0, 0),
    emissiveColor: Color4.create(1, 0, 0, 1),
    emissiveIntensity: intensity
  })
  const l = LightSource.getMutable(unit.glowLight)
  l.active = intensity > 0
  l.intensity = intensity > 0 ? EMISSIVE_GLOW_INTENSITY * (intensity / 2) : 0
}

function setTravel(unit: SpikeUnit, travel: number) {
  unit.travel = travel
  const pos = Vector3.lerp(unit.hidden, unit.extended, travel)
  const t = Transform.getMutable(unit.spikeEntity)
  t.position.x = pos.x
  t.position.y = pos.y
  t.position.z = pos.z
}

/**
 * Hit test against the WHOLE protruding spike shaft (wall face -> current
 * tip), not just the tip point — brushing the side of the spikes is just as
 * lethal as taking them head-on. Uses the shared core hit system (hits.ts),
 * which already accounts for the player's body radius.
 */
function touchingSpike(unit: SpikeUnit): boolean {
  const tip = Vector3.lerp(unit.hidden, unit.extended, unit.travel)
  return segmentHitsPlayer(unit.hidden, tip, WALL_SPIKE_KILL_RADIUS, unit.extended.y, WALL_SPIKE_KILL_HEIGHT)
}

/** XZ-only proximity to the strike point, with a loose vertical band. */
function nearStrikePoint(pos: Vector3, unit: SpikeUnit): boolean {
  const flat = Math.hypot(pos.x - unit.extended.x, pos.z - unit.extended.z)
  return flat < WALL_SPIKE_TRIGGER_RADIUS && Math.abs(pos.y + 0.9 - unit.extended.y) < WALL_SPIKE_KILL_HEIGHT
}

/** Start the telegraph → thrust sequence. Runs identically for a local trigger or a remote one. */
function fire(unit: SpikeUnit) {
  unit.state = 'warning'
  unit.timer = WALL_SPIKE_WARNING_SECONDS
  setGlow(unit, 2)
  setTravel(unit, WARNING_PEEK)
  playSoundAt(SOUND_SPIKE, unit.extended, 0.9)
}

function spikesSystem(dt: number) {
  // Per-client: every client runs its own spike cycle (see initWallSpikes).
  // No host gate — that's what left non-host phones with frozen, harmless
  // spikes that never triggered a death.
  const predicted = predictPlayerPosition(WALL_SPIKE_LOOKAHEAD_SECONDS)
  const others = otherPlayerPositions()

  for (const unit of units) {
    unit.timer -= dt

    // ONE lethal check, every frame, in every state: if the spikes are
    // visibly out of the wall at all and you're touching them, you die.
    // (Only for MY avatar — every other client runs its own check.)
    if (!isInvulnerable() && unit.travel > 0.1 && touchingSpike(unit)) {
      killPlayer('Skewered by wall spikes')
    }

    switch (unit.state) {
      case 'hidden': {
        // Host takeover guard: if I just inherited a unit mid-thrust, retract
        if (unit.travel > WARNING_PEEK) {
          unit.state = 'retracting'
          unit.timer = RETRACT_SECONDS * unit.travel
          break
        }
        // I trigger with velocity prediction; any other player by proximity
        const meNear = !isInvulnerable() && (nearStrikePoint(playerPosition, unit) || nearStrikePoint(predicted, unit))
        const otherNear = others.some((p) => nearStrikePoint(p, unit))
        if (meNear || otherNear) fire(unit)
        break
      }

      case 'warning':
        if (unit.timer <= 0) {
          unit.state = 'out'
          unit.timer = THRUST_SECONDS + WALL_SPIKE_OUT_SECONDS
          setGlow(unit, 0)
        }
        break

      case 'out': {
        // Fast thrust, then hold fully extended.
        const remainingHold = unit.timer - WALL_SPIKE_OUT_SECONDS
        const travel = remainingHold > 0 ? 1 - (remainingHold / THRUST_SECONDS) * (1 - WARNING_PEEK) : 1
        setTravel(unit, Math.min(1, Math.max(unit.travel, travel)))

        if (unit.timer <= 0) {
          unit.state = 'retracting'
          unit.timer = RETRACT_SECONDS
        }
        break
      }

      case 'retracting':
        setTravel(unit, Math.max(0, unit.timer / RETRACT_SECONDS))
        if (unit.timer <= 0) {
          setTravel(unit, 0)
          unit.state = 'cooldown'
          unit.timer = WALL_SPIKE_COOLDOWN_SECONDS
        }
        break

      case 'cooldown':
        if (unit.timer <= 0) unit.state = 'hidden'
        break
    }
  }
}

export function initWallSpikes() {
  for (const u of WALL_SPIKE_UNITS) {
    const unit = buildUnit(u.hidden, u.extended, u.rotation)
    // Per-client (same as the skeletons): NOT synced — every client runs its
    // own spike cycle and its own kill check, so the hazard works identically
    // on every device instead of depending on the host's Transform arriving.
    units.push(unit)
  }

  addSafeSystem(spikesSystem, 'spikesSystem')
}
