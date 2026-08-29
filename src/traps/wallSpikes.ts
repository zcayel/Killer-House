/**
 * TRAP 1 — Wall spikes (replaces the old floor tiles version).
 *
 * Spike units hide inside a wall. Each one watches the player's predicted
 * position (current position + velocity lookahead); when you're about to walk
 * past its strike point it telegraphs - the tips peek out of the wall with a
 * red glow for a beat - then thrusts fully out. Touching the extended spikes =
 * death. After a moment they slide back into the wall and cool down.
 *
 * Units come from two places and behave identically once built:
 *   - WALL_SPIKE_UNITS, spawned by this file at coordinates in config.ts.
 *   - WALL_SPIKE_PLACED_NAMES, fences placed by hand in Creator Hub that this
 *     file adopts at runtime (see adoptPlaced). Their resting pose, aim and
 *     size all come from how they were placed.
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
  WALL_SPIKE_COOLDOWN_SECONDS,
  WALL_SPIKE_PLACED_NAMES,
  WALL_SPIKE_PLACED_TRAVEL,
  WALL_SPIKE_MODEL_MIN,
  WALL_SPIKE_MODEL_MAX,
  WALL_SPIKE_MODEL_BOXES,
  WALL_SPIKE_TOUCH_MARGIN,
  EMISSIVE_GLOW_RANGE,
  EMISSIVE_GLOW_INTENSITY
} from '../config'
import { playerPosition, predictPlayerPosition } from '../playerTracker'
import { killPlayer, isInvulnerable } from '../gameState'
import { boxHitsPlayer } from '../hits'
import { volumeBox, endVolumes, VOLUME_COLOURS } from '../debug/killVolumes'
import { playSoundAt, SOUND_SPIKE } from '../sounds'
import { addSafeSystem } from '../safeSystem'
import { registerReplayActor, recordHazardEvent } from '../effects/replayStage'

type UnitState = 'hidden' | 'warning' | 'out' | 'retracting' | 'cooldown'

const THRUST_SECONDS = 0.12 // hidden -> fully out
const RETRACT_SECONDS = 0.5 // fully out -> hidden
const WARNING_PEEK = 0.18 // how far the tips peek out during the telegraph (0..1 of full travel)

interface SpikeUnit {
  hidden: Vector3
  extended: Vector3
  /**
   * Where the spikes actually END UP — the point nearStrikePoint measures the
   * player's distance from, and where the thrust sound plays.
   *
   * Not the same as `extended`, which is the entity origin. On the spawned
   * units the origin sits at the panel's wall end and is close enough to the
   * spikes that the two are interchangeable, so those set this to `extended`
   * and behave exactly as before. On an adopted fence at scale 1 the origin is
   * the far end of a 4m panel: a player standing right in front of the spikes
   * is ~4m from it, well outside WALL_SPIKE_TRIGGER_RADIUS, and the trap would
   * never arm at all. Those set it to the middle of the extended panel.
   */
  strike: Vector3
  // The unit's own lethal box, relative to its position. Per-unit because an
  // adopted fence can be at any rotation and size, so there is no single box
  // that describes every unit any more.
  panelMin: Vector3
  panelMax: Vector3
  /**
   * The actual lethal volume: the model's own solid boxes, rotated and scaled
   * for this unit, as offsets from its position. panelMin/panelMax stay the
   * overall envelope and are only used for the (deliberately generous) arming
   * test; killing goes through these.
   */
  boxes: { min: Vector3; max: Vector3 }[]
  spikeEntity: Entity
  warnEntity: Entity
  glowLight: Entity
  state: UnitState
  timer: number
  travel: number // 0 = fully hidden, 1 = fully extended
  /** This unit's death-replay cue key, stamped on by addUnit(). */
  key: string
}

const units: SpikeUnit[] = []

/**
 * Take a built unit into play and give the death replay its handle on it.
 *
 * Both sources of units (WALL_SPIKE_UNITS, spawned below, and the fences
 * adopted out of Creator Hub) come through here so neither can be added
 * without a cue key — a spike the recap cannot fire is a spike that kills the
 * ghost off-screen.
 */
function addUnit(unit: SpikeUnit): void {
  unit.key = `spike:${units.length}`
  units.push(unit)
  registerReplayActor(unit.key, {
    reset: () => restSpike(unit),
    fire: () => fire(unit)
  })
}

/**
 * Back into the wall, from anywhere in the cycle, glow off.
 *
 * The replay calls this before it opens and again when it closes. Opened off
 * the death screen the spikes that killed you are still standing out of the
 * wall; and a thrust the RECAP started must not be left out there as a live
 * hazard once the camera hands back, in a hallway the player never walked into.
 */
function restSpike(unit: SpikeUnit): void {
  unit.state = 'hidden'
  unit.timer = 0
  setGlow(unit, 0)
  setTravel(unit, 0)
}

/** Red telegraph strip + its light. Shared by spawned and adopted units. */
function buildTelegraph(at: Vector3, scale: Vector3, rotation: Quaternion | null) {
  const warn = engine.addEntity()
  Transform.create(warn, rotation === null ? { position: at, scale } : { position: at, scale, rotation })
  MeshRenderer.setBox(warn)
  Material.setPbrMaterial(warn, {
    albedoColor: Color4.create(1, 0, 0, 0),
    emissiveColor: Color4.create(1, 0, 0, 1),
    emissiveIntensity: 0
  })

  // Real light matching the emissive strip — the telegraph should spill red
  // onto the wall/floor around it, not just glow on its own tiny surface.
  const glowLight = engine.addEntity()
  Transform.create(glowLight, { position: at })
  LightSource.create(glowLight, {
    type: LightSource.Type.Point({}),
    active: false,
    color: Color3.create(1, 0.1, 0.05),
    intensity: 0,
    range: EMISSIVE_GLOW_RANGE,
    shadow: false
  })

  return { warn, glowLight }
}

function buildUnit(hidden: Vector3, extended: Vector3, rotation: Vector3): SpikeUnit {
  const spike = engine.addEntity()
  Transform.create(spike, {
    position: Vector3.clone(hidden),
    scale: Vector3.create(WALL_SPIKE_SCALE, WALL_SPIKE_SCALE, WALL_SPIKE_SCALE),
    rotation: Quaternion.fromEulerDegrees(rotation.x, rotation.y, rotation.z)
  })
  // No physical collision — the kill/hit-test here is pure geometry
  // (touchingSpike()/boxHitsPlayer() below), never physics. Without this,
  // the fence pack's own baked collider stays solid even while the spike is
  // fully retracted into the wall, leaving an invisible obstruction in the
  // hallway (reported live — spikes were blocking movement near the strike
  // point even when hidden).
  GltfContainer.create(spike, { src: MODEL_FENCE_SPIKE, visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })

  // Thin red glow strip on the wall face, invisible until the telegraph.
  const { warn, glowLight } = buildTelegraph(
    Vector3.lerp(hidden, extended, 0.12),
    Vector3.create(0.06, 1.8, 1.2),
    null
  )

  // Same measured boxes, and the same envelope derivation, as every other
  // unit. These used to read WALL_SPIKE_PANEL_MIN/MAX instead — a second,
  // separately-measured copy of the same quantity, which had already drifted
  // 5cm from the model on z. One source of truth: the boxes.
  const boxes = transformedBoxes(
    Quaternion.fromEulerDegrees(rotation.x, rotation.y, rotation.z),
    Vector3.create(WALL_SPIKE_SCALE, WALL_SPIKE_SCALE, WALL_SPIKE_SCALE)
  )
  const bounds = envelope(boxes)

  return {
    hidden,
    extended,
    strike: extended,
    boxes,
    panelMin: bounds.min,
    panelMax: bounds.max,
    spikeEntity: spike,
    warnEntity: warn,
    glowLight,
    state: 'hidden',
    timer: 0,
    travel: 0,
    key: '' // stamped by addUnit(), which is the only way in
  }
}

/**
 * WALL_SPIKE_MODEL_BOXES rotated and scaled for one unit, as offsets from its
 * entity position — the form boxHitsPlayer wants.
 */
/**
 * WALL_SPIKE_MODEL_BOXES are baked from the raw glTF, and X IS NEGATED HERE
 * before anything else happens to them.
 *
 * Same reason as toWorld() in swingTraps.ts: glTF is right-handed, Decentraland
 * is left-handed, and its loader mirrors a .glb on X when it imports it. Any
 * volume baked out of a model file is therefore the mirror image of where the
 * engine actually draws that mesh, and has to be flipped back.
 *
 * Confirmed the same way the blades were — by drawing the volume in-world and
 * looking at it (SHOW_KILL_VOLUMES in config.ts), not by measuring, because
 * every offline tool here reads the same glTF the bake came from and so mirrors
 * both sides of its own comparison. Corroborated independently: mirrored, the
 * house mesh sits 0.51m past FENCE_LINES instead of 3.62m.
 *
 * NOT applied to the skeleton, lightning, or chandelier volumes — those are
 * built from live entity Transforms and hand-measured constants, never from a
 * model file, so there is nothing mirrored about them.
 *
 * A negated X swaps which corner is min and which is max, so the AABB is
 * rebuilt from all 8 corners below rather than negated in place.
 */
function transformedBoxes(rotation: Quaternion, scale: Vector3) {
  const out: { min: Vector3; max: Vector3 }[] = []
  for (const raw of WALL_SPIKE_MODEL_BOXES) {
    const b = {
      min: Vector3.create(-raw.max.x, raw.min.y, raw.min.z),
      max: Vector3.create(-raw.min.x, raw.max.y, raw.max.z)
    }
    let mnx = Infinity
    let mny = Infinity
    let mnz = Infinity
    let mxx = -Infinity
    let mxy = -Infinity
    let mxz = -Infinity
    for (let corner = 0; corner < 8; corner++) {
      const w = Vector3.rotate(
        Vector3.create(
          (corner & 1 ? b.max.x : b.min.x) * scale.x,
          (corner & 2 ? b.max.y : b.min.y) * scale.y,
          (corner & 4 ? b.max.z : b.min.z) * scale.z
        ),
        rotation
      )
      mnx = Math.min(mnx, w.x)
      mny = Math.min(mny, w.y)
      mnz = Math.min(mnz, w.z)
      mxx = Math.max(mxx, w.x)
      mxy = Math.max(mxy, w.y)
      mxz = Math.max(mxz, w.z)
    }
    out.push({ min: Vector3.create(mnx, mny, mnz), max: Vector3.create(mxx, mxy, mxz) })
  }
  return out
}

/** Overall envelope of a unit's boxes — the arming test's vertical band. */
function envelope(boxes: { min: Vector3; max: Vector3 }[]) {
  let mn = Vector3.create(Infinity, Infinity, Infinity)
  let mx = Vector3.create(-Infinity, -Infinity, -Infinity)
  for (const b of boxes) {
    mn = Vector3.create(Math.min(mn.x, b.min.x), Math.min(mn.y, b.min.y), Math.min(mn.z, b.min.z))
    mx = Vector3.create(Math.max(mx.x, b.max.x), Math.max(mx.y, b.max.y), Math.max(mx.z, b.max.z))
  }
  return { min: mn, max: mx }
}

/**
 * An entity's position/rotation/scale in WORLD space.
 *
 * Transform stores everything relative to the parent, and a fence dragged into
 * a group in Creator Hub is nested one or two deep — reading its Transform
 * directly gives coordinates that mean nothing on their own. Walk up to the
 * root and compose.
 */
function worldTransform(entity: Entity) {
  const chain: Entity[] = []
  let node = entity
  let guard = 0
  while (Transform.has(node) && guard++ < 16) {
    chain.push(node)
    const parent = Transform.get(node).parent
    if (parent === undefined || parent === node || !Transform.has(parent)) break
    node = parent
  }

  let position = Vector3.create(0, 0, 0)
  let rotation = Quaternion.create(0, 0, 0, 1)
  let scale = Vector3.create(1, 1, 1)
  for (let i = chain.length - 1; i >= 0; i--) {
    const t = Transform.get(chain[i])
    position = Vector3.add(position, Vector3.rotate(Vector3.multiply(t.position, scale), rotation))
    rotation = Quaternion.multiply(rotation, t.rotation)
    scale = Vector3.multiply(scale, t.scale)
  }
  return { position, rotation, scale }
}

const pendingPlaced: string[] = []
let placedRetries = 0

/**
 * Turn a hand-placed fence into a live spike unit.
 *
 * Returns false if the entity isn't in the scene yet — composite entities
 * aren't guaranteed to exist on the first frames, so this gets retried.
 */
function adoptPlaced(name: string): boolean {
  const entity = engine.getEntityOrNullByName(name)
  if (entity === null || !Transform.has(entity)) return false

  const { position, rotation, scale } = worldTransform(entity)

  // Re-root it. From here the trap drives this entity in world space exactly
  // like a spawned one, and setTravel() can write straight to its position
  // without having to undo a parent's transform every frame. The world pose is
  // written back first, so detaching doesn't move it.
  const t = Transform.getMutable(entity)
  t.parent = engine.RootEntity
  t.position = position
  t.rotation = rotation
  t.scale = scale

  // Same reason as the spawned units: a fence parked inside a wall must not be
  // solid, or it blocks the room on the other side of it.
  const gltf = GltfContainer.getOrNull(entity)
  if (gltf !== null) {
    GltfContainer.createOrReplace(entity, {
      src: gltf.src,
      visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
      invisibleMeshesCollisionMask: ColliderLayer.CL_NONE
    })
  }

  // The pickets run along the model's local +Y, so rotating that vector gives
  // the direction this particular fence stabs — whichever way it was turned.
  const pickets = Vector3.normalize(Vector3.rotate(Vector3.create(0, 1, 0), rotation))
  const hidden = Vector3.clone(position)
  const extended = Vector3.add(hidden, Vector3.scale(pickets, WALL_SPIKE_PLACED_TRAVEL))
  const boxes = transformedBoxes(rotation, scale)
  const { min, max } = envelope(boxes)

  // Telegraph goes at the picket TIPS, not at the entity origin. On these the
  // origin is the far end of a panel metres long, so the origin is nowhere
  // near the surface the spikes are about to burst through.
  const reach = WALL_SPIKE_MODEL_MAX.y * scale.y
  const glowAt = Vector3.add(hidden, Vector3.scale(pickets, reach + WALL_SPIKE_PLACED_TRAVEL * 0.12))
  const panelLength = (WALL_SPIKE_MODEL_MAX.x - WALL_SPIKE_MODEL_MIN.x) * scale.x
  const panelThickness = (WALL_SPIKE_MODEL_MAX.z - WALL_SPIKE_MODEL_MIN.z) * scale.z
  // Scaled in the fence's own frame (thin along the pickets), then given the
  // fence's rotation, so the strip lies flat against the wall at any angle.
  const { warn, glowLight } = buildTelegraph(
    glowAt,
    Vector3.create(panelLength * 0.56, 0.06, panelThickness * 5.2),
    rotation
  )

  // The per-adoption geometry dump that used to live here is gone. It existed
  // to catch an adopted fence that silently did nothing, and
  // tools/verify_spikes.py now does that job properly and offline — it prints
  // every unit's rest pose, thrust direction, panel extent and reachable floor,
  // and checks fairness across six travel poses, which a console line never
  // could. It also fired on every Creator Hub rebuild, so the useful signal
  // (the failure warning below) was buried in repeats of the same two lines.

  addUnit({
    hidden,
    extended,
    strike: Vector3.create(
      extended.x + (min.x + max.x) / 2,
      extended.y + (min.y + max.y) / 2,
      extended.z + (min.z + max.z) / 2
    ),
    boxes,
    panelMin: min,
    panelMax: max,
    spikeEntity: entity,
    warnEntity: warn,
    glowLight,
    state: 'hidden',
    timer: 0,
    travel: 0,
    key: ''
  })
  return true
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
 * Hit test against the SPIKE PANEL'S OWN GEOMETRY, wherever it currently sits
 * on its travel.
 *
 * The boxes are the model's own measured solid regions
 * (WALL_SPIKE_MODEL_BOXES, rotated and scaled per unit), offset to the panel's
 * live position, so the volume that kills you is the volume you can see. They
 * move with the thrust because the offsets are relative to the entity, which
 * is exactly what the renderer does with the model itself.
 *
 * Several boxes rather than one because the panel's top is an ARCH — a single
 * box claimed the finial's full reach at every height, i.e. half a metre of
 * lethal nothing past the spikes. And the margin is WALL_SPIKE_TOUCH_MARGIN
 * rather than the default body radius, which on a 0.234m sheet had been
 * killing people standing a clear 0.4m to the side of it.
 *
 * Replaced a hand-tuned capsule that was ~30x too wide laterally, started 2m
 * of lethal air below the lowest visible spike, and ran the wrong length —
 * see the config comment for the full accounting.
 */
function touchingSpike(unit: SpikeUnit): boolean {
  const at = Vector3.lerp(unit.hidden, unit.extended, unit.travel)
  for (const b of unit.boxes) {
    if (
      boxHitsPlayer(
        Vector3.create(at.x + b.min.x, at.y + b.min.y, at.z + b.min.z),
        Vector3.create(at.x + b.max.x, at.y + b.max.y, at.z + b.max.z),
        WALL_SPIKE_TOUCH_MARGIN
      )
    ) {
      return true
    }
  }
  return false
}

/**
 * XZ-only proximity to the strike point, with a loose vertical band — the
 * ARMING test, deliberately still generous where the kill test is exact. The
 * trap has to commit to firing before the player arrives (there's a
 * WALL_SPIKE_WARNING_SECONDS telegraph to play), so this one wants to be
 * early and forgiving; only the kill has to match the geometry.
 *
 * The vertical band is the panel's own height rather than the retired
 * WALL_SPIKE_KILL_HEIGHT, measured from the player's chest (feet + 0.9).
 */
function nearStrikePoint(pos: Vector3, unit: SpikeUnit): boolean {
  // Distance to the PANEL, not to a point in the middle of it. This used to
  // be hypot() to unit.strike (the envelope's centre), which is fine for a
  // compact prop and wrong for a 4.7m-long fence: standing at either END of
  // the panel put you 2.35m from that centre, outside the 2.0m radius, so a
  // spike you were standing directly in front of never armed at all.
  const nx = Math.max(unit.extended.x + unit.panelMin.x,
                      Math.min(pos.x, unit.extended.x + unit.panelMax.x))
  const nz = Math.max(unit.extended.z + unit.panelMin.z,
                      Math.min(pos.z, unit.extended.z + unit.panelMax.z))
  const flat = Math.hypot(pos.x - nx, pos.z - nz)
  const chest = pos.y + 0.9
  return (
    flat < WALL_SPIKE_TRIGGER_RADIUS &&
    chest > unit.extended.y + unit.panelMin.y - 1.0 &&
    chest < unit.extended.y + unit.panelMax.y + 1.0
  )
}

/**
 * Start the telegraph → thrust sequence. Runs identically for a local trigger
 * or a remote one — and for the death replay, which fires this exact function
 * off the recorded cue so the spikes in the recap are the spikes that got you.
 *
 * Everything after this point runs off unit.timer at fixed durations, so one
 * call reproduces the whole sequence: the same telegraph, the same 0.12s
 * thrust, the same hold. There is nothing else to record.
 */
function fire(unit: SpikeUnit) {
  unit.state = 'warning'
  unit.timer = WALL_SPIKE_WARNING_SECONDS
  setGlow(unit, 2)
  setTravel(unit, WARNING_PEEK)
  playSoundAt(SOUND_SPIKE, unit.strike, 0.9)
  // Ignored while dead or replaying, so the recap's own thrust is not recorded
  // into the next recap (see recordHazardEvent).
  recordHazardEvent(unit.key)
}

function spikesSystem(dt: number) {
  // Composite entities may not exist on the very first frames — same reason
  // the chandelier keeps looking for its smart item.
  if (pendingPlaced.length > 0) {
    for (let i = pendingPlaced.length - 1; i >= 0; i--) {
      if (adoptPlaced(pendingPlaced[i])) pendingPlaced.splice(i, 1)
    }
    // Say so rather than quietly running with fewer spikes than configured —
    // a renamed or deleted fence in Creator Hub is otherwise invisible here.
    if (pendingPlaced.length > 0 && ++placedRetries === 300) {
      console.log('[wallSpikes] never found placed spikes: ' + pendingPlaced.join(', '))
    }
  }

  // Per-client: every client runs its own spike cycle (see initWallSpikes).
  // No host gate — that's what left non-host phones with frozen, harmless
  // spikes that never triggered a death.
  const predicted = predictPlayerPosition(WALL_SPIKE_LOOKAHEAD_SECONDS)

  let drawn = 0
  for (const unit of units) {
    unit.timer -= dt

    // Debug overlay: the same boxes touchingSpike() tests, at the same travel.
    // Drawn unconditionally (not only while lethal) so you can see where the
    // spikes WILL be before they fire.
    const at = Vector3.lerp(unit.hidden, unit.extended, unit.travel)
    for (const b of unit.boxes) {
      volumeBox(
        'spike',
        drawn++,
        Vector3.create(at.x + b.min.x, at.y + b.min.y, at.z + b.min.z),
        Vector3.create(at.x + b.max.x, at.y + b.max.y, at.z + b.max.z),
        VOLUME_COLOURS.spike
      )
    }

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
        // MY approach alone arms this unit, via velocity prediction.
        //
        // A remote-player proximity trigger used to sit alongside this, so
        // another player walking the hallway would fire the spikes — and
        // since the lethal check above is unconditional, those spikes then
        // killed ME. Week 2 feedback called out being killed by other
        // players' effects; this was one of the two real mechanisms for it.
        // Every client runs its own copy of this system for its own avatar,
        // so nothing is lost by dropping it: the other player's spikes still
        // fire, on their machine, for them.
        if (!isInvulnerable() && (nearStrikePoint(playerPosition, unit) || nearStrikePoint(predicted, unit))) fire(unit)
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

  endVolumes('spike', drawn)
}

export function initWallSpikes() {
  for (const u of WALL_SPIKE_UNITS) {
    const unit = buildUnit(u.hidden, u.extended, u.rotation)
    // Per-client (same as the skeletons): NOT synced — every client runs its
    // own spike cycle and its own kill check, so the hazard works identically
    // on every device instead of depending on the host's Transform arriving.
    addUnit(unit)
  }

  for (const name of WALL_SPIKE_PLACED_NAMES) pendingPlaced.push(name)

  addSafeSystem(spikesSystem, 'spikesSystem')
}
