/**
 * CORE HIT SYSTEM — shared player hit-testing used by hazards and (future)
 * battle mechanics. One place to tune how "touching" is judged, so every
 * weapon/trap that adopts these helpers behaves consistently.
 *
 * The player is modeled as a vertical capsule: a circle of PLAYER_BODY_RADIUS
 * in the XZ plane, from feet (transform y) up to PLAYER_HEIGHT. All tests
 * INCLUDE the body radius — a hitbox only has to reach the player's skin,
 * not their center — which is what makes hits land "every time it touches".
 */

import { Vector3 } from '@dcl/sdk/math'
import { playerPosition } from './playerTracker'

const PLAYER_BODY_RADIUS = 0.4 // avatar capsule radius, slightly generous
const PLAYER_HEIGHT = 1.9 // feet to top of head

// segmentHitsPlayer() was removed on 2026-08-19: its only callers were the
// thrown knife and the deleted knifeProjectile module.

/**
 * Does an ORIENTED box touch the player?
 *
 * This is the test for a hazard that TURNS. An axis-aligned box round a
 * swinging object balloons as it rotates, and a capsule round a FLAT one is
 * worse still: a capsule takes the widest perpendicular extent of whatever it
 * wraps, so the axe head — measured at 2.69m across but only 0.24m thick —
 * became a 2.74m-wide cylinder. That is the "it killed me and it was nowhere
 * near me" report: you die standing a clear metre off the flat of the blade.
 * An oriented box measures 70% less phantom volume on the axe than the capsule
 * chain it replaces, and 30% less on the plank.
 *
 * `centre`, `axisU`, `axisW` and `half` are the box's own frame: two of its
 * three axes (the third is derived) and the half-extents along U, W and U×W.
 * The axes are re-orthonormalised here rather than trusted, because callers
 * interpolate them between baked keyframes and a lerp of two unit vectors is
 * not a unit vector.
 *
 * The player is their real capsule, not a point: distance from the box to the
 * vertical segment feet..head, compared against PLAYER_BODY_RADIUS. That
 * matters more than it sounds — the older test checked a horizontal distance
 * and a vertical band SEPARATELY, so a blade whose arc passed high overhead
 * still counted as "in your y-band" while its footprint counted as "over your
 * head", and killed you from five metres up.
 */
export function orientedBoxHitsPlayer(
  centre: Vector3,
  axisU: Vector3,
  axisW: Vector3,
  half: Vector3,
  margin: number = 0
): boolean {
  // Rebuild an orthonormal frame from the (possibly lerped) axes.
  const u = Vector3.normalize(axisU)
  const w = Vector3.normalize(Vector3.subtract(axisW, Vector3.scale(u, Vector3.dot(u, axisW))))
  const n = Vector3.cross(u, w)

  // The player's capsule, expressed in the box's frame. Only the ends are
  // needed: the segment between them stays straight under this map.
  const feet = Vector3.subtract(playerPosition, centre)
  const head = Vector3.create(feet.x, feet.y + PLAYER_HEIGHT, feet.z)
  const ax = Vector3.dot(feet, u)
  const ay = Vector3.dot(feet, w)
  const az = Vector3.dot(feet, n)
  const bx = Vector3.dot(head, u)
  const by = Vector3.dot(head, w)
  const bz = Vector3.dot(head, n)

  // Distance from a point on that segment to the box, which is now axis
  // aligned and centred on the origin.
  function distAt(t: number): number {
    const px = ax + (bx - ax) * t
    const py = ay + (by - ay) * t
    const pz = az + (bz - az) * t
    const ex = Math.abs(px) - half.x
    const ey = Math.abs(py) - half.y
    const ez = Math.abs(pz) - half.z
    const cx = ex > 0 ? ex : 0
    const cy = ey > 0 ? ey : 0
    const cz = ez > 0 ? ez : 0
    return Math.sqrt(cx * cx + cy * cy + cz * cz)
  }

  // distAt is convex in t (distance to a convex set, along a line), so a
  // ternary search finds the true minimum — no sampling, no missed contact
  // between samples. 14 rounds narrow the player's 1.9m height to about 6mm,
  // which is far below anything a player could notice and cheap enough to run
  // per box per sub-step.
  let lo = 0
  let hi = 1
  for (let i = 0; i < 14; i++) {
    const m1 = lo + (hi - lo) / 3
    const m2 = hi - (hi - lo) / 3
    if (distAt(m1) <= distAt(m2)) hi = m2
    else lo = m1
  }
  return distAt((lo + hi) / 2) <= PLAYER_BODY_RADIUS + margin
}

/**
 * Does an axis-aligned world box touch the player?
 *
 * This is the hit test to reach for when a hazard's real geometry has been
 * MEASURED off its .glb (accessor bounds + node TRS + the placed rotation and
 * scale) — the box is then literally the model's own extents, so the lethal
 * volume and the thing on screen are the same object. A hand-tuned
 * radius-and-height cylinder can't express a shape like that: the wall spike
 * panel, for example, is 2.68m x 3.21m but only 0.13m THICK, and the cylinder
 * that used to guard it was 4m across in the thin direction — 30x wider than
 * the spikes the player could see.
 *
 * The player's capsule is added on top, same as segmentHitsPlayer: the box has
 * to reach their skin, not their center.
 *
 * Only valid for boxes whose faces are world-axis-aligned. That covers every
 * hazard here — the spike panels are rotated a flat 90 degrees about Z, which
 * keeps them axis-aligned — but a hazard placed at an odd yaw would need its
 * own oriented test rather than this one silently over-covering.
 */
export function boxHitsPlayer(min: Vector3, max: Vector3, margin: number = PLAYER_BODY_RADIUS): boolean {
  const feet = playerPosition.y
  if (max.y < feet || min.y > feet + PLAYER_HEIGHT) return false

  // XZ: distance from the player's circle to the box rectangle. Clamping the
  // player's center into the rectangle gives the nearest point on it; if that
  // point is within `margin`, they're touching.
  //
  // `margin` defaults to PLAYER_BODY_RADIUS, which is right for a chunky
  // hazard but far too generous for a THIN one: on the 0.234m spike panel it
  // grows the lethal slab to 1.034m, 4.4x the thing you can see, and you die
  // standing a clear 0.4m to the side of it. Hazards that are essentially
  // sheets pass a tighter value — see WALL_SPIKE_TOUCH_MARGIN.
  const nx = Math.max(min.x, Math.min(playerPosition.x, max.x))
  const nz = Math.max(min.z, Math.min(playerPosition.z, max.z))
  return Math.hypot(playerPosition.x - nx, playerPosition.z - nz) < margin
}
