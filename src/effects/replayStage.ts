/**
 * THE REPLAY STAGE — the WORLD's half of the death replay.
 *
 * deathCam.ts records YOU. This file records everything that was trying to kill
 * you, and puts it all back on its marks when the replay runs, so the recap
 * shows the axe coming down on the ghost rather than a ghost dying of nothing.
 *
 * Hazards here move in two fundamentally different ways, so there are two
 * fundamentally different ways of getting them back.
 *
 * CUES — for anything driven by a baked GLB clip or a fixed timer.
 *
 * A swinging axe does not move its entity at all: the blade travels INSIDE the
 * model, on an animation this scene can only start, stop and set the speed of.
 * SDK7 offers no way to scrub a clip to an arbitrary time, so a frame-by-frame
 * recording of an axe is impossible and always will be. What is possible is
 * exact anyway, because the clip is DETERMINISTIC from its first frame: record
 * the moment the trap fired, fire it again at the same moment of the replay,
 * and the swing that plays is the swing that killed you, frame for frame. The
 * wall spikes and the lightning are the same shape of thing — a fixed sequence
 * off a timer once something starts it.
 *
 * EXTRAS — for anything this scene moves itself.
 *
 * A skeleton's Transform is written by our own code every frame, so its pose
 * can just be sampled alongside the player's and played straight back. That is
 * a true recording rather than a reconstruction, and it holds no matter what
 * the skeleton was doing or why.
 *
 * WHAT IS STILL NOT REWOUND, stated plainly because it is the one hole left.
 * The chandelier is a Creator Hub smart item riding a core::Tween. The tween
 * owns its Transform and rewrites it every frame, so it can be neither a cue
 * (nothing here starts it) nor an extra (our writes would be stomped, and it is
 * a synced entity besides). It keeps running live through a replay on its own
 * 7-second loop. Every other hazard in the scene is covered.
 *
 * THE CLOCK LIVES HERE, and deathCam drives it. One clock stamps both the
 * hazard cues and the player samples, which is what lets a cue be converted
 * into a position on the replay's own timeline. deathCam owns the sampling
 * cadence, so it calls stageAdvance/stageSample rather than this file running a
 * system of its own — two independent clocks at the same nominal rate would
 * drift apart by a frame and put the axe a frame off the body it hit.
 */

import { Transform, Entity } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { DEATH_REPLAY_SECONDS, DEATH_REPLAY_SAMPLE_HZ } from '../config'
import { isPlayerDead } from '../gameState'

const SAMPLE_DT = 1 / DEATH_REPLAY_SAMPLE_HZ
const MAX_SAMPLES = Math.ceil(DEATH_REPLAY_SECONDS * DEATH_REPLAY_SAMPLE_HZ)

/**
 * A hazard that can be struck back to its resting pose and made to perform
 * again on demand.
 *
 * `reset` has to be safe to call at ANY point in the hazard's cycle — the
 * replay is most often opened from the death screen, seconds after the kill,
 * with the thing that did it still mid-swing.
 *
 * `payload` is a small integer the hazard chooses the meaning of. Most ignore
 * it; lightning uses it to say WHICH strike, since the bolts land on points
 * picked at random and a recap has to use the same ones.
 */
export interface ReplayActor {
  reset: () => void
  fire: (payload: number) => void
}

const actors = new Map<string, ReplayActor>()

export function registerReplayActor(key: string, actor: ReplayActor): void {
  actors.set(key, actor)
}

/**
 * For an extra whose Transform does not say everything it is doing.
 *
 * A skeleton's clip is chosen by its AI, and the AI is stood down while the
 * recap runs — without this, one that was sprinting at you five seconds ago
 * gets puppeted along its recorded path in whatever pose it happened to settle
 * into afterwards, sliding across the yard with its feet still.
 *
 * `read` is sampled with the pose. `apply` is called on playback only when the
 * recorded clip CHANGES, because issuing a clip restarts it from frame 0 and
 * doing that every frame is a skeleton twitching on its first frame forever.
 */
export interface ExtraAnim {
  read: () => string
  apply: (clip: string) => void
}

interface Extra {
  entity: Entity
  anim: ExtraAnim | null
  /** Last clip apply() was given this playback; '' forces the next one through. */
  showing: string
}

/** Things whose pose is sampled alongside the player's and played straight back. */
const extras: Extra[] = []

export function registerReplayExtra(entity: Entity, anim: ExtraAnim | null = null): void {
  extras.push({ entity, anim, showing: '' })
}

interface Pose {
  p: Vector3
  r: Quaternion
  /** The clip it was playing, or '' for an extra that does not report one. */
  a: string
}

interface Cue {
  key: string
  payload: number
  /** Stage-clock time it happened; rewritten to replay time by stageFreeze. */
  at: number
}

/** The rolling record, trimmed to the same window deathCam's buffer keeps. */
const liveCues: Cue[] = []
const liveTrack: Pose[][] = []

/**
 * Where each extra actually was when the recap took the stage.
 *
 * A recap can be watched from the HUD chip minutes after the death, while the
 * player is alive and standing somewhere else entirely. Puppeting a skeleton
 * through five seconds of the past and then just letting go would LEAVE it
 * wherever the recording ended — so watching a replay would physically
 * teleport every skeleton in the scene back to where it stood at the moment of
 * a death that is long over, possibly right on top of a player who was safe.
 * Nothing about looking at a recording should move the live world.
 *
 * Actors are put back to REST rather than to where they were, and the
 * difference is not an inconsistency: an extra has a pose that can be written
 * back exactly, while a trap mid-clip does not — SDK7 cannot seek an animation,
 * so "where it was" is not a state that can be restored, and rest is the only
 * honest place to leave it (it is also the only safe one — see stageEnd).
 */
let held: Pose[] = []

/** This extra's pose and clip, right now. Shared by the recorder and stageBegin. */
function poseOf(x: Extra): Pose {
  const t = Transform.getOrNull(x.entity)
  const a = x.anim === null ? '' : x.anim.read()
  // Copied out component by component, not held by reference: the Transform is
  // rewritten in place every frame, so a reference would leave the whole track
  // pointing at wherever the thing ended up. (Quaternion has no clone() in this
  // SDK — Vector3 does, Quaternion does not.)
  if (t === null) return { p: Vector3.create(0, -100, 0), r: Quaternion.Identity(), a }
  return {
    p: Vector3.create(t.position.x, t.position.y, t.position.z),
    r: Quaternion.create(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w),
    a
  }
}

/** Frozen at the moment of death — what the replay actually performs. */
let cues: Cue[] = []
let fired: boolean[] = []
let track: Pose[][] = []

let stageClock = 0
let playing = false

/** True while the replay is driving the world, so the live systems stand down. */
export function replayIsPlaying(): boolean {
  return playing
}

/** The shared record clock. deathCam stamps its own samples with this. */
export function stageNow(): number {
  return stageClock
}

export function stageAdvance(dt: number): void {
  stageClock += dt
}

/**
 * "This hazard just went off." Called by the hazard itself, at the instant it
 * commits — not when it becomes lethal, and not when it finishes.
 *
 * Silent while dead or replaying. A cue landing after the record was frozen
 * would be stamped past its last sample and get pulled back onto the moment of
 * death; a cue from the replay's own re-fired trap would record the recap into
 * the next recap.
 */
export function recordHazardEvent(key: string, payload = 0): void {
  if (isPlayerDead || playing) return
  liveCues.push({ key, payload, at: stageClock })
  // Age out anything the window no longer reaches. Cheap: this list holds a
  // handful of entries at most, since a trap cycle is seconds long.
  const oldest = stageClock - DEATH_REPLAY_SECONDS
  while (liveCues.length > 0 && liveCues[0].at < oldest) liveCues.shift()
}

/**
 * One frame of the extras track. Called by deathCam's recorder immediately
 * after it pushes a player sample, so the two arrays are index-aligned by
 * construction rather than by both being "about 20Hz".
 */
export function stageSample(): void {
  const frame: Pose[] = []
  for (const x of extras) frame.push(poseOf(x))
  liveTrack.push(frame)
  if (liveTrack.length > MAX_SAMPLES) liveTrack.shift()
}

/** Drop the rolling record. Paired with deathCam's buffer wipe on respawn. */
export function stageWipe(): void {
  liveCues.length = 0
  liveTrack.length = 0
}

/**
 * Where on the replay's timeline a stage-clock moment falls.
 *
 * Playback runs off sample INDEX times SAMPLE_DT, while cues are stamped in
 * wall time, and the two are only nominally the same rate — the sampler carries
 * its remainder and clamps after a hitch, so a long frame leaves them a few
 * milliseconds apart. Walking the sample timestamps converts one to the other
 * exactly instead of assuming they agree.
 *
 * Returns null for a cue older than the window: a trap that fired before the
 * record starts cannot be shown starting inside it, and the honest thing is to
 * leave it out rather than replay a swing that begins in the wrong place. The
 * killing blow is never one of these — every hazard here goes from firing to
 * lethal in under a second, and the record ends on the death.
 */
function replayTimeOf(at: number, sampleTimes: number[]): number | null {
  const n = sampleTimes.length
  if (n < 2) return null
  if (at < sampleTimes[0]) return null
  for (let i = 0; i < n - 1; i++) {
    if (at < sampleTimes[i + 1]) {
      const span = sampleTimes[i + 1] - sampleTimes[i]
      const f = span > 0 ? (at - sampleTimes[i]) / span : 0
      return (i + f) * SAMPLE_DT
    }
  }
  // Past the last sample: the sliver between the final sample and the kill.
  // That is the moment of death, which is where the replay ends.
  return (n - 1) * SAMPLE_DT
}

/**
 * Freeze the record. Handed deathCam's sample timestamps so every cue can be
 * rewritten from wall time into replay time once, here, rather than being
 * converted over and over during playback.
 */
export function stageFreeze(sampleTimes: number[]): void {
  cues = []
  for (const c of liveCues) {
    const t = replayTimeOf(c.at, sampleTimes)
    if (t === null) continue
    cues.push({ key: c.key, payload: c.payload, at: t })
  }
  fired = cues.map(() => false)
  // Copied, not referenced: recording resumes on respawn and the ring would
  // otherwise shift frames out from under the thing being replayed. The pose
  // objects themselves are written once and never mutated, so a shallow copy
  // is enough.
  track = liveTrack.slice()
}

/**
 * Take the stage. Everything with a cue in this recording is struck back to its
 * resting pose so the replay opens on a still world — the axe that killed you
 * is very often still mid-swing when the death screen's button is pressed.
 */
export function stageBegin(): void {
  playing = true
  for (let i = 0; i < cues.length; i++) fired[i] = false
  // Forget what each extra was last shown. The AI has had the intervening
  // seconds to change the clip, so the first tick has to re-assert it.
  for (const x of extras) x.showing = ''
  // And remember where they are, so handing back puts them there. See `held`.
  held = extras.map(poseOf)
  const done = new Set<string>()
  for (const c of cues) {
    if (done.has(c.key)) continue
    done.add(c.key)
    actors.get(c.key)?.reset()
  }
}

/** Fire whatever is due and pose the extras. Driven by the replay's playhead. */
export function stageTick(playhead: number): void {
  for (let i = 0; i < cues.length; i++) {
    if (fired[i] || playhead < cues[i].at) continue
    fired[i] = true
    actors.get(cues[i].key)?.fire(cues[i].payload)
  }
  poseExtras(playhead)
}

function poseExtras(playhead: number): void {
  const n = track.length
  if (n < 2 || extras.length === 0) return
  const last = n - 1
  const at = Math.min(playhead, last * SAMPLE_DT)
  const i = Math.min(last - 1, Math.floor(at / SAMPLE_DT))
  const f = Math.min(1, Math.max(0, (at - i * SAMPLE_DT) / SAMPLE_DT))
  const a = track[i]
  const b = track[i + 1]
  for (let k = 0; k < extras.length; k++) {
    // A track recorded before an extra was registered is short — skip rather
    // than crash. Only reachable if something registers after the first sample.
    if (k >= a.length || k >= b.length) continue
    const x = extras[k]
    const t = Transform.getMutableOrNull(x.entity)
    if (t === null) continue
    t.position = Vector3.lerp(a[k].p, b[k].p, f)
    t.rotation = Quaternion.slerp(a[k].r, b[k].r, f)
    // The clip of the sample we are IN, not interpolated — there is no halfway
    // between 'run' and 'idle'. Only on a change; see ExtraAnim.
    if (x.anim !== null && a[k].a !== x.showing) {
      x.showing = a[k].a
      if (a[k].a !== '') x.anim.apply(a[k].a)
    }
  }
}

/**
 * Strike the stage.
 *
 * The actors that performed are reset rather than left to run down on their
 * own. A recap can be opened from the HUD chip while you are alive and standing
 * somewhere in the house, and NOTHING KILLS YOU WHILE YOU ARE WATCHING only
 * holds for as long as the camera does — an axe left mid-swing by the recap
 * would be a live hazard again the frame the shot ends, in a place the player
 * never triggered it. Resetting makes that impossible by construction.
 */
export function stageEnd(): void {
  if (!playing) return
  playing = false

  // Put the extras back exactly where the recap found them, before their own
  // systems wake up and carry on from wherever the recording left them.
  for (let k = 0; k < extras.length && k < held.length; k++) {
    const x = extras[k]
    const t = Transform.getMutableOrNull(x.entity)
    if (t === null) continue
    t.position = Vector3.create(held[k].p.x, held[k].p.y, held[k].p.z)
    t.rotation = Quaternion.create(held[k].r.x, held[k].r.y, held[k].r.z, held[k].r.w)
    if (x.anim !== null && held[k].a !== '') x.anim.apply(held[k].a)
    x.showing = ''
  }
  held = []

  const done = new Set<string>()
  for (let i = 0; i < cues.length; i++) {
    if (!fired[i] || done.has(cues[i].key)) continue
    done.add(cues[i].key)
    actors.get(cues[i].key)?.reset()
  }
}

/** Forget the performance. Called on round reset, with deathCam's own clear. */
export function stageClear(): void {
  stageEnd()
  cues = []
  fired = []
  track = []
  stageWipe()
}
