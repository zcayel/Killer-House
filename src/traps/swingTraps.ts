/**
 * TRAP — Swinging planks and blades (fplank.glb x4, pblade2.glb x2).
 *
 * These are placed and animated in Creator Hub. They shipped with Animator
 * playing:true, so they swung forever regardless of where anybody was. On
 * request they now work like the wall spikes: the clip is STOPPED at load, and
 * plays only when the player's predicted position says they are about to walk
 * into the swing. Touching the moving part kills.
 *
 * WHAT MAKES THE KILL FAIR. The code cannot see inside a baked GLB animation,
 * so the clips were sampled offline (scratchpad/swing_obb.py) and the moving
 * part baked into SWING_TRAP_FPLANK/SWING_TRAP_PBLADE as ORIENTED BOXES per
 * keyframe, interpolated here by how far through the clip the unit is.
 *
 * Oriented boxes, specifically, because the two shapes that came before were
 * both wrong in ways players felt:
 *   - an axis-aligned box balloons as the thing inside it turns;
 *   - a capsule takes the widest perpendicular extent of what it wraps, so the
 *     axe head — 2.69m across but 0.24m THICK — became a 2.74m cylinder and
 *     killed people standing a clear metre off the flat of the blade.
 * Measured against the mesh surface, oriented boxes are 91% (plank) and 81%
 * (axe) less lethal air than the axis-aligned box round the same pose.
 *
 * THE PLACED TRANSFORM IS PART OF THE SHAPE. The baked boxes are in the model's
 * own space, so they have to be rotated and scaled by however the unit was
 * placed before they mean anything in the world. Reading only `position` — as
 * this file originally did — silently mirrors pblade2.glb_2, which is placed at
 * 180 degrees about Y: its kill volume ended up on the opposite side of its own
 * origin from the axe, up to 11m from the thing you can see.
 *
 * THE PLANK IS A DRAWBRIDGE. Its underside kills, but once it is down you are
 * meant to walk along it to the second floor, so SWING_TRAP_FPLANK sets
 * killFromBelowOnly (see touching()). That works because fplank's collider
 * really does travel with the board — it rides a SECOND clip
 * ('TemplateHN.011Action'), which is why this fires every clip in model.clips
 * rather than calling playSingleAnimation. pblade2 has no collider node at all,
 * so it is hazard-only.
 *
 * Per-client, like every other hazard here — no syncing, no host election.
 */

import {
  engine,
  Transform,
  Animator,
  MeshRenderer,
  Material,
  Billboard,
  BillboardMode,
  MaterialTransparencyMode,
  Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import {
  SWING_TRAP_LOOKAHEAD_SECONDS,
  SWING_TRAP_TRIGGER_MARGIN,
  SWING_TRAP_COOLDOWN_SECONDS,
  SWING_TRAP_TOUCH_MARGIN,
  SWING_TRAP_SHOW_HITBOXES,
  SWING_TRAP_PLANK_HOLD_SECONDS,
  SWING_TRAP_PLANK_TRIGGER_DELAY,
  SWING_TRAP_PLANK_IMPACT_VOLUME,
  SWING_TRAP_PLANK_BOUNCE_VOLUME,
  SWING_TRAP_PLANK_BOUNCE_DELAY,
  SWING_TRAP_SWING_VOLUME,
  SWING_TRAP_AXE_VOLUME,
  PLANK_DUST_TEXTURE,
  PLANK_DUST_PUFFS,
  PLANK_DUST_SECONDS,
  PLANK_DUST_SIZE,
  PLANK_DUST_RISE,
  FLOOR_LEVELS_Y
} from '../config'
import { playSoundAt, SOUND_WOOD_IMPACT, SOUND_SWING, SOUND_AXE_SWING } from '../sounds'
import { SWING_TRAP_UNITS, SwingTrapModel, SwingBox } from './swingTrapShapes'
import { playerPosition, predictPlayerPosition } from '../playerTracker'
import { killPlayer, isInvulnerable } from '../gameState'
import { orientedBoxHitsPlayer } from '../hits'
import { addSafeSystem } from '../safeSystem'

type SwingState = 'idle' | 'armed' | 'swinging' | 'cooldown'

/** A baked box placed in the world: centre, two axes, half-extents. */
interface WorldBox {
  c: Vector3
  u: Vector3
  w: Vector3
  h: Vector3
}

interface SwingUnit {
  entity: Entity
  model: SwingTrapModel
  /** Composed world transform — the keyframe boxes are relative to it. */
  origin: Vector3
  rotation: Quaternion
  scale: Vector3
  /** Uniform factor applied to the half-extents; see adopt(). */
  extentScale: number
  /** Union of every keyframe box, grown sideways: the arming footprint. */
  armMin: Vector3
  armMax: Vector3
  state: SwingState
  elapsed: number
  timer: number
  /** Clip time at which the moving part first reaches its lowest point. */
  landT: number
  /** Has this swing already landed? Reset when it fires again. */
  landed: boolean
  /** Debug-only: one child entity per lethal box, parented to the prop. */
  debugBoxes: Entity[]
  /** Seconds left holding the plank down as a walkway; 0 = not holding. */
  holdTimer: number
  /** Seconds until the quieter second impact; <= 0 = nothing pending. */
  bounceTimer: number
}

const units: SwingUnit[] = []
const pending: string[] = []
let retries = 0


/**
 * The unit's transform in WORLD space, composed down its parent chain.
 *
 * Same routine as wallSpikes.ts uses for the adopted spike panels. These
 * particular six happen to be authored at the scene root, but "happens to be"
 * is not something to build a kill volume on: one drag into a group in Creator
 * Hub would otherwise move the hazard and leave the lethal shape behind.
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

/**
 * The boxes the moving mesh occupies `t` seconds into the clip, in model space.
 *
 * Linear between the baked samples. The samples were not spaced by eye — the
 * baker kept inserting keyframes wherever the interpolated shape was furthest
 * from the real mesh SURFACE until that error came under 6cm, so a straight
 * lerp between them tracks the real sweep to about that.
 *
 * Every keyframe carries the same box count in the same order (they are slices
 * of one object, ordered from its pivot outwards) so box i always pairs with
 * box i. That ordering is load-bearing: an earlier bake let the slice chain
 * flip end-for-end between keyframes, and lerping the axe's head into its
 * handle produced a multi-metre phantom in the middle of the swing.
 */
function boxesAt(model: SwingTrapModel, t: number): SwingBox[] {
  const kf = model.keyframes
  if (t <= kf[0].t) return kf[0].boxes
  const last = kf[kf.length - 1]
  if (t >= last.t) return last.boxes
  let i = 0
  while (i < kf.length - 2 && kf[i + 1].t < t) i++
  const ka = kf[i]
  const kb = kf[i + 1]
  const span = kb.t - ka.t
  const u = span > 0 ? (t - ka.t) / span : 0
  const out: SwingBox[] = []
  for (let b = 0; b < ka.boxes.length; b++) {
    const a = ka.boxes[b]
    const c = b < kb.boxes.length ? kb.boxes[b] : a
    out.push({
      c: Vector3.lerp(a.c, c.c, u),
      u: Vector3.lerp(a.u, c.u, u),
      w: Vector3.lerp(a.w, c.w, u),
      h: Vector3.lerp(a.h, c.h, u)
    })
  }
  return out
}

/**
 * Put a model-space box where the unit actually stands.
 *
 * X IS NEGATED FIRST. glTF is right-handed, Decentraland is left-handed, and
 * its loader mirrors a .glb on X when it imports it — so a box baked from the
 * raw glTF is the mirror image of where the engine actually draws that part of
 * the mesh. Everything downstream of this was correct; the input was flipped.
 *
 * Confirmed in-game 2026-08-20 rather than deduced: the scene drew both
 * candidates at once, red as-baked and blue mirrored, and the blue set was the
 * one that rode the blade. That test is why this line is one character of
 * certainty instead of a guess.
 *
 * Why every gate missed it: tools/verify_hits.py measures the baked boxes
 * against the mesh read out of the SAME glTF, so it mirrors both sides of its
 * own comparison and passes either way. It reported 0 missed kills while the
 * shipped kill volume was a mirror image of the blade. tools/place_axes.py
 * compares against the HOUSE instead, which is not mirrored, so it applies the
 * same negation in place().
 */
function toWorld(unit: SwingUnit, box: SwingBox): WorldBox {
  const c = Vector3.create(-box.c.x, box.c.y, box.c.z)
  const u = Vector3.create(-box.u.x, box.u.y, box.u.z)
  const w = Vector3.create(-box.w.x, box.w.y, box.w.z)
  return {
    c: Vector3.add(unit.origin, Vector3.rotate(Vector3.multiply(c, unit.scale), unit.rotation)),
    u: Vector3.rotate(u, unit.rotation),
    w: Vector3.rotate(w, unit.rotation),
    // * the model's own extentShrink: pull every half-extent in about the box
    // centre so the lethal volume sits INSIDE the visible mesh. Per model —
    // the axe is a pure hazard and can afford 0.90, the plank is a bridge you
    // stand on and cannot. See SwingTrapModel.extentShrink.
    h: Vector3.scale(box.h, unit.extentScale * unit.model.extentShrink)
  }
}

/** How far the box reaches below its own centre, for the drawbridge rule. */
function boxLowestY(b: WorldBox): number {
  const n = Vector3.cross(b.u, b.w)
  return b.c.y - (Math.abs(b.u.y) * b.h.x + Math.abs(b.w.y) * b.h.y + Math.abs(n.y) * b.h.z)
}

/** Where the moving part is lowest right now — where a landing sounds from. */
function lowPointOf(u: SwingUnit): Vector3 {
  let best = u.origin
  let low = Infinity
  for (const box of boxesAt(u.model, u.elapsed)) {
    const b = toWorld(u, box)
    const y = boxLowestY(b)
    if (y < low) {
      low = y
      best = Vector3.create(b.c.x, y, b.c.z)
    }
  }
  return best
}

/** The lowest point the whole moving part reaches at this point in the clip. */
function lowestYAt(u: SwingUnit, t: number): number {
  let low = Infinity
  for (const box of boxesAt(u.model, t)) {
    const y = boxLowestY(toWorld(u, box))
    if (y < low) low = y
  }
  return low
}



/**
 * A rotation built from the box's own two axes.
 *
 * The baked boxes carry an orthonormal pair (u along the part's length, w
 * across it); the third axis is their cross product. This is the standard
 * matrix-to-quaternion conversion over those three columns, written out
 * rather than routed through Matrix.fromXYZAxesToRef so it cannot be broken
 * by an SDK helper changing convention underneath it.
 */
function basisToQuaternion(u: Vector3, w: Vector3): Quaternion {
  const n = Vector3.cross(u, w)
  const m00 = u.x
  const m10 = u.y
  const m20 = u.z
  const m01 = w.x
  const m11 = w.y
  const m21 = w.z
  const m02 = n.x
  const m12 = n.y
  const m22 = n.z
  const trace = m00 + m11 + m22
  if (trace > 0) {
    const S = Math.sqrt(trace + 1.0) * 2
    return Quaternion.create((m21 - m12) / S, (m02 - m20) / S, (m10 - m01) / S, 0.25 * S)
  }
  if (m00 > m11 && m00 > m22) {
    const S = Math.sqrt(1.0 + m00 - m11 - m22) * 2
    return Quaternion.create(0.25 * S, (m01 + m10) / S, (m02 + m20) / S, (m21 - m12) / S)
  }
  if (m11 > m22) {
    const S = Math.sqrt(1.0 + m11 - m00 - m22) * 2
    return Quaternion.create((m01 + m10) / S, 0.25 * S, (m12 + m21) / S, (m02 - m20) / S)
  }
  const S = Math.sqrt(1.0 + m22 - m00 - m11) * 2
  return Quaternion.create((m02 + m20) / S, (m12 + m21) / S, 0.25 * S, (m10 - m01) / S)
}

/**
 * Draw the lethal boxes AS CHILDREN OF THE PROP (SWING_TRAP_SHOW_HITBOXES).
 *
 * Parenting is the point. The boxes are positioned in the model's own space —
 * exactly the space the bake measured them in — so the engine composes the
 * prop's position, rotation and scale onto them for free. Move the prop and
 * they move with it, by construction rather than by remembering to re-read a
 * transform.
 */
function syncDebugBoxes(unit: SwingUnit, t: number) {
  if (!SWING_TRAP_SHOW_HITBOXES) return
  const boxes = boxesAt(unit.model, t)
  while (unit.debugBoxes.length < boxes.length) {
    const e = engine.addEntity()
    Transform.create(e, { parent: unit.entity })
    MeshRenderer.setBox(e)
    Material.setPbrMaterial(e, {
      albedoColor: Color4.create(1, 0.15, 0.1, 0.32),
      emissiveColor: Color4.create(1, 0.1, 0.05),
      emissiveIntensity: 0.6
    })
    unit.debugBoxes.push(e)
  }
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]
    const tr = Transform.getMutable(unit.debugBoxes[i])
    // LOCAL space: the parent supplies position/rotation/scale. h is a
    // half-extent, and a MeshRenderer box is 1m across, so scale is 2h —
    // shrunk by the same factor the kill test uses so what you see IS the
    // volume that kills.
    // Mirrored on X, same as toWorld(), so what you see IS what kills.
    tr.position = Vector3.create(-b.c.x, b.c.y, b.c.z)
    tr.rotation = basisToQuaternion(
      Vector3.create(-b.u.x, b.u.y, b.u.z),
      Vector3.create(-b.w.x, b.w.y, b.w.z)
    )
    tr.scale = Vector3.create(
      b.h.x * 2 * unit.model.extentShrink,
      b.h.y * 2 * unit.model.extentShrink,
      b.h.z * 2 * unit.model.extentShrink
    )
  }
}

/**
 * KEEP THE HIT BOXES ON THE OBJECT.
 *
 * adopt() used to read the entity's transform once and keep it forever, so
 * every lethal box was built from a STARTUP SNAPSHOT. Move the prop — in
 * Creator Hub, or from code — and the model moved while the kill volume
 * stayed behind, killing players standing where the axe used to be and
 * missing them where it now is. Reported from play: "I changed the position
 * of the axes and it still kills me at the last position."
 *
 * So re-read it. worldTransform() walks the parent chain, which is a handful
 * of component reads for six units, and the arming footprint is only rebuilt
 * on the frames where something actually moved.
 */
function followEntity(unit: SwingUnit): void {
  if (!Transform.has(unit.entity)) return
  const t = worldTransform(unit.entity)
  const moved =
    Math.abs(t.position.x - unit.origin.x) > 1e-4 ||
    Math.abs(t.position.y - unit.origin.y) > 1e-4 ||
    Math.abs(t.position.z - unit.origin.z) > 1e-4 ||
    Math.abs(t.rotation.x - unit.rotation.x) > 1e-4 ||
    Math.abs(t.rotation.y - unit.rotation.y) > 1e-4 ||
    Math.abs(t.rotation.z - unit.rotation.z) > 1e-4 ||
    Math.abs(t.rotation.w - unit.rotation.w) > 1e-4 ||
    Math.abs(t.scale.x - unit.scale.x) > 1e-4 ||
    Math.abs(t.scale.y - unit.scale.y) > 1e-4 ||
    Math.abs(t.scale.z - unit.scale.z) > 1e-4
  if (!moved) return
  unit.origin = t.position
  unit.rotation = t.rotation
  unit.scale = t.scale
  unit.extentScale = Math.max(Math.abs(t.scale.x), Math.abs(t.scale.y), Math.abs(t.scale.z))
  refreshArmBounds(unit)
}

/**
 * Recompute the arming footprint — every corner of every keyframe box, in
 * world space. Called on adopt AND whenever the entity moves, because the
 * footprint is derived from the unit's live transform.
 */
function refreshArmBounds(unit: SwingUnit) {
  let mnx = Infinity
  let mny = Infinity
  let mnz = Infinity
  let mxx = -Infinity
  let mxy = -Infinity
  let mxz = -Infinity
  // WHICH POSES ARM IT.
  //
  // A blade arms off its WHOLE sweep: it is lethal the entire way round, so
  // anywhere in the arc is a fair place to set it off.
  //
  // A plank does not. It only kills coming DOWN (killFromBelowOnly), it travels
  // 5m in about half a second, and its swept footprint is ~8m long — so arming
  // off the whole sweep meant walking anywhere near the corridor triggered it,
  // all four fired together because their sweeps overlap, and the board had
  // already landed by the time you reached the spot it landed on.
  //
  // So a plank arms off its LANDING POSE only: the boxes at landT, which is
  // where the board actually comes down. That makes each of the four a
  // separate, local trigger, and puts the trigger where the danger is.
  const arming = unit.model.killFromBelowOnly
    ? unit.model.keyframes.filter((k) => Math.abs(k.t - unit.landT) < 1e-6)
    : unit.model.keyframes
  for (const k of arming.length > 0 ? arming : unit.model.keyframes) {
    for (const box of k.boxes) {
      const b = toWorld(unit, box)
      const n = Vector3.cross(b.u, b.w)
      for (const su of [-1, 1]) {
        for (const sw of [-1, 1]) {
          for (const sn of [-1, 1]) {
            const p = Vector3.add(
              b.c,
              Vector3.add(
                Vector3.scale(b.u, su * b.h.x),
                Vector3.add(Vector3.scale(b.w, sw * b.h.y), Vector3.scale(n, sn * b.h.z))
              )
            )
            mnx = Math.min(mnx, p.x)
            mny = Math.min(mny, p.y)
            mnz = Math.min(mnz, p.z)
            mxx = Math.max(mxx, p.x)
            mxy = Math.max(mxy, p.y)
            mxz = Math.max(mxz, p.z)
          }
        }
      }
    }
  }
  // HOW MUCH SLACK THE TRIGGER GETS.
  //
  // A blade is generous: SWING_TRAP_TRIGGER_MARGIN grows its footprint
  // sideways, because arming early only means it swings at someone who then
  // veers off, while arming late means it misses someone already walking in.
  //
  // A plank gets NONE. Its trigger is exactly the patch of floor it lands on,
  // on request — with the margin it armed from over a metre away on every side,
  // and since the drop takes about half a second the board was already down by
  // the time you reached the spot. Trigger where it lands, and it lands on you.
  //
  // Vertical is never grown either way — a player on the floor below the swing
  // should not set it off.
  const margin = unit.model.killFromBelowOnly ? 0 : SWING_TRAP_TRIGGER_MARGIN
  unit.armMin = Vector3.create(mnx - margin, mny, mnz - margin)
  unit.armMax = Vector3.create(mxx + margin, mxy, mxz + margin)

}

/** Adopt a placed entity. False if the composite hasn't produced it yet. */
function adopt(name: string, model: SwingTrapModel): boolean {
  const entity = engine.getEntityOrNullByName(name)
  if (entity === null || !Transform.has(entity)) return false
  return take(entity, name, model)
}

/** Turn an adopted entity into a live swing unit. */
function take(entity: Entity, name: string, model: SwingTrapModel): boolean {
  const t = worldTransform(entity)

  // A box only survives rotation; a NON-UNIFORM scale shears it into something
  // that is no longer a box at all. None of these six is placed that way, so
  // rather than carry a general parallelepiped test for a case that does not
  // exist, take the largest component — which can only ever over-cover — and
  // say so in the log if it ever stops being hypothetical.
  const extentScale = Math.max(Math.abs(t.scale.x), Math.abs(t.scale.y), Math.abs(t.scale.z))
  if (Math.abs(t.scale.x - t.scale.y) > 0.01 || Math.abs(t.scale.x - t.scale.z) > 0.01) {
    console.log(`[swingTraps] ${name} has a non-uniform scale; its hit boxes are the conservative fit`)
  }

  // Stop it swinging. This is the whole point of the change: it should be
  // still until it has a reason to move.
  if (Animator.getOrNull(entity) !== null) {
    Animator.stopAllAnimations(entity, true)
  }

  const unit: SwingUnit = {
    entity,
    model,
    origin: t.position,
    rotation: t.rotation,
    scale: t.scale,
    extentScale,
    armMin: Vector3.create(0, 0, 0),
    armMax: Vector3.create(0, 0, 0),
    state: 'idle',
    elapsed: 0,
    timer: 0,
    landT: 0,
    landed: false,
    debugBoxes: [],
    holdTimer: 0,
    bounceTimer: 0
  }

  // When does it land? Read out of the baked keyframes rather than written
  // down: the first moment the part is within 5cm of the lowest it ever gets.
  // Derived, so re-baking the shapes cannot leave a hardcoded time behind.
  // THE FALL IS NOT MONOTONIC. fplank overshoots before it settles: on the
  // shipped clip it dips to within 4cm of its final rest by t=0.31, springs
  // back up over the next 0.2s, then genuinely lands at t=0.61. Stopping at
  // the FIRST keyframe within tolerance of the lowest point (which is what
  // this used to do) caught the overshoot — the plank froze there for the
  // whole SWING_TRAP_PLANK_HOLD_SECONDS hold, 0.05m and a good part of a
  // second short of the floor, so its hitbox never lined up with a player
  // standing on what looked like a landed board. Now a candidate only counts
  // if the NEXT keyframe is still within tolerance too — a real landing stays
  // down, an overshoot bounces away again immediately.
  let lowest = Infinity
  for (const k of model.keyframes) {
    const y = lowestYAt(unit, k.t)
    if (y < lowest) lowest = y
  }
  unit.landT = model.keyframes[model.keyframes.length - 1].t
  for (let i = 0; i < model.keyframes.length; i++) {
    const here = lowestYAt(unit, model.keyframes[i].t)
    if (here > lowest + 0.05) continue
    const next = i + 1 < model.keyframes.length ? lowestYAt(unit, model.keyframes[i + 1].t) : here
    if (next > lowest + 0.05) continue // bounces back up right after - not the real landing
    unit.landT = model.keyframes[i].t
    break
  }

  refreshArmBounds(unit)

  units.push(unit)
  return true
}

/** Is this position inside the unit's swept footprint (plus arming margin)? */
function inSwingLane(pos: Vector3, u: SwingUnit): boolean {
  return (
    pos.x > u.armMin.x &&
    pos.x < u.armMax.x &&
    pos.z > u.armMin.z &&
    pos.z < u.armMax.z &&
    // Vertical: the player's body has to overlap the swept band, so a plank
    // sweeping the floor above you is not your problem.
    pos.y + 1.9 > u.armMin.y &&
    pos.y < u.armMax.y
  )
}

/** Does the moving part touch the player at this point in the clip? */
/**
 * Is a floor slab between this box and a player standing at feetY?
 *
 * True only when the box is ENTIRELY below a level the player is standing on
 * or above — the unambiguous case. A box that straddles the level is the blade
 * coming up through a stairwell opening, which is a real hit and stays lethal.
 *
 * The 0.05 margins keep a player standing exactly ON a level, and a box whose
 * top just grazes it, out of the suppressed case.
 */
function floorSeparates(b: WorldBox, feetY: number): boolean {
  const top = boxHighestY(b)
  for (const level of FLOOR_LEVELS_Y) {
    if (feetY >= level - 0.05 && top < level - 0.05) return true
  }
  return false
}

/** Highest world Y the box reaches. Mirror of boxLowestY. */
function boxHighestY(b: WorldBox): number {
  const n = Vector3.cross(b.u, b.w)
  return (
    b.c.y +
    Math.abs(b.u.y) * b.h.x +
    Math.abs(b.w.y) * b.h.y +
    Math.abs(n.y) * b.h.z
  )
}

/**
 * How low the box hangs DIRECTLY OVER a given point.
 *
 * Projects the point into the box's own frame, clamps it to the box's footprint
 * so it names the nearest part of the board, then returns the lower of that
 * spot's two faces in world Y. For a tilted plank that is the underside above
 * your head — not the far tip touching the floor ten metres away, which is what
 * boxLowestY() reports and why the bridge rule misfired.
 */
function boxUndersideNear(b: WorldBox, p: Vector3): number {
  const n = Vector3.cross(b.u, b.w)
  const d = Vector3.subtract(p, b.c)
  const du = Math.max(-b.h.x, Math.min(b.h.x, Vector3.dot(d, b.u)))
  const dw = Math.max(-b.h.y, Math.min(b.h.y, Vector3.dot(d, b.w)))
  const baseY = b.c.y + b.u.y * du + b.w.y * dw
  return baseY - Math.abs(n.y) * b.h.z
}

function touchesAt(u: SwingUnit, t: number): boolean {
  for (const box of boxesAt(u.model, t)) {
    const b = toWorld(u, box)

    // THE BRIDGE RULE. The plank's underside kills, but once it is down you
    // are meant to walk along it to the second floor — so it only kills while
    // it is still overhead, coming down onto you. Once its underside has
    // settled to around your feet it stops being a hazard and starts being
    // floor, which is exactly when its own collider becomes walkable.
    // Measured ABOVE THE PLAYER, not across the whole board. fplank is ONE
    // oriented box covering an 8m plank, so its global lowest corner is the
    // far end resting on the floor — which made this rule true everywhere and
    // suppressed almost every hit. Reported from play as "the planks aren't
    // killing the player": 527 suppressed against 11 kills. What the rule
    // actually means is "the part over YOU has come down to your feet", so it
    // has to be sampled at the player's own position.
    if (u.model.killFromBelowOnly && boxUndersideNear(b, playerPosition) <= playerPosition.y + 0.3) continue

    // THE FLOOR RULE. A blade's arc is 6.5m tall and the storeys here are
    // ~5m apart, so part of every swing is on the OTHER SIDE of a floor slab
    // from the player. The kill test is pure geometry — it has no idea a floor
    // is in the way — so without this you get killed on the upper floor by a
    // blade swinging in the room beneath you. Measured before adding it: of
    // the kills on floor 8.58, 20 of 21 came from a box entirely below that
    // floor. On the ground floor, zero. Reported from play as "phantom kills"
    // and it is exactly that: the hit box is right, it is just downstairs.
    //
    // Cheap and exact: if a whole floor level sits between the box and the
    // player's feet, the box cannot reach them. No raycast, same reasoning
    // (and same FLOOR_LEVELS_Y) that the blood stains use.
    if (floorSeparates(b, playerPosition.y)) continue

    if (orientedBoxHitsPlayer(b.c, b.u, b.w, b.h, SWING_TRAP_TOUCH_MARGIN)) return true
  }
  return false
}

/**
 * Did the moving part touch the player at any point during THIS FRAME?
 *
 * Testing only where the part is right now misses fast movers: the plank drops
 * 5m in 0.3s, which is over half a metre per frame at 30fps, so it can be above
 * the player on one frame and below them on the next without either sample
 * being a hit. The honest fix is to check across the frame rather than to
 * inflate the box until the gap is papered over — inflating it is what made
 * these kill people they never touched.
 */
function touching(u: SwingUnit, dt: number): boolean {
  const from = Math.max(0, u.elapsed - dt)

  // THE PLANK ONLY KILLS ON THE WAY DOWN.
  //
  // It is a drawbridge, and the whole point is that you walk up it. Measured on
  // the shipped clip, standing on it was safe for the 4.5s it is held down —
  // but it killed at 35 of 41 places you could stand during the 0.9s it takes
  // to LIFT BACK UP, sweeping up through whoever it had just invited on. Once
  // it is on the floor it is floor: not falling, not lethal. Only a part that
  // is actually descending onto you can kill.
  //
  // (Same rule the chandelier uses. It applies to killFromBelowOnly parts only
  // — the axe swings both ways and is lethal in both.)
  if (u.model.killFromBelowOnly && lowestYAt(u, u.elapsed) >= lowestYAt(u, from) - 1e-4) {
    return false
  }

  const SUBSTEPS = 3
  for (let i = 1; i <= SUBSTEPS; i++) {
    if (touchesAt(u, from + ((u.elapsed - from) * i) / SUBSTEPS)) return true
  }
  return false
}

/** Planks whoosh, axes get the heavier blade whoosh. */
function swingSoundFor(u: SwingUnit): string {
  return u.model.killFromBelowOnly ? SOUND_SWING : SOUND_AXE_SWING
}

/** Axes carry further than planks — see SWING_TRAP_AXE_VOLUME. */
function swingVolumeFor(u: SwingUnit): number {
  return u.model.killFromBelowOnly ? SWING_TRAP_SWING_VOLUME : SWING_TRAP_AXE_VOLUME
}

/**
 * DUST BURST — a puff of floor thrown up where the plank slams down.
 *
 * Spread ALONG the fallen board, not stacked in one place: the whole 8m length
 * lands together, so a single puff at the centre reads as a smoke bomb rather
 * than an impact. Each puff snaps open, drifts up and fades inside
 * PLANK_DUST_SECONDS.
 *
 * Billboarded, unlit-ish and non-colliding — this is decoration on top of a
 * trap that has already decided whether it killed you.
 */
const dustPuffs: { e: Entity; life: number; rise: number; spin: number }[] = []

function spawnPlankDust(u: SwingUnit): void {
  // THE BOARD'S REAL FOOTPRINT, from the CORNERS of its landing box.
  //
  // The first version walked box CENTRES — and fplank is a single oriented box
  // covering the whole 8m plank, so every puff collapsed onto that one centre
  // point. Reported from play as the dust "popping at the back": one clump,
  // nowhere near the end that actually slams down.
  //
  // Corners give the true extent, and the puffs are then laid along whichever
  // horizontal axis is longer — which for a plank is always its length.
  let mnx = Infinity
  let mnz = Infinity
  let mxx = -Infinity
  let mxz = -Infinity
  let floorY = Infinity
  for (const box of boxesAt(u.model, u.landT)) {
    const b = toWorld(u, box)
    const n = Vector3.cross(b.u, b.w)
    for (const su of [-1, 1]) {
      for (const sw of [-1, 1]) {
        for (const sn of [-1, 1]) {
          const p = Vector3.add(
            b.c,
            Vector3.add(
              Vector3.scale(b.u, su * b.h.x),
              Vector3.add(Vector3.scale(b.w, sw * b.h.y), Vector3.scale(n, sn * b.h.z))
            )
          )
          mnx = Math.min(mnx, p.x)
          mnz = Math.min(mnz, p.z)
          mxx = Math.max(mxx, p.x)
          mxz = Math.max(mxz, p.z)
          floorY = Math.min(floorY, p.y)
        }
      }
    }
  }
  if (!isFinite(floorY)) return

  // Lay the puffs along the LONG horizontal axis; across the short one they
  // would sit on top of each other again.
  const spanX = mxx - mnx
  const spanZ = mxz - mnz
  const alongX = spanX >= spanZ
  const midX = (mnx + mxx) / 2
  const midZ = (mnz + mxz) / 2

  for (let i = 0; i < PLANK_DUST_PUFFS; i++) {
    const t = PLANK_DUST_PUFFS > 1 ? i / (PLANK_DUST_PUFFS - 1) : 0.5
    // A little scatter so the row does not read as a dotted line.
    const jx = (Math.random() - 0.5) * 0.6
    const jz = (Math.random() - 0.5) * 0.6
    const x = alongX ? mnx + spanX * t + jx : midX + jx
    const z = alongX ? midZ + jz : mnz + spanZ * t + jz
    const e = engine.addEntity()
    Transform.create(e, {
      position: Vector3.create(x, floorY + 0.25, z),
      scale: Vector3.create(0.25, 0.25, 0.25)
    })
    Billboard.create(e, { billboardMode: BillboardMode.BM_Y })
    MeshRenderer.setPlane(e)
    Material.setPbrMaterial(e, {
      texture: Material.Texture.Common({ src: PLANK_DUST_TEXTURE }),
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
      albedoColor: Color4.create(1, 0.97, 0.92, 0.85),
      specularIntensity: 0,
      metallic: 0,
      roughness: 1
    })
    dustPuffs.push({
      e,
      life: PLANK_DUST_SECONDS * (0.75 + Math.random() * 0.5),
      rise: PLANK_DUST_RISE * (0.6 + Math.random() * 0.8),
      spin: (Math.random() - 0.5) * 90
    })
  }
}

/** Grows, lifts and fades each puff, then clears it. */
function dustSystem(dt: number): void {
  for (let i = dustPuffs.length - 1; i >= 0; i--) {
    const d = dustPuffs[i]
    d.life -= dt
    if (d.life <= 0) {
      engine.removeEntity(d.e)
      dustPuffs.splice(i, 1)
      continue
    }
    const total = PLANK_DUST_SECONDS
    const t = Math.max(0, Math.min(1, 1 - d.life / total))
    const tr = Transform.getMutable(d.e)
    // Snaps out, then keeps swelling gently as it thins — how a real puff goes.
    const spread = PLANK_DUST_SIZE * (0.25 + 0.75 * Math.min(1, t * 3.2)) * (1 + t * 0.5)
    tr.scale = Vector3.create(spread, spread, spread)
    tr.position = Vector3.create(tr.position.x, tr.position.y + d.rise * dt, tr.position.z)
    const mat = Material.getMutableOrNull(d.e)
    if (mat !== null && mat.material?.$case === 'pbr') {
      mat.material.pbr.albedoColor = Color4.create(1, 0.97, 0.92, 0.85 * (1 - t))
    }
  }
}

function swingSystem(dt: number) {
  if (pending.length > 0) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const spec = SWING_TRAP_UNITS.find((u) => u.name === pending[i])
      if (spec !== undefined && adopt(spec.name, spec.model)) pending.splice(i, 1)
    }
    if (pending.length > 0 && ++retries === 300) {
      console.log('[swingTraps] never found placed units: ' + pending.join(', '))
    }
  }

  const predicted = predictPlayerPosition(SWING_TRAP_LOOKAHEAD_SECONDS)

  for (const u of units) {
    // The boxes are derived from the entity's transform, so re-read it before
    // anything uses them. Without this they stay wherever the prop was at
    // startup — see followEntity().
    followEntity(u)
    syncDebugBoxes(u, u.elapsed)

    switch (u.state) {
      case 'idle': {
        if (isInvulnerable()) break
        // Predicted OR current position — someone who stops dead inside the
        // lane should still get hit, not just someone walking through it.
        // A PLANK ARMS ON WHERE YOU ARE, A BLADE ON WHERE YOU WILL BE.
        //
        // The four planks sit ~1.5m apart with trigger boxes barely 0.55m deep,
        // so an 0.8s lookahead reaches clean over one board and into the next —
        // walking the corridor armed all four in a row and they read as one
        // event. Current position only makes each board its own local trigger.
        //
        // Blades keep the prediction: their arc is metres wide and lethal all
        // the way round, so arming late means missing someone already inside it.
        const armed = u.model.killFromBelowOnly
          ? inSwingLane(playerPosition, u)
          : inSwingLane(playerPosition, u) || inSwingLane(predicted, u)
        if (armed && u.model.killFromBelowOnly && SWING_TRAP_PLANK_TRIGGER_DELAY > 0) {
          // Wait, then drop. Gives the player a beat to get off the patch.
          u.state = 'armed'
          u.timer = SWING_TRAP_PLANK_TRIGGER_DELAY
          break
        }
        if (armed) {
          u.state = 'swinging'
          u.elapsed = 0
          u.landed = false
          u.holdTimer = 0
          u.bounceTimer = 0
          // Every clip, not playSingleAnimation: that stops the others, and
          // fplank's collider rides a SEPARATE clip from its visible board.
          // speed is restored here too — a previous hold left it at 0.
          const anim = Animator.getMutableOrNull(u.entity)
          if (anim !== null) {
            for (const st of anim.states) {
              st.playing = u.model.clips.indexOf(st.clip) >= 0
              st.shouldReset = true
              st.speed = u.model.playbackSpeed
              // NOT looping. A looping clip restarts on its own, which for the
              // plank means it flies back up under whoever is standing on it.
              st.loop = false
            }
          }
          playSoundAt(swingSoundFor(u), u.origin, swingVolumeFor(u))
        }
        break
      }

      case 'armed': {
        u.timer -= dt
        if (u.timer > 0) break
        u.state = 'swinging'
        u.elapsed = 0
        u.landed = false
        u.holdTimer = 0
        u.bounceTimer = 0
        const anim = Animator.getMutableOrNull(u.entity)
        if (anim !== null) {
          for (const st of anim.states) {
            st.playing = u.model.clips.indexOf(st.clip) >= 0
            st.shouldReset = true
            st.speed = u.model.playbackSpeed
            st.loop = false
          }
        }
        playSoundAt(swingSoundFor(u), u.origin, swingVolumeFor(u))
        break
      }

      case 'swinging': {
        // The quieter second impact, a moment after the first.
        if (u.bounceTimer > 0) {
          u.bounceTimer -= dt
          if (u.bounceTimer <= 0) {
            playSoundAt(SOUND_WOOD_IMPACT, lowPointOf(u), SWING_TRAP_PLANK_BOUNCE_VOLUME)
          }
        }

        if (u.holdTimer > 0) {
          // HELD DOWN AS A WALKWAY. The clip is frozen (speed 0) rather than
          // stopped, so the board stays where it is and the hit boxes — which
          // are driven by `elapsed` — stay in step with what is drawn.
          u.holdTimer -= dt
          if (u.holdTimer <= 0) {
            const anim = Animator.getMutableOrNull(u.entity)
            if (anim !== null) {
              for (const st of anim.states) {
                if (u.model.clips.indexOf(st.clip) < 0) continue
                st.speed = u.model.playbackSpeed
                st.shouldReset = false // resume, do NOT restart from the top
                st.loop = false
              }
            }
          }
          break
        }

        const wasBefore = u.elapsed
        // Scaled by the same playbackSpeed given to the Animator, so the hit
        // boxes advance through the clip at exactly the rate the mesh does.
        u.elapsed += dt * u.model.playbackSpeed

        if (!isInvulnerable() && touching(u, dt)) {
          killPlayer(u.model.deathCause)
        }

        // Landing: it just crossed the moment it reaches its lowest point.
        if (u.model.killFromBelowOnly && !u.landed && wasBefore < u.landT && u.elapsed >= u.landT) {
          u.landed = true
          u.elapsed = u.landT
          playSoundAt(SOUND_WOOD_IMPACT, lowPointOf(u), SWING_TRAP_PLANK_IMPACT_VOLUME)
          spawnPlankDust(u)
          u.bounceTimer = SWING_TRAP_PLANK_BOUNCE_DELAY
          u.holdTimer = SWING_TRAP_PLANK_HOLD_SECONDS
          const anim = Animator.getMutableOrNull(u.entity)
          if (anim !== null) {
            for (const st of anim.states) {
              if (u.model.clips.indexOf(st.clip) < 0) continue
              st.speed = 0
              // CLEAR shouldReset BEFORE freezing. It is still true from the
              // frame this swing started, and it is not consumed silently —
              // re-sending the component with it set restarts the clip from
              // frame 0, so the plank snapped back UP the instant it landed
              // instead of holding as a walkway.
              st.shouldReset = false
              st.loop = false
            }
          }
          break
        }

        if (u.elapsed >= u.model.duration) {
          Animator.stopAllAnimations(u.entity, true)
          u.state = 'cooldown'
          u.timer = SWING_TRAP_COOLDOWN_SECONDS
        }
        break
      }

      case 'cooldown':
        u.timer -= dt
        if (u.timer <= 0) u.state = 'idle'
        break
    }
  }
}

export function initSwingTraps() {
  // Planks AND blades are adopted from Creator Hub, so every unit goes on the
  // pending list and is retried until the scene has produced it.
  for (const u of SWING_TRAP_UNITS) pending.push(u.name)
  addSafeSystem(swingSystem, 'swingSystem')
  addSafeSystem(dustSystem, 'dustSystem')
}
