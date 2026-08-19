/**
 * YARD SKELETON — rises from a back-yard grave, hunts you, and kills on touch.
 *
 * Rewritten 2026-08-19 on request. The previous version had grown five states
 * (wander / stalk / chase / resting / down) around a fixed patrol circuit, and
 * the circuit was doing most of the work: the skeleton spent its time walking
 * a loop and only chased if you happened to be standing in the open. This one
 * has one job — find the player, walk at them, hit them — and the states exist
 * only to serve that.
 *
 * WHAT SURVIVED THE REWRITE, and why none of it is optional:
 *
 *   PER-CLIENT, NEVER SYNCED. Every client spawns and simulates its OWN
 *   skeletons and decides its OWN death. There is no syncEntity and no host
 *   election here, and that is deliberate: the old shared pool elected a
 *   "simulation host" by lowest address, and real testing found host election
 *   and cross-device player detection unreliable between arbitrary devices —
 *   two clients would each conclude they were host, which is the documented
 *   "six skeletons on one phone, exactly 3 configured" bug, and non-host
 *   phones saw frozen skeletons that could not kill. The trade is that my
 *   skeleton and your skeleton are not in the same spot; the gain is a hazard
 *   that works on every device with no dependency on anyone else's
 *   connection. multiplayer.ts's header documents this as the scene's model.
 *
 *   MOBILE-LEAN ANIMATION. The mobile client reproducibly froze the whole
 *   scene the moment a skeleton closed in, and only then. Everything unique to
 *   that moment is a platform-risky subsystem — the run/attack clip switches,
 *   the rattle volume mutations, the attack sound — so on mobile all of them
 *   are off (see the isMobileNow() guards). The walk clip is started once by
 *   Animator.create and never touched again. Gameplay does not depend on any
 *   of it: movement and killing are pure Transform maths.
 *
 *   GROUND-RELATIVE NAVIGATION. The yard is not flat. groundAt() gives the
 *   height to stand at, canStepTo() refuses a step onto anything more than
 *   SKELETON_MAX_STEP above the current footing, and blockedAt() rejects the
 *   house and the baked obstacle grid. Writing y=0 into a position — which is
 *   what the pre-2026-08-18 code did — is what buried the skeleton in the
 *   stone steps.
 *
 *   A MEASURED KILL. SKELETON_KILL_RADIUS (0.62) came from skinning the model
 *   through its chase clip and sweeping the player capsule around it at 72
 *   azimuths; the real reach is 0.656m at its worst angle. The vertical band
 *   is just as load-bearing: the test used to be an infinite cylinder, which
 *   let a skeleton kill someone standing on a step two metres above it.
 *
 * IT NEVER ENTERS THE HOUSE (standing decision). insideBuilding() is an x/z
 * test covering the main body and both wings, so it also excludes anyone
 * upstairs or on the roof. There is no height ceiling: step onto the porch,
 * the stone steps or the fence and you are still prey — a ceiling is what used
 * to make the skeleton give up and look idle.
 */

import {
  engine,
  Transform,
  GltfContainer,
  MeshCollider,
  ColliderLayer,
  Animator,
  AudioSource,
  VisibilityComponent,
  Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { otherPlayerPositions } from '../multiplayer'
import {
  MODEL_SKELETON,
  SKELETON_SCALE,
  SKELETON_ANIM,
  SKELETON_SPAWNS,
  SKELETON_COUNT_ROUND1,
  SKELETON_COUNT_LATER,
  SKELETON_MODEL_Y_OFFSET,
  SKELETON_YAW_OFFSET_DEGREES,
  SKELETON_WANDER_SPEED,
  SKELETON_CHASE_SPEED,
  SKELETON_TURN_SPEED,
  SKELETON_KILL_RADIUS,
  SKELETON_SAFE_ZONE_CENTRE,
  SKELETON_SAFE_ZONE_RADIUS,
  SKELETON_BODY_HEIGHT,
  PLAYER_CAPSULE_HEIGHT,
  SKELETON_ATTACK_REST_SECONDS,
  SKELETON_BLOCKED_GRID,
  SKELETON_GROUND_GRID,
  SKELETON_GROUND_ALPHABET,
  SKELETON_GROUND_STEP,
  SKELETON_MAX_STEP,
  SKELETON_GRID_ORIGIN_X,
  SKELETON_GRID_ORIGIN_Z,
  SKELETON_GRID_CELL,
  SKELETON_STUCK_SECONDS,
  SKELETON_UNSTICK_SECONDS,
  SKELETON_DETOUR_FAN,
  SKELETON_REPATH_SECONDS,
  SKELETON_REPATH_DISTANCE,
  SKELETON_PATH_MAX_NODES,
  SKELETON_WAYPOINT_ARRIVE,
  HOUSE_WING_RECTS,
  FENCE_LINES,
  HOUSE_RECT,
  RITUAL_CANDLES_ROUND1
} from '../config'
import { killPlayer, isInvulnerable } from '../gameState'
import { addSafeSystem } from '../safeSystem'
import { volumeCylinder, endVolumes, VOLUME_COLOURS } from '../debug/killVolumes'
import { playerPosition } from '../playerTracker'
import { playSoundAt, SOUND_SKELETON_ATTACK, SOUND_BONE_RATTLE, gain } from '../sounds'
import { isMobileNow } from '../platform'

/**
 * hunting — a target is known and reachable; walk at it.
 * lurking — nobody to hunt; hold near the grave it rose from.
 * striking — close enough to swing; the kill lands here.
 * recovering — brief pause after a swing or a knife hit.
 * down — killed by the player, waiting to rise again.
 */
/**
 * NO 'down' STATE ANY MORE. It existed for a skeleton the player had killed,
 * and with the stab prompt removed on 2026-08-19 there is no way to damage
 * one — so it was unreachable. A skeleton now only leaves play when the round
 * parks it.
 */
type SkeletonState = 'hunting' | 'lurking' | 'striking' | 'recovering'

interface Skeleton {
  root: Entity
  audio: Entity
  /** The grave it belongs to. It rises here and drifts back here with no prey. */
  grave: Vector3
  state: SkeletonState
  timer: number
  anim: string
  animLock: number
  animRefresh: number
  rattleVol: number
  stuck: number
  /** +1 / -1: which way it tries to go around an obstacle, held until it fails. */
  turnSign: number
  /** Remaining waypoints of the current route, nearest first. */
  path: Vector3[]
  /** Where the route was computed TO, so we can tell when the prey has moved. */
  pathGoal: Vector3 | null
  repathTimer: number
  active: boolean
}

const skeletons: Skeleton[] = []
const ANIM_REFRESH_SECONDS = 2.5

// ───────────────────────────── where things are ──────────────────────────────

function insideHouse(x: number, z: number): boolean {
  return x > HOUSE_RECT.minX && x < HOUSE_RECT.maxX && z > HOUSE_RECT.minZ && z < HOUSE_RECT.maxZ
}

/** Indoors anywhere — main body OR either wing. Decides who is huntable. */
function insideBuilding(x: number, z: number): boolean {
  if (insideHouse(x, z)) return true
  for (const w of HOUSE_WING_RECTS) {
    if (x > w.minX && x < w.maxX && z > w.minZ && z < w.maxZ) return true
  }
  return false
}

/**
 * Is this position huntable — anywhere on the grounds, outside the house, and
 * outside the spawn refuge?
 *
 * THE WHOLE PLOT, AND NO DETECTION RADIUS AT ALL (on request). There has never
 * been a distance cap in the targeting itself; what limited it was this test
 * using YARD_BOUNDS (z >= 1.8) while SPAWN_POSITION is (27, 0.1, 1). A player
 * standing at their own spawn, or anywhere in the gateway, was simply not a
 * valid target — which reads exactly like "it only chases inside a radius".
 * FENCE_LINES is the real edge of the grounds, so now every square metre a
 * player can legally stand on counts, at any distance.
 *
 * No height ceiling either — the porch, the steps and the fence are all fair
 * game. Being INDOORS is the only refuge, and that is an x/z test which
 * already covers upstairs and the roof.
 */
function posInYard(p: Vector3): boolean {
  if (p.x < FENCE_LINES.minX || p.x > FENCE_LINES.maxX) return false
  if (p.z < FENCE_LINES.minZ || p.z > FENCE_LINES.maxZ) return false
  if (insideBuilding(p.x, p.z)) return false
  // The gateway you spawn in is the one refuge (SKELETON_SAFE_ZONE_RADIUS).
  // Everywhere else on the grounds is fair game.
  if (SKELETON_SAFE_ZONE_RADIUS > 0) {
    const dx = p.x - SKELETON_SAFE_ZONE_CENTRE.x
    const dz = p.z - SKELETON_SAFE_ZONE_CENTRE.z
    if (dx * dx + dz * dz < SKELETON_SAFE_ZONE_RADIUS * SKELETON_SAFE_ZONE_RADIUS) return false
  }
  return true
}

export function playerInYard(): boolean {
  return posInYard(playerPosition)
}

/** Height of the walkable ground at a point; 0 (yard level) off-grid. */
function groundAt(x: number, z: number): number {
  const j = Math.floor((z - SKELETON_GRID_ORIGIN_Z) / SKELETON_GRID_CELL)
  if (j < 0 || j >= SKELETON_GROUND_GRID.length) return 0
  const row = SKELETON_GROUND_GRID[j]
  const i = Math.floor((x - SKELETON_GRID_ORIGIN_X) / SKELETON_GRID_CELL)
  if (i < 0 || i >= row.length) return 0
  const level = SKELETON_GROUND_ALPHABET.indexOf(row.charAt(i))
  return level < 0 ? 0 : level * SKELETON_GROUND_STEP
}

/** Baked obstacle grid — every placed prop's footprint, grown by the body radius. */
function gridBlocked(x: number, z: number): boolean {
  const j = Math.floor((z - SKELETON_GRID_ORIGIN_Z) / SKELETON_GRID_CELL)
  if (j < 0 || j >= SKELETON_BLOCKED_GRID.length) return false
  const row = SKELETON_BLOCKED_GRID[j]
  const i = Math.floor((x - SKELETON_GRID_ORIGIN_X) / SKELETON_GRID_CELL)
  if (i < 0 || i >= row.length) return false
  return row.charCodeAt(i) === 49 // '1'
}

/**
 * Ground it may not stand on. The skeleton has no rigid body — its Transform
 * is written directly — so this and canStepTo() are the ONLY things between it
 * and walking through the scenery.
 */
function blockedAt(x: number, z: number): boolean {
  if (insideBuilding(x, z)) return true
  return gridBlocked(x, z)
}

/**
 * May it step from footing `fromY` onto (x, z)?
 *
 * Downward is unlimited on purpose — walking off a step is falling, which is
 * fine, and the alternative is a skeleton stranded on a terrace it walked up.
 * Upward is capped, which is what keeps it off gravestone tops now that the
 * bake marks those as reachable-looking surfaces rather than solid cells.
 */
function canStepTo(fromY: number, x: number, z: number): boolean {
  if (blockedAt(x, z)) return false
  return groundAt(x, z) - fromY <= SKELETON_MAX_STEP
}


// ──────────────────────────────── pathfinding ────────────────────────────────
//
// WHY THIS EXISTS. Everything above is LOCAL avoidance: the detour fan tries a
// few headings and takes the first that is clear. That is fine for stepping
// round a gravestone and structurally incapable of going round a BUILDING —
// which is most of this yard. Simulated against the real baked grid, a
// fan-only skeleton starting at the graves reached a player in the back yard
// and the corners, and NEVER reached one at the front gate or the south lawn:
// it walked into the house, ground along it, and gave up. That is the
// "doesn't chase the player" report, and no amount of tuning the fan fixes it,
// because greedy steering cannot see round a corner.
//
// A* over the same grid finds those routes — 41m and 81 hops to the gate — and
// expands at most ~1500 of the grid's 2907 cells doing it. The fan is kept for
// what it is good at: micro-avoidance between waypoints.

const GRID_W = SKELETON_BLOCKED_GRID.length > 0 ? SKELETON_BLOCKED_GRID[0].length : 0
const GRID_H = SKELETON_BLOCKED_GRID.length

function cellFree(i: number, j: number): boolean {
  if (i < 0 || j < 0 || i >= GRID_W || j >= GRID_H) return false
  if (SKELETON_BLOCKED_GRID[j].charCodeAt(i) === 49) return false
  // The house rects are not in the baked grid — that grid is props only.
  return !insideBuilding(
    SKELETON_GRID_ORIGIN_X + (i + 0.5) * SKELETON_GRID_CELL,
    SKELETON_GRID_ORIGIN_Z + (j + 0.5) * SKELETON_GRID_CELL
  )
}

function cellGround(i: number, j: number): number {
  if (j < 0 || j >= SKELETON_GROUND_GRID.length) return 0
  const row = SKELETON_GROUND_GRID[j]
  if (i < 0 || i >= row.length) return 0
  const level = SKELETON_GROUND_ALPHABET.indexOf(row.charAt(i))
  return level < 0 ? 0 : level * SKELETON_GROUND_STEP
}

/**
 * A route from (sx, sz) to (tx, tz) as world waypoints, or null if there is
 * none. 8-way, with the same climb limit the walker obeys, and diagonals
 * refused unless both orthogonal neighbours are clear (no corner-cutting
 * through the diagonal gap between two props).
 */
function findPath(sx: number, sz: number, tx: number, tz: number): Vector3[] | null {
  const si = Math.floor((sx - SKELETON_GRID_ORIGIN_X) / SKELETON_GRID_CELL)
  const sj = Math.floor((sz - SKELETON_GRID_ORIGIN_Z) / SKELETON_GRID_CELL)
  const ti = Math.floor((tx - SKELETON_GRID_ORIGIN_X) / SKELETON_GRID_CELL)
  const tj = Math.floor((tz - SKELETON_GRID_ORIGIN_Z) / SKELETON_GRID_CELL)
  if (!cellFree(si, sj) || !cellFree(ti, tj)) return null
  const start = sj * GRID_W + si
  const goal = tj * GRID_W + ti
  if (start === goal) return [Vector3.create(tx, 0, tz)]

  const cost = new Map<number, number>()
  const came = new Map<number, number>()
  // Binary heap keyed on f = g + h. A linear scan would be O(n) per pop and
  // this runs several times a second per skeleton.
  const heapIdx: number[] = []
  const heapF: number[] = []
  const push = (node: number, f: number) => {
    heapIdx.push(node)
    heapF.push(f)
    let c = heapIdx.length - 1
    while (c > 0) {
      const p = (c - 1) >> 1
      if (heapF[p] <= heapF[c]) break
      const ti2 = heapIdx[p]; heapIdx[p] = heapIdx[c]; heapIdx[c] = ti2
      const tf = heapF[p]; heapF[p] = heapF[c]; heapF[c] = tf
      c = p
    }
  }
  const pop = (): number => {
    const top = heapIdx[0]
    const li = heapIdx.pop() as number
    const lf = heapF.pop() as number
    if (heapIdx.length > 0) {
      heapIdx[0] = li; heapF[0] = lf
      let c = 0
      for (;;) {
        const l = c * 2 + 1
        const r = l + 1
        let m = c
        if (l < heapF.length && heapF[l] < heapF[m]) m = l
        if (r < heapF.length && heapF[r] < heapF[m]) m = r
        if (m === c) break
        const t2 = heapIdx[m]; heapIdx[m] = heapIdx[c]; heapIdx[c] = t2
        const tf = heapF[m]; heapF[m] = heapF[c]; heapF[c] = tf
        c = m
      }
    }
    return top
  }
  const h = (i: number, j: number) => Math.hypot(i - ti, j - tj)

  cost.set(start, 0)
  push(start, h(si, sj))
  let expanded = 0
  while (heapIdx.length > 0) {
    const cur = pop()
    if (cur === goal) break
    if (++expanded > SKELETON_PATH_MAX_NODES) return null
    const ci = cur % GRID_W
    const cj = (cur - ci) / GRID_W
    const cg = cost.get(cur) as number
    const cy = cellGround(ci, cj)
    for (let d = 0; d < 8; d++) {
      const di = d === 0 ? 1 : d === 1 ? -1 : d === 2 ? 0 : d === 3 ? 0 : d === 4 ? 1 : d === 5 ? 1 : d === 6 ? -1 : -1
      const dj = d === 0 ? 0 : d === 1 ? 0 : d === 2 ? 1 : d === 3 ? -1 : d === 4 ? 1 : d === 5 ? -1 : d === 6 ? 1 : -1
      const ni = ci + di
      const nj = cj + dj
      if (!cellFree(ni, nj)) continue
      if (di !== 0 && dj !== 0 && (!cellFree(ci + di, cj) || !cellFree(ci, cj + dj))) continue
      if (cellGround(ni, nj) - cy > SKELETON_MAX_STEP) continue
      const nNode = nj * GRID_W + ni
      const ng = cg + (di !== 0 && dj !== 0 ? 1.4142 : 1)
      const prev = cost.get(nNode)
      if (prev === undefined || ng < prev) {
        cost.set(nNode, ng)
        came.set(nNode, cur)
        push(nNode, ng + h(ni, nj))
      }
    }
  }
  if (!came.has(goal) && start !== goal) return null

  const out: Vector3[] = []
  let node = goal
  let guard = 0
  while (node !== start && guard++ < 4096) {
    const i = node % GRID_W
    const j = (node - i) / GRID_W
    out.push(
      Vector3.create(
        SKELETON_GRID_ORIGIN_X + (i + 0.5) * SKELETON_GRID_CELL,
        0,
        SKELETON_GRID_ORIGIN_Z + (j + 0.5) * SKELETON_GRID_CELL
      )
    )
    const prev = came.get(node)
    if (prev === undefined) break
    node = prev
  }
  out.reverse()
  // Walk to the prey itself on the last leg, not to the centre of its cell.
  if (out.length > 0) out[out.length - 1] = Vector3.create(tx, 0, tz)
  return out
}


/**
 * The nearest cell A* can actually route to, given a point that may be off the
 * grid or standing on something blocked.
 *
 * Needed because the huntable area (the whole fenced plot) is deliberately
 * LARGER than the baked grid, so a perfectly valid target can have no cell of
 * its own. Without this the search returns null for anyone near the fence and
 * the skeleton would decide they were unreachable and go home.
 */
function pathableNear(x: number, z: number): Vector3 {
  const gx = Math.min(
    SKELETON_GRID_ORIGIN_X + (GRID_W - 0.5) * SKELETON_GRID_CELL,
    Math.max(SKELETON_GRID_ORIGIN_X + 0.5 * SKELETON_GRID_CELL, x)
  )
  const gz = Math.min(
    SKELETON_GRID_ORIGIN_Z + (GRID_H - 0.5) * SKELETON_GRID_CELL,
    Math.max(SKELETON_GRID_ORIGIN_Z + 0.5 * SKELETON_GRID_CELL, z)
  )
  const i0 = Math.floor((gx - SKELETON_GRID_ORIGIN_X) / SKELETON_GRID_CELL)
  const j0 = Math.floor((gz - SKELETON_GRID_ORIGIN_Z) / SKELETON_GRID_CELL)
  if (cellFree(i0, j0)) return Vector3.create(gx, 0, gz)
  for (let ring = 1; ring <= 12; ring++) {
    for (let dj = -ring; dj <= ring; dj++) {
      for (let di = -ring; di <= ring; di++) {
        if (Math.abs(di) !== ring && Math.abs(dj) !== ring) continue
        if (cellFree(i0 + di, j0 + dj)) {
          return Vector3.create(
            SKELETON_GRID_ORIGIN_X + (i0 + di + 0.5) * SKELETON_GRID_CELL,
            0,
            SKELETON_GRID_ORIGIN_Z + (j0 + dj + 0.5) * SKELETON_GRID_CELL
          )
        }
      }
    }
  }
  return Vector3.create(gx, 0, gz)
}

// ───────────────────────────────── targeting ─────────────────────────────────

/**
 * WHERE THE PLAYER IS — the nearest huntable avatar, or null.
 *
 * My own avatar counts only while vulnerable; everyone else's comes from
 * multiplayer.ts's position feed. Returning other players matters even though
 * only I can be killed here: the skeleton should visibly go after whoever is
 * closest, not stand still because the one player it knows about is me and I
 * happen to be indoors.
 */
function nearestPrey(from: Vector3): Vector3 | null {
  let best: Vector3 | null = null
  let bestDist = Infinity
  const consider = (p: Vector3) => {
    if (!posInYard(p)) return
    const d = Math.hypot(p.x - from.x, p.z - from.z)
    if (d < bestDist) {
      bestDist = d
      best = p
    }
  }
  if (!isInvulnerable()) consider(playerPosition)
  for (const p of otherPlayerPositions()) consider(p)
  return best
}

// ──────────────────────────────── animation ──────────────────────────────────

/**
 * Switch the looping clip for a state. Also re-issues the SAME clip every
 * ANIM_REFRESH_SECONDS: mobile has a documented history of loop clips silently
 * freezing on one frame while the rest of the scene runs, and re-sending the
 * play call is a no-op where it is already looping and bounds a stall to a few
 * seconds where it is not.
 */
function ensureAnim(s: Skeleton, clip: string, dt: number) {
  if (isMobileNow()) return // mobile-lean: never touch the Animator after create
  if (s.animLock > 0) return
  if (s.anim === clip) {
    s.animRefresh -= dt
    if (s.animRefresh > 0) return
  }
  s.anim = clip
  s.animRefresh = ANIM_REFRESH_SECONDS
  Animator.playSingleAnimation(s.root, clip)
}

/** A one-shot clip that holds priority for `lock` seconds. */
function playOneShot(s: Skeleton, clip: string, lock: number) {
  if (isMobileNow()) return
  s.anim = clip
  s.animLock = lock
  Animator.playSingleAnimation(s.root, clip)
}

function setRattle(s: Skeleton, wantVol: number) {
  if (isMobileNow()) return
  if (wantVol === s.rattleVol) return
  s.rattleVol = wantVol
  const a = AudioSource.getMutable(s.audio)
  a.playing = wantVol > 0
  // Through gain() like every other sound — MASTER_VOLUME has to reach the
  // skeleton's rattle too, or the scene gets louder around it and it doesn't.
  a.volume = gain(wantVol)
}

// ───────────────────────────────── movement ──────────────────────────────────

/** Put it down at (x, z), standing on whatever the ground there is. */
function placeAt(s: Skeleton, x: number, z: number) {
  const t = Transform.getMutable(s.root)
  t.position = Vector3.create(x, groundAt(x, z) + SKELETON_MODEL_Y_OFFSET, z)
}

/**
 * Walk toward a goal, going AROUND what it cannot cross. Returns the distance
 * still to go.
 *
 * The detour fan tries the straight line first, then progressively wider
 * angles to one side, and takes the first heading whose landing cell is
 * actually steppable. s.turnSign decides which side is tried first and
 * PERSISTS — without that memory a skeleton facing the middle of a wall finds
 * both sides equally good, takes whichever the loop reaches first, and can
 * flip every frame, jittering in place instead of going around.
 */
function moveToward(s: Skeleton, goal: Vector3, speed: number, dt: number): number {
  const t = Transform.getMutable(s.root)
  const dx = goal.x - t.position.x
  const dz = goal.z - t.position.z
  const dist = Math.hypot(dx, dz)
  if (dist < 0.05) {
    s.stuck = 0
    return dist
  }

  const step = Math.min(speed * dt, dist)
  const ux = dx / dist
  const uz = dz / dist
  const fromY = groundAt(t.position.x, t.position.z)

  let nx = t.position.x
  let nz = t.position.z
  for (const deg of SKELETON_DETOUR_FAN) {
    const rad = (deg * s.turnSign * Math.PI) / 180
    const c = Math.cos(rad)
    const sn = Math.sin(rad)
    let cx = t.position.x + (ux * c - uz * sn) * step
    let cz = t.position.z + (ux * sn + uz * c) * step
    // Clamp inside the fence BEFORE the obstacle test — clamping afterwards
    // could shove a legal step back into something hugging the yard edge.
    // Clamped to the FENCE, not to YARD_BOUNDS. YARD_BOUNDS is the baked
    // grid's domain and is inset from the real fence by up to a metre; keeping
    // the walker inside it would let a player stand in that margin — the
    // gateway included — and watch the skeleton stop dead at an invisible
    // line it cannot cross. Off-grid cells read as free ground at y=0, which
    // is what that lawn strip actually is.
    cx = Math.max(FENCE_LINES.minX, Math.min(FENCE_LINES.maxX, cx))
    cz = Math.max(FENCE_LINES.minZ, Math.min(FENCE_LINES.maxZ, cz))
    if (canStepTo(fromY, cx, cz)) {
      nx = cx
      nz = cz
      break
    }
  }

  // STUCK IS MEASURED, NOT INFERRED — compare what it achieved against what it
  // tried. The old code called it stuck when a feeler ray saw something within
  // 2m, which also counts a skeleton walking happily along a wall; worse, it
  // did not move while "stuck", and a skeleton that does not move does not
  // turn, so the ray stayed aimed at the same wall forever. Sliding along a
  // wall counts as progress here, because it is progress.
  const mvx = nx - t.position.x
  const mvz = nz - t.position.z
  const moved = Math.hypot(mvx, mvz)
  if (moved < step * 0.3) s.stuck += dt
  else s.stuck = 0

  t.position = Vector3.create(nx, groundAt(nx, nz) + SKELETON_MODEL_Y_OFFSET, nz)

  // Face the way it MOVED, not the way it wanted to go — otherwise a skeleton
  // sidestepping along a wall walks sideways while staring at its goal.
  const headX = moved > 0.0001 ? mvx : dx
  const headZ = moved > 0.0001 ? mvz : dz
  const yaw = Math.atan2(headX, headZ) * (180 / Math.PI) + SKELETON_YAW_OFFSET_DEGREES
  t.rotation = Quaternion.slerp(
    t.rotation,
    Quaternion.fromEulerDegrees(0, yaw, 0),
    Math.min(1, SKELETON_TURN_SPEED * dt)
  )
  return Math.hypot(goal.x - nx, goal.z - nz)
}

/** Turn on the spot to face a point, without moving. */
function faceToward(s: Skeleton, at: Vector3, dt: number) {
  const t = Transform.getMutable(s.root)
  const yaw =
    Math.atan2(at.x - t.position.x, at.z - t.position.z) * (180 / Math.PI) + SKELETON_YAW_OFFSET_DEGREES
  t.rotation = Quaternion.slerp(
    t.rotation,
    Quaternion.fromEulerDegrees(0, yaw, 0),
    Math.min(1, SKELETON_TURN_SPEED * dt)
  )
}

/**
 * THE FAILSAFE — drop it back on its grave and carry on.
 *
 * A visible snap is ugly; a skeleton wedged for the rest of the round is
 * worse, and every attempt to fix that with cleverer steering has left some
 * corner where it still wedges. This one cannot fail to recover, which is the
 * property that matters: everything above is the nice path, this is the
 * guarantee.
 */
function unstick(s: Skeleton) {
  placeAt(s, s.grave.x, s.grave.z)
  // The old route started from where it WAS, so keeping it after a teleport
  // would send it walking back through whatever it was wedged in.
  s.path = []
  s.pathGoal = null
  s.repathTimer = 0
  s.stuck = 0
  s.turnSign = -s.turnSign
  s.state = 'lurking'
  s.timer = 0
}

// ────────────────────────────── damage and death ─────────────────────────────

function riseFromGrave(s: Skeleton) {
  s.state = 'lurking'
  s.path = []
  s.pathGoal = null
  s.repathTimer = 0
  s.animLock = 0
  s.stuck = 0
  s.timer = 0
  placeAt(s, s.grave.x, s.grave.z)
  const t = Transform.getMutable(s.root)
  t.rotation = Quaternion.fromEulerDegrees(0, Math.random() * 360, 0)
  ensureAnim(s, SKELETON_ANIM.walk, 0)
}




// ─────────────────────────────── the kill test ───────────────────────────────

/**
 * Can this skeleton reach MY avatar right now?
 *
 * Radius is measured, not guessed — see SKELETON_KILL_RADIUS. The vertical
 * band is equally load-bearing: this test used to have no y term at all, an
 * infinite cylinder, which was survivable only while the skeleton was pinned
 * to y=0 and anyone above y=3 was excluded from the yard. Both of those props
 * are gone, so without this a skeleton could kill someone standing on a step
 * two metres above its head.
 */
function canReachMe(s: Skeleton): boolean {
  const t = Transform.get(s.root).position
  const flat = Math.hypot(t.x - playerPosition.x, t.z - playerPosition.z)
  if (flat >= SKELETON_KILL_RADIUS) return false
  return (
    t.y < playerPosition.y + PLAYER_CAPSULE_HEIGHT &&
    t.y + SKELETON_BODY_HEIGHT > playerPosition.y
  )
}

/** Flat distance to the nearest living skeleton — debug readout (ui.tsx). */
export function nearestSkeletonDist(): number {
  let best = 999
  for (const s of skeletons) {
    if (!s.active) continue
    const t = Transform.get(s.root).position
    best = Math.min(best, Math.hypot(t.x - playerPosition.x, t.z - playerPosition.z))
  }
  return best
}

/** 3D distance to the nearest standing skeleton — drives the heartbeat (sounds.ts). */
export function nearestSkeletonDistance(): number {
  let best = Infinity
  for (const s of skeletons) {
    if (!s.active) continue
    const t = Transform.get(s.root).position
    const d = Math.hypot(t.x - playerPosition.x, t.z - playerPosition.z, t.y - playerPosition.y)
    if (d < best) best = d
  }
  return best
}

// ──────────────────────────────── the system ─────────────────────────────────

function skeletonSystem(dt: number) {
  let drawnSkeletons = 0
  for (const s of skeletons) {
    if (!s.active) continue
    if (s.animLock > 0) s.animLock -= dt
    s.timer -= dt

    // NEVER STAND INSIDE SOMETHING, however it got there. Checking only while
    // it tries to MOVE is not enough: riseFromGrave() trusts a grave position
    // without re-testing it, and the obstacle grid is baked from
    // main.composite, which has drifted from what actually ships before. This
    // makes it a guarantee rather than a best effort.
    const here = Transform.get(s.root).position
    if (blockedAt(here.x, here.z)) {
      unstick(s)
      continue
    }
    if (s.stuck > SKELETON_UNSTICK_SECONDS) {
      unstick(s)
      continue
    }

    setRattle(s, s.state === 'hunting' ? 0.85 : s.state === 'lurking' ? 0.55 : 0)

    switch (s.state) {
      case 'recovering': {
        ensureAnim(s, SKELETON_ANIM.idle, dt)
        if (s.timer <= 0) s.state = 'lurking'
        break
      }

      case 'striking': {
        // The swing is committed. Keep facing the target through it so the
        // model does not snap round the moment the clip ends.
        const prey = nearestPrey(here)
        if (prey !== null) faceToward(s, prey, dt)
        if (s.timer <= 0) s.state = 'lurking'
        break
      }

      case 'lurking':
      case 'hunting': {
        const prey = nearestPrey(here)

        if (prey === null) {
          // Nobody out here. Drift back to the grave and wait by it — it is a
          // known-clear cell, so this can never park it somewhere it cannot
          // stand, which "walk toward the player until blocked" absolutely
          // could.
          s.state = 'lurking'
          const gap = Math.hypot(s.grave.x - here.x, s.grave.z - here.z)
          if (gap > 0.6) {
            ensureAnim(s, SKELETON_ANIM.walk, dt)
            moveToward(s, s.grave, SKELETON_WANDER_SPEED, dt)
            if (s.stuck > SKELETON_STUCK_SECONDS) unstick(s)
          } else {
            ensureAnim(s, SKELETON_ANIM.idle, dt)
            s.stuck = 0
          }
          break
        }

        s.state = 'hunting'
        ensureAnim(s, SKELETON_ANIM.run, dt)

        // ROUTE FIRST, STEERING SECOND. Recompute when the route is spent, on
        // a timer, or once the prey has drifted far enough that the old route
        // aims at where they used to be.
        s.repathTimer -= dt
        const strayed =
          s.pathGoal === null ||
          Math.hypot(prey.x - s.pathGoal.x, prey.z - s.pathGoal.z) > SKELETON_REPATH_DISTANCE
        if (s.path.length === 0 || s.repathTimer <= 0 || strayed) {
          s.repathTimer = SKELETON_REPATH_SECONDS
          // Route to the nearest cell the grid can express, then close the
          // last few metres by steering straight at them. IT NEVER GIVES UP
          // ON A VISIBLE PLAYER: a failed search leaves the path empty, and an
          // empty path means "walk directly at the prey", which is the old
          // greedy behaviour — good enough in the open, and the only sensible
          // thing to do when the grid has nothing to say.
          const aim = pathableNear(prey.x, prey.z)
          const route = findPath(here.x, here.z, aim.x, aim.z)
          s.path = route === null ? [] : route
          s.pathGoal = Vector3.create(prey.x, 0, prey.z)
        }

        // Follow the route one waypoint at a time; the detour fan inside
        // moveToward still handles anything small between them.
        let goal = prey
        if (s.path.length > 0) {
          if (Math.hypot(s.path[0].x - here.x, s.path[0].z - here.z) < SKELETON_WAYPOINT_ARRIVE) {
            s.path.shift()
          }
          if (s.path.length > 0) goal = s.path[0]
        }
        moveToward(s, goal, SKELETON_CHASE_SPEED, dt)

        // Wedged mid-route: flip the preferred side and force a fresh route
        // next tick rather than abandoning the hunt outright.
        if (s.stuck > SKELETON_STUCK_SECONDS) {
          s.stuck = 0
          s.turnSign = -s.turnSign
          s.path = []
          s.repathTimer = 0
        }

        // IN REACH — swing. The swing always plays; the KILL only lands on my
        // own avatar, because every client runs this same loop for itself and
        // decides its own death. Killing here on behalf of a remote player
        // would kill me for standing near someone else's chase.
        if (canReachMe(s) && !isInvulnerable()) {
          killPlayer('Torn apart by a skeleton')
        }
        // Debug overlay: exactly what canReachMe() tests — a flat radius plus
        // the body-height band, drawn at the skeleton's own feet.
        volumeCylinder('skeleton', drawnSkeletons++, here, SKELETON_KILL_RADIUS,
                       here.y, here.y + SKELETON_BODY_HEIGHT, VOLUME_COLOURS.skeleton)
        const flat = Math.hypot(prey.x - here.x, prey.z - here.z)
        if (flat < SKELETON_KILL_RADIUS) {
          playOneShot(s, SKELETON_ANIM.attack, 1.1)
          if (!isMobileNow()) playSoundAt(SOUND_SKELETON_ATTACK, here, 1)
          s.state = 'striking'
          s.timer = SKELETON_ATTACK_REST_SECONDS
        }
        break
      }
    }
  }

  endVolumes('skeleton', drawnSkeletons)
}

// ─────────────────────────────────── setup ───────────────────────────────────

/**
 * Nudge a grave to the nearest cell the skeleton can actually stand on.
 *
 * A spawn on a blocked cell strands it for the whole round — every direction
 * is blocked, so it never takes a step. That really happened with the old
 * grave-row spawn, where only 11 of the 49 cells within 1.5m were walkable.
 * Search outwards in rings instead of trusting the coordinate.
 */
function nearestFreeSpawn(x: number, z: number): Vector3 {
  if (!blockedAt(x, z)) return Vector3.create(x, 0, z)
  const step = SKELETON_GRID_CELL
  for (let ring = 1; ring <= 24; ring++) {
    for (let dj = -ring; dj <= ring; dj++) {
      for (let di = -ring; di <= ring; di++) {
        if (Math.abs(di) !== ring && Math.abs(dj) !== ring) continue
        const nx = x + di * step
        const nz = z + dj * step
        if (!blockedAt(nx, nz)) {
          console.log(
            `[skeletons] grave (${x.toFixed(2)}, ${z.toFixed(2)}) was blocked; ` +
            `rising at (${nx.toFixed(2)}, ${nz.toFixed(2)}) instead`
          )
          return Vector3.create(nx, 0, nz)
        }
      }
    }
  }
  console.log(`[skeletons] grave (${x.toFixed(2)}, ${z.toFixed(2)}) is walled in on every side`)
  return Vector3.create(x, 0, z)
}

/**
 * Wake or park one skeleton. Never creates or destroys anything: all of them
 * are built at init and the extras are switched off, so a round change cannot
 * churn entities mid-game.
 */
function setSkeletonActive(s: Skeleton, on: boolean) {
  if (s.active === on) return
  s.active = on
  VisibilityComponent.createOrReplace(s.root, { visible: on })
  const a = AudioSource.getMutable(s.audio)
  a.playing = on
  s.rattleVol = on ? 0.55 : 0
  if (!on) return
  riseFromGrave(s) // wake up clean, on its grave, not wherever it was parked
}

/**
 * How many skeletons are live this round.
 *
 * PUSHED IN by gameLoop rather than pulled from it: reading getCandlesRequired()
 * here would make skeletons -> gameLoop, and gameLoop already reaches back here
 * through sounds.ts (which imports nearestSkeletonDistance) — a real import
 * cycle. Taking the number as an argument keeps this module a leaf.
 */
export function setSkeletonsForRound(candlesRequired: number) {
  const want = candlesRequired > RITUAL_CANDLES_ROUND1 ? SKELETON_COUNT_LATER : SKELETON_COUNT_ROUND1
  for (let i = 0; i < skeletons.length; i++) setSkeletonActive(skeletons[i], i < want)
}

export function initSkeletons() {
  for (const raw of SKELETON_SPAWNS) {
    const grave = nearestFreeSpawn(raw.x, raw.z)
    const root = engine.addEntity()
    Transform.create(root, {
      position: Vector3.create(grave.x, groundAt(grave.x, grave.z) + SKELETON_MODEL_Y_OFFSET, grave.z),
      rotation: Quaternion.fromEulerDegrees(0, Math.random() * 360, 0),
      scale: Vector3.create(SKELETON_SCALE, SKELETON_SCALE, SKELETON_SCALE)
    })
    // BOTH masks. invisibleMeshesCollisionMask defaults to CL_PHYSICS, so
    // naming only the visible one leaves any _collider mesh in the .glb solid
    // — the bug that was blocking players at every candle. Inert today (this
    // model ships no collider node) and stays correct if the model is swapped.
    GltfContainer.create(root, {
      src: MODEL_SKELETON,
      visibleMeshesCollisionMask: ColliderLayer.CL_POINTER,
      invisibleMeshesCollisionMask: ColliderLayer.CL_NONE
    })
    Animator.create(root, {
      states: [
        { clip: SKELETON_ANIM.walk, playing: true, loop: true },
        { clip: SKELETON_ANIM.run, loop: true },
        { clip: SKELETON_ANIM.idle, loop: true },
        { clip: SKELETON_ANIM.attack, loop: false },
        { clip: SKELETON_ANIM.hit, loop: false },
        { clip: SKELETON_ANIM.death, loop: false }
      ]
    })

    // A SOLID BODY, on request.
    //
    // BE CLEAR ABOUT WHAT THIS DOES: it makes the PLAYER unable to walk
    // through the skeleton. It does NOT stop the skeleton walking through
    // walls, and it cannot — this entity has no rigid body, its Transform is
    // written directly every frame, so scene colliders exert no force on it
    // whatsoever. What keeps it out of the scenery is blockedAt(), canStepTo()
    // and the A* route above; if it ever clips a wall again, the grid is what
    // to re-bake (tools/bake_skeleton_grid.py), not this box.
    //
    // Sized in LOCAL space, so divided by SKELETON_SCALE: the body is roughly
    // 0.55m across and SKELETON_BODY_HEIGHT tall in world units, and the box
    // is lifted to sit on the model's feet rather than centred on its origin.
    const body = engine.addEntity()
    Transform.create(body, {
      position: Vector3.create(0, SKELETON_BODY_HEIGHT / 2 / SKELETON_SCALE, 0),
      scale: Vector3.create(
        0.55 / SKELETON_SCALE,
        SKELETON_BODY_HEIGHT / SKELETON_SCALE,
        0.55 / SKELETON_SCALE
      ),
      parent: root
    })
    MeshCollider.setBox(body, ColliderLayer.CL_PHYSICS)

    const audio = engine.addEntity()
    Transform.create(audio, { position: Vector3.create(0, 1, 0), parent: root })
    AudioSource.create(audio, {
      audioClipUrl: SOUND_BONE_RATTLE,
      playing: true,
      loop: true,
      volume: gain(0.55)
    })

    const s: Skeleton = {
      root,
      audio,
      grave: Vector3.create(grave.x, 0, grave.z),
      state: 'lurking',
      timer: 0,
      anim: SKELETON_ANIM.walk,
      animLock: 0,
      animRefresh: ANIM_REFRESH_SECONDS,
      rattleVol: 0.55,
      stuck: 0,
      turnSign: Math.random() < 0.5 ? -1 : 1,
      path: [],
      pathGoal: null,
      repathTimer: 0,
      active: true
    }
    skeletons.push(s)

    // The click/tap "Stab — butcher knife" prompt was REMOVED on 2026-08-19
    // on request. It was the last way to damage a skeleton, so stab(),
    // applyHit(), knockDown() and the knife-hit flinch went with it: nothing
    // reaches them any more. A skeleton is now a pure hazard you avoid rather
    // than fight, and it only leaves play by killing you (SKELETON_ANIM.death
    // is consequently unused too, but is left in the Animator state list — the
    // clip exists in the .glb and declaring it costs nothing).
  }

  // Round 1 until gameLoop says otherwise, so the extras start parked rather
  // than all appearing for one frame before the first reset.
  setSkeletonsForRound(RITUAL_CANDLES_ROUND1)

  addSafeSystem(skeletonSystem, 'skeletonSystem')
}
