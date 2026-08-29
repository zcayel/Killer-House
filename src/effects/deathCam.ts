/**
 * DEATH REPLAY — records the last few seconds of your life and plays them back.
 *
 * A rolling buffer of the player's position and facing is kept while you are
 * alive. On death it is frozen, and the replay walks a ghost along that exact
 * path with the camera trailing it, ending on the spot where you were hit.
 *
 * THE HAZARDS COME WITH IT. The world's half of the recording lives in
 * replayStage.ts: the axe that killed you swings again, on the same cue, into
 * the same ghost. Read that file's header for how each kind of hazard is got
 * back and for the one that still cannot be (the chandelier's tween).
 *
 * What that means for the timing here: this file owns the sampling cadence and
 * the stage borrows it, so every player sample and every hazard cue is stamped
 * off one clock (stageNow). Two clocks nominally at 20Hz would drift by a frame
 * and put the blade a frame off the body it hit.
 *
 * The ghost IS your avatar. AvatarShape renders a real Decentraland avatar from
 * a body shape, colours and a wearable list, and getPlayer() hands us exactly
 * those for the local player — so the replay shows you, in your own clothes,
 * not a stand-in. The outfit is read fresh on every press, so changing clothes
 * mid-round is picked up.
 *
 * The clone EXISTS only while the replay is running. Its AvatarShape is added
 * on press and deleted on stop rather than being toggled with a
 * VisibilityComponent, because a hidden-but-present avatar is still a second
 * body in the scene — it can be seen by other players, and a stray one standing
 * at the origin is exactly the sort of thing that ships. No component, no
 * clone. Recording still runs continuously; only the playback is on demand.
 */

import {
  engine,
  Transform,
  VirtualCamera,
  MainCamera,
  AvatarShape,
  InputModifier,
  InputAction,
  inputSystem,
  PrimaryPointerInfo,
  PointerLock,
  GltfContainer,
  ColliderLayer,
  Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color3 } from '@dcl/sdk/math'
import { getPlayer } from '@dcl/sdk/players'
import {
  DEATH_CAM_ENABLED,
  DEATH_CAM_AUTOPLAY,
  DEATH_REPLAY_SECONDS,
  DEATH_REPLAY_SAMPLE_HZ,
  DEATH_REPLAY_TAIL_SECONDS,
  DEATH_CAM_DISTANCE,
  DEATH_CAM_TARGET_HEIGHT,
  DEATH_CAM_PITCH,
  DEATH_CAM_PITCH_MIN,
  DEATH_CAM_PITCH_MAX,
  DEATH_CAM_MOUSE_SENSITIVITY,
  DEATH_CAM_SMOOTH_TAPS,
  DEATH_CAM_RESPONSE,
  TOMBSTONE_MODELS
} from '../config'
import { onPlayerDeath, isPlayerDead, setCameraLockInvulnerable } from '../gameState'
import { playerPosition } from '../playerTracker'
import { addSafeSystem } from '../safeSystem'
import {
  stageNow,
  stageAdvance,
  stageSample,
  stageWipe,
  stageFreeze,
  stageBegin,
  stageTick,
  stageEnd,
  stageClear
} from './replayStage'

interface Sample {
  p: Vector3
  /** Facing in degrees about Y, so the ghost turns the way you turned. */
  ry: number
  /**
   * Stage-clock time this sample was taken. Playback runs off sample index, but
   * the hazard cues are stamped in wall time — this is what lets the stage
   * convert one into the other exactly. See replayTimeOf in replayStage.ts.
   */
  t: number
}

const SAMPLE_DT = 1 / DEATH_REPLAY_SAMPLE_HZ
const MAX_SAMPLES = Math.ceil(DEATH_REPLAY_SECONDS * DEATH_REPLAY_SAMPLE_HZ)

/**
 * The rolling record. A plain array used as a ring buffer — at 20Hz over 5s
 * this is 100 entries, so the shift() on overflow is cheap and the code stays
 * readable. Recording is unconditional while alive: a trap can kill you in one
 * frame, so there is never a chance to start recording once it matters.
 */
const buffer: Sample[] = []
let sampleClock = 0

/** Frozen copy taken at the moment of death — what the replay actually plays. */
let recording: Sample[] = []

let cam: Entity
let ghost: Entity
/**
 * The grave, at the death spot. Its Transform is placed when the replay starts
 * but the MESH is withheld until the playhead reaches the moment of death — see
 * raiseReplayStone. The replay is a recording of you being alive; a headstone
 * standing there while the ghost is still walking toward it is a prop from the
 * future.
 */
let stone: Entity
let playing = false
let playhead = 0

/**
 * Seconds between the last recorded sample and the kill itself — 0..SAMPLE_DT.
 * See the note in replaySystem: it is what keeps the headstone from rising
 * before the trap that put it there has finished arriving.
 */
let deathOffset = 0

/** Damped camera pose. Null until the first frame of a replay seeds it. */
let camPos: Vector3 | null = null
let camAim: Vector3 | null = null

/** True while the replay owns the camera. ui.tsx holds the fade on this. */
export let deathCamActive = false

export function canReplayDeath(): boolean {
  return DEATH_CAM_ENABLED && recording.length > 1
}

/**
 * Your avatar, as an AvatarShape the scene can move.
 *
 * getPlayer() returns null on the very first frames before the profile has
 * loaded, so every field falls back to an SDK default rather than throwing —
 * a replay in a default body is far better than no replay.
 *
 * The `id` is deliberately NOT the real userId. AvatarShape keys off it, and
 * reusing the live player's id makes the engine treat this entity as that
 * player, which fights the real avatar for identity.
 */
function buildAvatar() {
  const me = getPlayer()
  const base = me?.avatar
  return {
    id: 'death-replay-ghost',
    name: '',
    bodyShape: base?.bodyShapeUrn ?? 'urn:decentraland:off-chain:base-avatars:BaseMale',
    skinColor: base?.skinColor ?? Color3.create(0.6, 0.462, 0.356),
    hairColor: base?.hairColor ?? Color3.create(0.283, 0.142, 0),
    eyeColor: base?.eyesColor ?? Color3.create(0.6, 0.462, 0.356),
    wearables: me?.wearables ?? [],
    emotes: me?.emotes ?? []
  }
}

// ── CAMERA CONTROL ─────────────────────────────────────────────────────────
//
// Mouse only. The keyboard axes and the on-screen pads were both removed on
// request once PrimaryPointerInfo was confirmed working — it is the control
// everyone reaches for first, and two more ways to do the same thing were
// clutter over the shot.
//
// Offsets applied on top of the recorded trailing shot, so an untouched mouse
// gives exactly the framing the replay had before controls existed. Reset on
// every press: a replay should always open on the readable shot, never on
// wherever the last viewing was left pointing.
let orbitYaw = 0
let orbitPitch = DEATH_CAM_PITCH

/**
 * Freeze/unfreeze the body.
 *
 * disableAll stops LOCOMOTION ONLY — scene input actions still arrive (see
 * previewSkipPressed in gameLoop.ts). Here that is what keeps the player from
 * walking off while the camera is across the room.
 */
function lockBody(locked: boolean): void {
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({ disableAll: locked })
  })
}

/**
 * Pointer movement since the last frame, in pixels, or null if this client
 * does not report it.
 *
 * Read via getEntitiesWith rather than off a named entity on purpose: the
 * renderer owns this component and which entity it lands on is not something
 * this scene should be asserting. If no entity carries it the loop finds
 * nothing and the camera simply holds its default shot rather than breaking.
 */
function pointerDelta(): { x: number; y: number } | null {
  for (const [, info] of engine.getEntitiesWith(PrimaryPointerInfo)) {
    const d = info.screenDelta
    return d ? { x: d.x, y: d.y } : null
  }
  return null
}

/** True while the explorer has the cursor captured for camera look. */
function pointerIsLocked(): boolean {
  for (const [, lock] of engine.getEntitiesWith(PointerLock)) return lock.isPointerLocked
  return false
}

function readCameraInput(): void {
  // Engaged when the cursor is captured (moving the mouse IS looking, exactly
  // as in normal play) or when a button is held, for when it has been freed.
  if (!pointerIsLocked() && !inputSystem.isPressed(InputAction.IA_POINTER)) return
  const d = pointerDelta()
  if (!d) return
  orbitYaw += d.x * DEATH_CAM_MOUSE_SENSITIVITY
  // Screen Y grows DOWNWARD, so pushing the mouse forward gives a negative
  // delta and has to raise the camera. Un-negated, the vertical axis is
  // inverted against every other game the player has ever used.
  orbitPitch -= d.y * DEATH_CAM_MOUSE_SENSITIVITY
  orbitPitch = Math.min(DEATH_CAM_PITCH_MAX, Math.max(DEATH_CAM_PITCH_MIN, orbitPitch))
}

/**
 * Was the player dead last frame? Used to catch the RESPAWN edge — see the
 * buffer wipe in recordSystem.
 */
let wasDead = false

function recordSystem(dt: number): void {
  // WIPE THE BUFFER ON RESPAWN, before any early return can skip it.
  //
  // Respawning teleports you to SPAWN_POSITION, but the rolling buffer still
  // held the seconds leading up to the PREVIOUS death. Die twice inside
  // DEATH_REPLAY_SECONDS and the second replay opened on the old death spot and
  // then teleported the ghost across the house to spawn — a straight-line
  // 20-metre jump through walls, presented as a recording of what you did.
  // The window only ever cleared itself by ageing out, which cannot happen
  // while dead because recording is suspended for the whole 10s countdown.
  if (wasDead && !isPlayerDead) {
    buffer.length = 0
    stageWipe() // the hazards' half of the same window, wiped for the same reason
  }
  wasDead = isPlayerDead

  if (isPlayerDead || playing) return
  // THE ONE CLOCK. Advanced here and nowhere else, so a hazard cue and a player
  // sample taken in the same frame carry the same stamp.
  stageAdvance(dt)
  sampleClock += dt
  if (sampleClock < SAMPLE_DT) return
  // CARRY THE REMAINDER instead of zeroing. dt is a frame, SAMPLE_DT is 50ms,
  // and they do not divide: at 30fps the first frame past the threshold is at
  // 66ms, so zeroing threw 16ms away EVERY sample and the record was laid down
  // at 15Hz. Playback assumes exactly SAMPLE_DT between samples, so the whole
  // replay ran a third too fast on any device that was not at 60fps — the
  // faster your machine, the more honest your replay, which is backwards.
  // Clamped so one long hitch cannot burn a burst of catch-up samples.
  sampleClock = Math.min(sampleClock - SAMPLE_DT, SAMPLE_DT)
  let ry = 0
  if (Transform.has(engine.PlayerEntity)) {
    const q = Transform.get(engine.PlayerEntity).rotation
    // Yaw out of the quaternion. Only Y matters — the ghost stands upright.
    ry = (Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z)) * 180) / Math.PI
  }
  buffer.push({ p: Vector3.create(playerPosition.x, playerPosition.y, playerPosition.z), ry, t: stageNow() })
  if (buffer.length > MAX_SAMPLES) buffer.shift()
  // IMMEDIATELY AFTER, on the same tick: the extras track has to be
  // index-aligned with this buffer, and the only way to guarantee that is for
  // one sampler to drive both.
  stageSample()
}

/**
 * Moving average over the frozen record. Kills the per-frame jitter in the
 * recorded yaw (it is the player's live camera facing, which never sits still
 * under a mouse) before anything derives a camera position from it.
 *
 * Yaw is averaged as a VECTOR, not as a number. Averaging degrees across the
 * 180/-180 seam gives zero — a player facing south would have the ghost snap
 * to north on any sample that straddles it.
 */
function smoothRecording(src: Sample[]): Sample[] {
  const n = src.length
  if (n < 3) return src
  const out: Sample[] = []
  for (let i = 0; i < n; i++) {
    let x = 0
    let y = 0
    let z = 0
    let sy = 0
    let cy = 0
    let count = 0
    for (let k = -DEATH_CAM_SMOOTH_TAPS; k <= DEATH_CAM_SMOOTH_TAPS; k++) {
      const j = Math.min(n - 1, Math.max(0, i + k))
      const smp = src[j]
      x += smp.p.x
      y += smp.p.y
      z += smp.p.z
      const r = (smp.ry * Math.PI) / 180
      sy += Math.sin(r)
      cy += Math.cos(r)
      count++
    }
    out.push({
      p: Vector3.create(x / count, y / count, z / count),
      ry: (Math.atan2(sy / count, cy / count) * 180) / Math.PI,
      // NOT averaged. The smoothing is about where the ghost is drawn; the
      // timestamp is what the hazard cues are pinned against, and a blurred one
      // would slide the axe off the body by however much the taps span.
      t: src[i].t
    })
  }
  return out
}

/**
 * Catmull-Rom through four samples. Linear interpolation is only C0 — the
 * position is unbroken but the VELOCITY snaps at every sample boundary, which
 * at 20Hz is twenty visible kicks a second and reads as an earthquake. This is
 * C1: the ghost changes direction smoothly through each sample instead of
 * cornering on it.
 */
function spline(p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3, t: number): Vector3 {
  const t2 = t * t
  const t3 = t2 * t
  const f = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
  return Vector3.create(f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y), f(p0.z, p1.z, p2.z, p3.z))
}

/** Frame-rate independent damping: the fraction to move this frame. */
function damp(dt: number): number {
  return 1 - Math.exp(-DEATH_CAM_RESPONSE * dt)
}

/** Camera trails the ghost, looking at it from behind and above. */
function frame(at: Sample, lookAhead: Sample, dt: number): void {
  // Spherical around a point on the ghost's chest: recorded facing plus the
  // orbit the player has dialled in, lifted by the pitch. Distance and both
  // angles are independent, so pulling back does not also swing the camera
  // down the way the old fixed-height framing did.
  const back = ((at.ry + orbitYaw) * Math.PI) / 180
  const tilt = (orbitPitch * Math.PI) / 180
  const flat = Math.cos(tilt) * DEATH_CAM_DISTANCE
  const p = Vector3.create(
    at.p.x - Math.sin(back) * flat,
    at.p.y + DEATH_CAM_TARGET_HEIGHT + Math.sin(tilt) * DEATH_CAM_DISTANCE,
    at.p.z - Math.cos(back) * flat
  )
  const target = Vector3.create(lookAhead.p.x, lookAhead.p.y + DEATH_CAM_TARGET_HEIGHT, lookAhead.p.z)

  // Damp toward the ideal pose instead of snapping to it. This is the last
  // stage of the smoothing chain and the one that absorbs whatever survives
  // the other two — including the player's own mouse input, which would
  // otherwise be as steppy as their hand is.
  const k = dt > 0 ? damp(dt) : 1
  camPos = camPos ? Vector3.lerp(camPos, p, k) : p
  camAim = camAim ? Vector3.lerp(camAim, target, k) : target

  const t = Transform.getMutable(cam)
  t.position = camPos
  t.rotation = Quaternion.lookRotation(Vector3.normalize(Vector3.subtract(camAim, camPos)))
}

function showGhost(s: Sample): void {
  const t = Transform.getMutable(ghost)
  // No Y offset: an AvatarShape's origin is at its FEET, unlike the
  // centre-origin cylinder this replaced. Adding 0.9 floated it in mid-air.
  t.position = Vector3.create(s.p.x, s.p.y, s.p.z)
  // The recorded yaw is the camera's facing, and an avatar faces its own -Z;
  // 180 turns it to face the way you were walking rather than back at you.
  t.rotation = Quaternion.fromEulerDegrees(0, s.ry + 180, 0)
}

function stop(): void {
  playing = false
  // Delete unconditionally, outside the deathCamActive guard. stop() is also
  // the round-reset path, and an early return there is how a clone survives
  // into the next round.
  if (AvatarShape.has(ghost)) AvatarShape.deleteFrom(ghost)
  if (GltfContainer.has(stone)) GltfContainer.deleteFrom(stone)
  // Strike the set for the same reason: the hazards this replay fired must not
  // be left mid-swing in the live world. Self-guarding, so calling it on a path
  // where nothing was playing costs nothing.
  stageEnd()
  if (!deathCamActive) return
  deathCamActive = false
  MainCamera.getOrCreateMutable(engine.CameraEntity).virtualCameraEntity = undefined
  setCameraLockInvulnerable(false)
  // Hand the body back ONLY if it is ours to hand back. When the replay was
  // launched from the death screen the player is still dead, and killPlayer's
  // own lock has to outlive this one — respawnPlayer() is what releases it.
  // Unlocking here would let a dead player walk during the countdown, which is
  // the exact bug that lock was added to prevent.
  if (!isPlayerDead) lockBody(false)
}

/**
 * Run the replay. Takes the camera from whoever holds it and keeps taking it
 * every frame — the death-shake rig, the location-preview orbit and the win
 * sequence all claim MainCamera, and a replay the player asked for should not
 * lose to any of them.
 */
export function replayDeath(): void {
  if (!canReplayDeath()) return
  playhead = 0
  playing = true
  deathCamActive = true
  // SET THE STAGE BEFORE THE FIRST FRAME IS DRAWN. Every hazard with a cue in
  // this recording goes back to its resting pose here — pressed from the death
  // screen, the axe that killed you is usually still mid-swing.
  stageBegin()
  // The clone comes into existence here and nowhere else. Built fresh so the
  // outfit is whatever you are wearing right now.
  AvatarShape.createOrReplace(ghost, buildAvatar())
  // Open on the default shot every time, whatever the last viewing was left on.
  orbitYaw = 0
  orbitPitch = DEATH_CAM_PITCH
  camPos = null
  camAim = null
  showGhost(recording[0])
  frame(recording[0], recording[0], 0)
  // Seed the world on the same frame as the ghost, or the extras stand at their
  // live poses for one frame before the record takes them over.
  stageTick(0)
  // THE GRAVE, at the spot the record ends. Local and private — not the synced
  // headstone deathEffects raises, which other players see and which has
  // expired long before a post-respawn recap is ever pressed.
  //
  // POSITIONED NOW, RAISED LATER. Only the Transform is set here; the mesh is
  // withheld until the playhead reaches the death moment (raiseReplayStone).
  // It used to be built on this frame, which put the headstone in shot for the
  // whole run-up — the ghost walking toward its own grave, already dug. The
  // replay is a recording of the seconds BEFORE the hit; nothing that only
  // exists after the hit belongs in them.
  const end = recording[recording.length - 1]
  Transform.createOrReplace(stone, {
    position: Vector3.create(end.p.x, end.p.y, end.p.z),
    rotation: Quaternion.fromEulerDegrees(0, end.ry, 0)
  })
  if (GltfContainer.has(stone)) GltfContainer.deleteFrom(stone)
  MainCamera.getOrCreateMutable(engine.CameraEntity).virtualCameraEntity = cam
  lockBody(true)
  // NOTHING KILLS YOU WHILE YOU ARE WATCHING. The recap can now be opened from
  // the HUD chip after respawning, which would otherwise leave you standing
  // alive and killable in the middle of the house with the camera across the
  // room — a trap taking a heart off you while you review the last one. The
  // location preview guards the identical situation the identical way.
  setCameraLockInvulnerable(true)
}

/**
 * Which headstone the recap raises.
 *
 * PUSHED IN BY deathEffects, not chosen here. The live graves cycle through
 * TOMBSTONE_MODELS so consecutive deaths do not look identical, and the recap's
 * stone is standing in for one specific grave — the one this death actually
 * left. Picking TOMBSTONE_MODELS[0] every time (which is what this did) meant
 * the stone that rose in the replay was often not the stone standing outside
 * it. deathEffects already imports this module, so telling it is one-way; this
 * module asking would be a cycle.
 */
let replayStoneModel = TOMBSTONE_MODELS[0]

export function setReplayStoneModel(src: string): void {
  replayStoneModel = src
}

/**
 * Put the headstone up, once, on the frame the replay reaches the death.
 *
 * Idempotent via the has() check because it is called from a per-frame system
 * and the playhead sits past the cue for the whole tail hold.
 */
function raiseReplayStone(): void {
  if (GltfContainer.has(stone)) return
  // THE GHOST GOES AS THE STONE ARRIVES, the same swap the live world makes
  // (deathEffects hides your avatar and stands a headstone in its place). They
  // are both on the death spot, so leaving the body there would have the stone
  // grow out through it for the whole tail hold. Deleting the AvatarShape is
  // how this file hides an avatar — see the note on `ghost`; there is no
  // hidden-but-present state worth keeping for 1.4s.
  if (AvatarShape.has(ghost)) AvatarShape.deleteFrom(ghost)
  GltfContainer.createOrReplace(stone, {
    src: replayStoneModel,
    // Nothing about this is interactive and nothing may block a step: it is a
    // prop inside a cutscene, and the player's real body is standing elsewhere.
    visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
    invisibleMeshesCollisionMask: ColliderLayer.CL_NONE
  })
}

function replaySystem(dt: number): void {
  if (!playing) return
  playhead += dt
  readCameraInput()
  // The world, on the same playhead as the ghost: cues that are due go off and
  // the extras take their recorded poses. Ahead of the end check so the tail
  // hold still gets a tick — that is the second the impact actually lands in.
  stageTick(playhead)

  const total = (recording.length - 1) * SAMPLE_DT
  // THE MOMENT OF DEATH, which is a hair PAST the end of the path.
  //
  // Samples land every SAMPLE_DT and a trap can kill you between two of them,
  // so the last recorded step is up to 50ms short of the hit. That gap used to
  // be rounded away and the stone went up at `total` — fine when the world was
  // frozen behind the ghost, wrong now the killing trap swings again: the
  // headstone could replace the body two or three frames BEFORE the blade
  // reached it, which reads as the ghost dying of fright. deathOffset carries
  // the remainder so the stone rises on the frame the hit actually landed.
  const death = total + deathOffset
  if (playhead >= death + DEATH_REPLAY_TAIL_SECONDS) {
    stop()
    return
  }

  // Hold on the final frame for TAIL seconds so the moment of impact is not
  // gone the instant it arrives.
  const at = Math.min(playhead, total)
  if (playhead >= death) raiseReplayStone()
  const last = recording.length - 1
  const i = Math.min(last - 1, Math.floor(at / SAMPLE_DT))
  const f = Math.min(1, (at - i * SAMPLE_DT) / SAMPLE_DT)
  const a = recording[i]
  const b = recording[i + 1]
  // Clamped neighbours: the spline needs one sample either side, and the ends
  // of the record have none. Repeating the endpoint is what keeps the first
  // and last steps from flying off.
  const p0 = recording[Math.max(0, i - 1)].p
  const p3 = recording[Math.min(last, i + 2)].p
  const eased: Sample = {
    // REQUIRED, even though nothing downstream reads it. `t` is part of Sample
    // (it is what pins the hazard cues to the recording — see replayStage.ts),
    // and this literal is typed as a Sample, so omitting it is a compile error
    // that blocks the whole deploy. It did exactly that once. There is no tsc
    // in this environment to catch it, and none of the Python gates in tools/
    // can see a type error, so the only defence is that this comment exists.
    //
    // Interpolated rather than faked, so the value is at least honest about
    // where between the two samples the ghost currently is.
    t: a.t + (b.t - a.t) * f,
    p: spline(p0, a.p, b.p, p3, f),
    // Shortest way round, or a ghost that turns 359 degrees the wrong way.
    ry: a.ry + ((((b.ry - a.ry) % 360) + 540) % 360 - 180) * f
  }
  showGhost(eased)
  frame(eased, recording[Math.min(last, i + 4)], dt)

  const main = MainCamera.getOrCreateMutable(engine.CameraEntity)
  if (main.virtualCameraEntity !== cam) main.virtualCameraEntity = cam
  // RE-ASSERT THE FREEZE, same reason the camera is re-asserted. A replay
  // started from the death screen can still be running when the respawn
  // countdown expires, and respawnPlayer() unconditionally re-enables input —
  // without this the player starts walking mid-replay while the camera is
  // somewhere else entirely.
  const mod = InputModifier.getOrNull(engine.PlayerEntity)
  if (mod?.mode?.$case !== 'standard' || !mod.mode.standard.disableAll) lockBody(true)
}

export function initDeathCam(): void {
  cam = engine.addEntity()
  Transform.create(cam)
  VirtualCamera.create(cam, { defaultTransition: { transitionMode: VirtualCamera.Transition.Time(0.2) } })

  // Transform only. No AvatarShape until the button is pressed, so between
  // replays this entity renders nothing at all.
  ghost = engine.addEntity()
  Transform.create(ghost)

  stone = engine.addEntity()
  Transform.create(stone)

  onPlayerDeath(() => {
    if (!DEATH_CAM_ENABLED) return
    // Freeze the buffer. Copied rather than referenced — recording resumes on
    // respawn and would otherwise overwrite the thing being replayed.
    recording = smoothRecording(
      buffer.map((s) => ({ p: Vector3.create(s.p.x, s.p.y, s.p.z), ry: s.ry, t: s.t }))
    )
    if (recording.length < 2) return
    // The world's half, frozen against the same sample times. Done here rather
    // than at press time so a hazard cannot go off between the death and the
    // press and be recorded into the thing being replayed.
    stageFreeze(recording.map((s) => s.t))
    // How far past the last sample the kill actually fell. Clamped: the clock
    // stops advancing the moment you die, so the gap cannot legitimately exceed
    // one sample, and a hitched frame must not stretch the hold.
    deathOffset = Math.max(0, Math.min(SAMPLE_DT, stageNow() - recording[recording.length - 1].t))
    if (DEATH_CAM_AUTOPLAY) replayDeath()
  }, 'deathCam')

  addSafeSystem(recordSystem, 'deathReplayRecord', 80)
  addSafeSystem(replaySystem, 'deathReplaySystem')
}

/** Hand the camera back early — used when a round ends mid-replay. */
export function cancelDeathCam(): void {
  stop()
}

/** Forget the recording. Called on round reset so a new round cannot replay it. */
export function clearDeathReplay(): void {
  stop()
  recording = []
  buffer.length = 0
  stageClear()
}
