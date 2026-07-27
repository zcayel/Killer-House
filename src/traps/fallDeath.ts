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
import { FALL_KILL_DISTANCE, FALL_KILL_MIN_SPEED } from '../config'
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

function resetFall() {
  dropDistance = 0
  peakFallSpeed = 0
  descentTime = 0
  graceTimer = 0
}

function fallDeathSystem(dt: number) {
  if (dt <= 0) return
  if (!Transform.has(engine.PlayerEntity)) return

  const y = Transform.get(engine.PlayerEntity).position.y

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
    // still descending: keep building the streak
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
  if (dropDistance >= FALL_KILL_DISTANCE && (peakFallSpeed >= FALL_KILL_MIN_SPEED || avgSpeed >= FALL_KILL_AVG_SPEED)) {
    killPlayer('Fell from the second floor')
  }
  resetFall()
}

export function initFallDeath() {
  addSafeSystem(fallDeathSystem, 'fallDeathSystem')
}
