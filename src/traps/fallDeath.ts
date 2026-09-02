/**
 * FALL DEATH — physics-based version.
 *
 * The old version placed invisible trigger boxes along guessed railing
 * coordinates, which never matched the real house. This one needs no
 * coordinates at all: it watches the player's vertical motion every frame
 * and kills on landing after any fast, continuous drop taller than
 * FALL_KILL_DISTANCE.
 *
 * Why stairs and jumps are safe:
 *  - Walking down stairs is a slow, stepped descent - each step break resets
 *    the streak, and the downward speed never reaches FALL_KILL_MIN_SPEED.
 *  - A normal jump only falls ~1m at ~4.4 m/s peak - under both thresholds.
 *  - A genuine plunge (2nd floor -> ground) free-falls 3m+ and passes both.
 */

import { engine, Transform } from '@dcl/sdk/ecs'
import {
  FALL_KILL_DISTANCE,
  FALL_KILL_MIN_SPEED,
  FALL_KILL_MIN_START_Y,
  HOUSE_RECT,
  HOUSE_WING_RECTS
} from '../config'
import { killPlayer, isInvulnerable } from '../gameState'
import { addSafeSystem } from '../safeSystem'

// A single-frame drop faster than this is a teleport (respawn), not a fall
const TELEPORT_SPEED = 30 // m/s

// MOBILE tolerance. The mobile client's reported player position is not the
// crisp per-physics-step Y desktop gives us — it can be smoothed (capping the
// apparent peak speed below FALL_KILL_MIN_SPEED so a real plunge never
// "qualifies") and jittery (injecting single non-descending frames mid-fall
// that would end the streak early, splitting one 6m fall into chunks that
// each miss FALL_KILL_DISTANCE). Two additions:
//  - Once a descent is going fast enough to be a genuine fall (peak above
//    FALL_GRACE_MIN_PEAK — stair-stepping never gets near it), a brief pause
//    in descending is forgiven instead of ending the streak.
//  - The kill check also accepts a sustained AVERAGE descent speed, which
//    survives smoothing. Free-fall from rest averages ~4.7 m/s over the drop;
//    running down even a steep staircase stays well under FALL_KILL_AVG_SPEED.
const FALL_STREAK_GRACE = 0.15 // seconds of non-descent forgiven mid-fall
const FALL_GRACE_MIN_PEAK = 3 // grace only applies once genuinely falling (m/s)
const FALL_KILL_AVG_SPEED = 4.5 // m/s averaged over the whole descent

let prevY: number | null = null
let dropDistance = 0 // height lost in the current continuous descent
let peakFallSpeed = 0 // fastest downward speed reached during that descent
let descentTime = 0 // seconds spent in the current descent
let graceTimer = 0 // seconds of consecutive non-descent so far
let descentStartY = 0 // world Y the current descent began at — names the death
// WHERE the descent began, not just how high. The height gate alone says "you
// were up high"; it cannot tell the second floor from the same altitude out
// over the yard or off the roofline. On request, the fall only kills if it
// started with the player standing ON the second floor, so the footprint is
// recorded with the height and both are tested.
let descentStartX = 0
let descentStartZ = 0

function resetFall() {
  dropDistance = 0
  peakFallSpeed = 0
  descentTime = 0
  graceTimer = 0
  descentStartY = 0
  descentStartX = 0
  descentStartZ = 0
}

/**
 * Was the player standing on the second floor when this descent began?
 *
 * The second floor is the single room upstairs — the one holding Soccer Ball_3
 * at (16.84, 8.32, 16.82), with the crate at z 19.74 and the swing trap's blade
 * at z 10.94 marking its extent. Rather than hand-type that room's corners and
 * risk a rect that stops short of the railing a player actually falls over,
 * this tests the BUILDING footprint and lets the height gate do the rest:
 * inside the house, above FALL_KILL_MIN_START_Y, is the second floor.
 *
 * The wings are included because they are part of the same structure. Anything
 * outside both — the yard, the graves, the fence line, open air past the
 * roofline — cannot produce a lethal fall at any height or speed.
 */
function startedOnSecondFloor(): boolean {
  if (descentStartY < FALL_KILL_MIN_START_Y) return false
  const x = descentStartX
  const z = descentStartZ
  if (x >= HOUSE_RECT.minX && x <= HOUSE_RECT.maxX && z >= HOUSE_RECT.minZ && z <= HOUSE_RECT.maxZ) return true
  for (const w of HOUSE_WING_RECTS) {
    if (x >= w.minX && x <= w.maxX && z >= w.minZ && z <= w.maxZ) return true
  }
  return false
}

/**
 * Names the fall from where it STARTED, not from a guess.
 *
 * This used to hardcode "Fell from the second floor" for every qualifying
 * fall, which is exactly the "incorrect fall-death messages" the Week 2
 * playtest reported — and a death screen whose headline is the cause of
 * death (see ui.tsx) can't afford to state a cause that didn't happen.
 *
 * The 6m band matches areaIndexForY() in gameLoop.ts. In practice nearly
 * every lethal fall in this house does start above it: upstairs sits at
 * y≈8.4, and the only other high ground is the chandelier on its y
 * 3.18-13.18 ride — and since FALL_KILL_DISTANCE is 4.5m, a fall that
 * qualifies at all has to have begun at roughly that height or higher. The
 * ground floor (y≈2.58) is only 2.58m above the yard, so it can never
 * produce one. The generic branch is therefore a rare edge case, and it says
 * only what we actually know.
 */
function fallCause(startY: number): string {
  if (startY >= 6) return 'Fell from the second floor'
  return 'Fell to your death'
}

function fallDeathSystem(dt: number) {
  if (dt <= 0) return
  if (!Transform.has(engine.PlayerEntity)) return

  const p = Transform.get(engine.PlayerEntity).position
  const y = p.y

  if (isInvulnerable()) {
    // mid-death/respawn: don't carry fall state across the teleport
    prevY = y
    resetFall()
    return
  }

  if (prevY === null) {
    prevY = y
    return
  }

  const dy = y - prevY
  prevY = y
  const fallSpeed = -dy / dt // positive while moving down

  if (fallSpeed > TELEPORT_SPEED) {
    resetFall()
    return
  }

  if (dy < -0.001) {
    // still descending: keep building the streak. On the FIRST descending
    // frame, remember where the drop began — prevY was already advanced to y
    // above, so the height we started from this frame is (y - dy). A streak
    // resumed after a grace pause keeps its original start, which is what
    // fallCause() wants.
    if (dropDistance === 0) {
      descentStartY = y - dy
      // x/z barely move over one frame of free-fall, so this frame's are the
      // ledge's for every purpose this test has.
      descentStartX = p.x
      descentStartZ = p.z
    }
    dropDistance += -dy
    descentTime += dt
    graceTimer = 0
    if (fallSpeed > peakFallSpeed) peakFallSpeed = fallSpeed
    return
  }

  // Not descending this frame. Mid-fall reporting jitter (see the mobile
  // note above) is forgiven briefly — but only once this is unmistakably a
  // fall, so stair-stepping keeps its per-step streak reset.
  if (peakFallSpeed >= FALL_GRACE_MIN_PEAK) {
    graceTimer += dt
    if (graceTimer < FALL_STREAK_GRACE) return
  }

  // Descent ended (landed or moving back up): judge the completed fall.
  // Uncomment to tune thresholds in preview - shows every completed descent:
  // if (dropDistance > 0.5) console.log(`fall: dropped ${dropDistance.toFixed(2)}m, peak ${peakFallSpeed.toFixed(1)} m/s, avg ${(descentTime > 0 ? dropDistance / descentTime : 0).toFixed(1)} m/s`)
  const avgSpeed = descentTime > 0 ? dropDistance / descentTime : 0
  // WHERE IT STARTED, before how far or how fast it went. The two thresholds
  // below describe the shape of a fall and say nothing about its origin, so on
  // their own they killed for any fast 4.5m drop — off the chandelier, into a
  // stairwell, or after a double jump from high ground. Upstairs is the only
  // place in this house you are meant to be able to fall from, so that is now a
  // precondition rather than something the numbers are trusted to imply.
  const fromUpstairs = startedOnSecondFloor()
  if (fromUpstairs && dropDistance >= FALL_KILL_DISTANCE && (peakFallSpeed >= FALL_KILL_MIN_SPEED || avgSpeed >= FALL_KILL_AVG_SPEED)) {
    killPlayer(fallCause(descentStartY))
  }
  resetFall()
}

export function initFallDeath() {
  addSafeSystem(fallDeathSystem, 'fallDeathSystem')
}
