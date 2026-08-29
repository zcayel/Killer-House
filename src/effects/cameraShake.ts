/**
 * CAMERA SHAKE — a verbatim rebuild of the module written for the Voronoi
 * fireball arena, which is the version that actually reads as impact in the
 * Explorer. Same constants, same maths, same structure; the only addition is
 * the death-replay guard, because this scene has a replay and that one did not.
 *
 * THE CONSTRAINT, because it shapes everything below: there is no additive
 * camera shake in this SDK. The player camera's Transform is engine-owned, and
 * the only way to move the view is to point MainCamera at a VirtualCamera you
 * control. A VirtualCamera does NOT use player mouse look — it is driven
 * entirely by its own entity's Transform. So taking the camera IS the lock;
 * there is no shake-without-lock version.
 *
 * What this does about it:
 *
 *   - Bursts are SHORT — half a second at the very most. Long enough to
 *     register as impact, short enough that a frozen look direction is not
 *     something the player can act on or, mostly, notice.
 *
 *   - The camera stays GLUED TO THE PLAYER. The camera-to-player offset is
 *     captured once when the burst starts and re-applied to the player's live
 *     position every frame. Without this, walking during a shake would leave
 *     the camera standing still while the world slid past — which reads as a
 *     bug, not as a hit. This is the part that makes the effect usable.
 *
 *     It is also why this one does not zoom, where the version that used to
 *     live in deathEffects.ts did. That one snapshotted the camera's WORLD
 *     position and held it, then tried to detect and correct a head-anchored
 *     third-person report using CameraMode — a renderer-written component that
 *     can be absent, in which case the correction never ran and the view
 *     snapped into the avatar's skull. Re-applying a captured offset preserves
 *     whatever the client reports, so there is nothing to detect and nothing
 *     to correct.
 *
 *   - THE ZOOM IS NEVER SPENT. Whatever distance the player is viewing from
 *     when a burst starts, they are still viewing from at least that distance
 *     on every frame of it. Enforced twice: the inward half of the horizontal
 *     jitter is projected out in update(), and a burst that could not honour
 *     the rule on frame one is declined outright in shakeCamera(). See both.
 *
 *   - Only ROTATION is frozen for the duration, and the jitter is perturbing
 *     rotation anyway, so there is little to see.
 *
 * If it misbehaves, set ENABLED to false. The ground quake (effects/quake.ts)
 * fires alongside it on every thunder strike and carries the effect on its own,
 * so nothing else has to change.
 */

import { engine, Transform, MainCamera, VirtualCamera, CameraMode, Entity } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { deathCamActive } from './deathCam'
import { victoryCinematicActive } from './victoryCinematic'

/** Master switch. False falls back to the ground quake alone. */
const ENABLED = true

const BURST = 0.32
/** Metres of throw at full strength. Small — this is inches from the eye. */
const AMP_POS = 0.3
/** Degrees of wobble at full strength. */
const AMP_ROT = 2.4
// Deliberately non-harmonic frequencies, so the jitter never settles into a
// rhythm the eye can follow — that is the difference between a shake and a
// wobble.
const F_X = 41.0
const F_Y = 53.0
const F_Z = 37.0
const F_R = 47.0

/**
 * CameraType.CT_FIRST_PERSON, written out rather than imported. CameraType is a
 * `const enum` in the SDK's generated protobuf and is NOT re-exported as a
 * value from @dcl/sdk/ecs — importing it compiles under isolatedModules only by
 * accident and there is no tsc here to catch it if that changes. The wire value
 * is fixed by the protocol.
 */
const CT_FIRST_PERSON = 0
/**
 * Metres, horizontal, between the avatar and where the client says the camera
 * is. Third person in Decentraland orbits several metres out, so anything under
 * this in third person means the client handed us the HEAD.
 */
const MIN_ORBIT_REACH = 0.75

/**
 * True when engine.CameraEntity's reported position can be trusted as the place
 * the player is actually looking from.
 *
 * THIS IS THE ANTI-ZOOM CHECK, and it is the whole difference between this and
 * the version that snapped into the avatar's skull. Some clients report
 * CameraEntity at the avatar's HEAD while the player is in third person. Every
 * approach to a scene-driven shake — this one included — puts a VirtualCamera
 * at that reported position, so when the report is head-anchored the view jumps
 * from four metres behind the avatar to inside it. That jump is what reads as
 * "the camera zoomed in", and no amount of tuning the motion fixes it, because
 * the motion was never wrong: the starting point was. See effects/quake.ts,
 * which exists because of the same bug.
 *
 * There is no way to recover the real orbit position from inside a scene, so
 * this does not try. It declines the shake instead — the same rule update()
 * enforces frame by frame, applied to frame one: if the burst cannot start
 * without costing the player zoom, it does not start. The caller falls back to
 * the ground quake, which moves the world rather than the view and therefore
 * cannot zoom by construction.
 */
function cameraReportIsTrustworthy(camPos: Vector3, playerPos: Vector3): boolean {
  // First person: head IS the camera, so a near-zero reach is correct and the
  // shake is both safe and at its most effective.
  const mode = CameraMode.getOrNull(engine.CameraEntity)
  if (mode && mode.mode === CT_FIRST_PERSON) return true
  // Third person, cinematic, or — on clients that never write the component —
  // unknown. Horizontal only: the orbit sits behind the avatar, and the head is
  // above it, so height is exactly the axis that cannot tell them apart.
  const dx = camPos.x - playerPos.x
  const dz = camPos.z - playerPos.z
  return Math.sqrt(dx * dx + dz * dz) >= MIN_ORBIT_REACH
}

let cam: Entity
let ready = false
let active = false
let age = 0
let dur = 0
let power = 0
/** Camera position minus player position, captured at the start of a burst. */
let offset = Vector3.Zero()
let baseRot = Quaternion.Identity()
/** So the head-anchored-report notice is printed once, not once per strike. */
let warnedAboutReport = false
/**
 * Horizontal metres between avatar and camera when the burst began — the zoom
 * level THE RULE protects. Zero means first person, where there is no zoom to
 * protect and the guard below switches itself off.
 */
let heldReach = 0
/**
 * Unit vector on the ground plane pointing from the avatar OUT to the camera.
 * Any jitter running against this is jitter that would zoom in, and is removed.
 */
let outX = 0
let outZ = 0

function release() {
  active = false
  MainCamera.createOrReplace(engine.CameraEntity, {})
}

/**
 * True while the view is hijacked. Anything that aims or frames off the camera
 * must ask this first — while a burst runs, reading CameraEntity returns this
 * file's rig, frozen at the rotation the burst began on and deliberately
 * jittered.
 */
export function isCameraShaking(): boolean {
  return active
}

/**
 * @param strength 0..1
 * @param seconds  how long to hold the view; keep it short
 * @returns true if the view is now under shake control. FALSE MEANS NOTHING
 *   HAPPENED and the caller should carry the impact some other way — see
 *   lightning.ts, which drives the ground quake harder when this declines.
 */
export function shakeCamera(strength: number, seconds = BURST): boolean {
  if (!ENABLED || !ready) return false
  // NEVER FIGHT THE DEATH REPLAY. It holds MainCamera for several seconds and
  // a shake would take the shot away mid-playback, then hand back a camera the
  // replay had already moved on from.
  if (deathCamActive) return false
  // Nor the victory cinematic, which holds it for longer and is the one shot in
  // the scene a player only sees by earning it. A thunderclap landing three
  // seconds into a win used to be enough to take it away.
  if (victoryCinematicActive) return false
  const s = Math.max(0, Math.min(1, strength))
  if (s <= 0) return false

  if (active) {
    // Already shaking: REINFORCE rather than restart. Restarting would reset
    // the decay every time a second hit landed, and four bolts arriving
    // together could then hold the camera indefinitely.
    power = Math.max(power, s)
    dur = Math.max(dur, age + seconds)
    return true
  }

  // Capture the live view ONCE, before taking it over. After MainCamera is
  // pointed at the virtual camera, reading CameraEntity reports the virtual
  // camera's own transform — sampling it then would feed back into itself.
  let camPos: Vector3
  let playerPos: Vector3
  try {
    const c = Transform.get(engine.CameraEntity)
    camPos = c.position as Vector3
    baseRot = c.rotation as Quaternion
    playerPos = Transform.get(engine.PlayerEntity).position as Vector3
  } catch {
    // No player transform yet — scene is still loading.
    return false
  }

  if (!cameraReportIsTrustworthy(camPos, playerPos)) {
    // ONCE, not every strike. If this fires, every camera shake in the scene is
    // silently off and only the quake is running — worth knowing, not worth a
    // line of log per thunderclap.
    if (!warnedAboutReport) {
      warnedAboutReport = true
      console.log(
        '[cameraShake] client reports CameraEntity at the avatar head in third person;' +
        ' declining the shake so the view cannot snap. Ground quake carries it instead.'
      )
    }
    return false
  }

  offset = Vector3.subtract(camPos, playerPos)
  // THE RULE, half one: record the zoom the player currently has, so update()
  // can refuse to spend any of it. Horizontal, because the orbit sits behind
  // the avatar and height is the one axis that says nothing about zoom.
  heldReach = Math.sqrt(offset.x * offset.x + offset.z * offset.z)
  if (heldReach >= MIN_ORBIT_REACH) {
    outX = offset.x / heldReach
    outZ = offset.z / heldReach
  } else {
    // First person. Nothing to protect, and no meaningful direction to project
    // against — the guard in update() reads this and lets the jitter through.
    heldReach = 0
    outX = 0
    outZ = 0
  }
  age = 0
  dur = seconds
  power = s
  Transform.getMutable(cam).position = camPos
  Transform.getMutable(cam).rotation = baseRot
  active = true
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: cam })
  return true
}

function update(dt: number) {
  if (!active) return
  age += dt
  if (age >= dur) {
    release()
    return
  }
  // The replay can start mid-burst. Get out of its way rather than spend the
  // rest of the burst wrestling it for MainCamera.
  //
  // A BARE FLAG, NOT release(). The replay has already pointed MainCamera at
  // its own rig and re-asserts that every frame; calling release() here would
  // clear the pointer it just set, and if this system happens to run after the
  // replay's in a given frame the player sees one frame of their own camera
  // punched into the middle of the recap.
  if (deathCamActive) {
    active = false
    return
  }
  // Same bare flag for the same reason — the cinematic re-asserts MainCamera
  // every frame, so release() here would clear a pointer it is about to set
  // again and punch one frame of the player's own view into the middle of it.
  if (victoryCinematicActive) {
    active = false
    return
  }

  let base: Vector3
  try {
    base = Transform.get(engine.PlayerEntity).position as Vector3
  } catch {
    release()
    return
  }

  // Squared falloff: a hard hit that dies quickly, rather than a fade that
  // draws attention to how long the camera has been held.
  const decay = 1 - age / dur
  const amp = power * decay * decay

  let jx = Math.sin(age * F_X) * AMP_POS * amp
  const jy = Math.sin(age * F_Y) * AMP_POS * amp
  let jz = Math.sin(age * F_Z) * AMP_POS * amp

  // ══ THE RULE ══════════════════════════════════════════════════════════════
  // A SHAKE MAY NEVER SPEND THE PLAYER'S ZOOM. On a full zoom-out the camera
  // must still be exactly that far out when the burst ends, and at no frame in
  // between may it be nearer.
  //
  // Half the horizontal jitter naturally points from the camera back toward the
  // avatar, and at AMP_POS that is up to 30cm of unasked-for dolly-in per
  // oscillation. It reads as the view lunging at your own back, which is what
  // "it zooms in when it shakes" was.
  //
  // So the inward COMPONENT is projected out — not clamped, not scaled: the
  // jitter is decomposed against the avatar-to-camera direction and anything
  // running against it is removed, leaving the sideways part untouched. The
  // camera is then free to swing across and to be shoved further out (which
  // reads as recoil and is welcome), and simply cannot come in.
  //
  // Vertical is left alone: raising or dropping the lens does not change how
  // far out the player is looking from.
  //
  // heldReach is 0 in first person, where the camera IS the head, there is no
  // zoom to protect and no sane direction to project against. The guard skips
  // itself rather than pretending otherwise.
  if (heldReach > 0) {
    const inward = jx * outX + jz * outZ
    if (inward < 0) {
      jx -= inward * outX
      jz -= inward * outZ
    }
  }

  const t = Transform.getMutable(cam)
  t.position = Vector3.create(
    base.x + offset.x + jx,
    base.y + offset.y + jy,
    base.z + offset.z + jz
  )
  t.rotation = Quaternion.multiply(
    baseRot,
    Quaternion.fromEulerDegrees(
      Math.sin(age * F_R) * AMP_ROT * amp,
      Math.sin(age * F_X * 0.7) * AMP_ROT * amp,
      Math.sin(age * F_Z * 0.9) * AMP_ROT * amp
    )
  )
}

export function initCameraShake() {
  if (ready) return
  cam = engine.addEntity()
  // Parked far below the scene until a burst poses it, so a stray frame can
  // never render from the origin.
  Transform.create(cam, { position: Vector3.create(0, -500, 0) })
  VirtualCamera.create(cam, {})
  ready = true

  let reported = false
  engine.addSystem((dt: number) => {
    try {
      update(dt)
    } catch (err) {
      if (!reported) {
        reported = true
        console.log('[cameraShake] system threw (further errors suppressed):', err)
      }
      // Never leave the player's camera hostage to a thrown error.
      release()
    }
  })
}
