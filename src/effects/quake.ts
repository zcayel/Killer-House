/**
 * GROUND QUAKE — the earthquake, done by moving the WORLD instead of the camera.
 *
 * WHY NOT THE CAMERA. Moving the camera in SDK7 means handing the view to a
 * VirtualCamera, which renders from whatever Transform it is given. Matching a
 * third-person pose requires knowing how far behind the avatar the real camera
 * sits, and that number is not reliably available — engine.CameraEntity can
 * report the head rather than the orbit, and CameraMode, the component that
 * would say which, is renderer-written and can be absent. When it is, the view
 * snaps into the avatar's skull the moment the shake takes over. That snap is
 * what "the camera zooms in" was, through four separate attempts to fix it
 * from the motion side. See the note at the top of deathEffects.ts.
 *
 * Sliding every piece of scenery the same distance in the same direction is
 * VISUALLY IDENTICAL to sliding the camera the opposite way — the eye cannot
 * tell which of the two moved. So this buys the whole illusion while never
 * touching the camera, and no amount of amplitude can produce a zoom.
 *
 * HORIZONTAL ONLY. Vertical movement would drag the floor collider up through
 * the player's feet and bounce them; sideways motion under a standing avatar
 * does nothing, because there is no friction to drag them along with it.
 *
 * DELTAS, NOT ABSOLUTE POSITIONS. Each frame applies the CHANGE in offset
 * rather than writing base+offset. That matters because some of these entities
 * move under their own systems — a skeleton walking during a strike would be
 * yanked back to wherever it stood when the quake began, and then snapped again
 * when the quake ended. Riding on top as a delta leaves their own motion
 * untouched, and since the offset always returns to zero the net displacement
 * is exactly zero by construction rather than by bookkeeping.
 */

import { engine, Transform, GltfContainer, Entity } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { QUAKE_AMPLITUDE, QUAKE_SECONDS } from '../config'
import { addSafeSystem } from '../safeSystem'

/**
 * The scenery. Captured ONCE at init, deliberately.
 *
 * Rebuilding it per quake would be cheap and would also sweep up the synced
 * tombstones, whose Transform is replicated — writing to those would broadcast
 * a shaking headstone to every other player in the plot. Everything synced in
 * this scene is either created after init (tombstones, on death) or carries no
 * GltfContainer (the avatar-hide area), so an init-time snapshot filtered to
 * GltfContainer excludes them all without needing to test for it.
 */
const scenery: Entity[] = []

let quakeTimer = 0
let quakeDuration = 0
let quakeAmp = 0
let phase = 0
/** The offset currently baked into the scenery, so the next frame can undo it. */
let applied = Vector3.create(0, 0, 0)

function shift(dx: number, dz: number): void {
  if (dx === 0 && dz === 0) return
  for (const e of scenery) {
    if (!Transform.has(e)) continue
    const t = Transform.getMutable(e)
    t.position = Vector3.create(t.position.x + dx, t.position.y, t.position.z + dz)
  }
}

/** Put everything back. Safe to call at any time, including mid-quake. */
export function stopQuake(): void {
  quakeTimer = 0
  shift(-applied.x, -applied.z)
  applied = Vector3.create(0, 0, 0)
}

/**
 * Kick off a tremor. Later calls override rather than stack — two strikes
 * landing together should read as one bigger jolt, not as double amplitude
 * that throws the scenery visibly off its foundations.
 */
export function startQuake(seconds = QUAKE_SECONDS, amplitude = QUAKE_AMPLITUDE): void {
  quakeTimer = seconds
  quakeDuration = seconds
  quakeAmp = amplitude
  phase = 0
}

function quakeSystem(dt: number): void {
  if (quakeTimer <= 0) {
    if (applied.x !== 0 || applied.z !== 0) stopQuake()
    return
  }
  quakeTimer -= dt
  phase += dt

  // Squared decay — a strike is a jolt that dies, not a rumble that fades. A
  // linear falloff keeps too much amplitude in the tail and reads as a rumble.
  const decay = Math.max(0, quakeTimer / quakeDuration)
  const amp = quakeAmp * decay * decay

  // Two unrelated rates on the two horizontal axes (~8.6Hz against ~6.5Hz) so
  // the ground traces a wandering figure rather than sliding back and forth
  // along one diagonal. The offset phase keeps them from starting together.
  const target =
    quakeTimer <= 0
      ? Vector3.create(0, 0, 0)
      : Vector3.create(amp * Math.sin(phase * 54), 0, amp * Math.sin(phase * 41 + 1.3))

  shift(target.x - applied.x, target.z - applied.z)
  applied = target
}

export function initQuake(): void {
  // Snapshot the scenery. Unparented only: a child inherits its parent's
  // movement, so shifting both would move it twice as far as everything else
  // and tear it off whatever it is attached to.
  for (const [e] of engine.getEntitiesWith(GltfContainer, Transform)) {
    if (Transform.get(e).parent === undefined) scenery.push(e)
  }
  addSafeSystem(quakeSystem, 'quakeSystem')
}
