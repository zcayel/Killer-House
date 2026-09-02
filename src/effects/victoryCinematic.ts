/**
 * THE VICTORY CINEMATIC — the shot you only ever get by stepping through.
 *
 * Fired from gameLoop.ts's win(), which has exactly one caller: the portal.
 * Nothing else in this scene can win a round, so "only after it got in the
 * portal" is guaranteed by where this hooks in rather than by a flag someone
 * has to remember to check.
 *
 * WHAT HAPPENS. A heap of skulls is raised on the board's centre line, the
 * player is teleported onto its summit facing out, the camera cuts to a low
 * hero angle and then arcs out, up and around until the whole leaderboard is
 * standing behind them, and the avatar throws a celebration emote every few
 * seconds throughout. The win screen fades in over the tail of the move.
 *
 * THREE THINGS THIS FILE HAS TO TAKE OFF SOMEBODY ELSE, and why each is safe:
 *
 *   THE CAMERA. MainCamera is pointed at our own VirtualCamera and RE-ASSERTED
 *   every frame, because the location-preview orbit, the lightning shake and
 *   the death replay all claim it too. Re-asserting rather than claiming once
 *   is what stops a stray thunderclap from yanking the shot mid-arc. The two
 *   that can fire during a win now stand down instead (see the
 *   victoryCinematicActive guards in cameraShake.ts and skeletons.ts).
 *
 *   THE BODY. InputModifier disableAll, held for the whole sequence. Without
 *   it the player walks off a 1.86m pile with the camera eight metres away.
 *   disableAll stops LOCOMOTION only — scene-triggered emotes still play
 *   through it, which combat.ts has relied on for the knife slash since long
 *   before this file existed.
 *
 *   THE PLAYER'S POSITION. movePlayerTo, not a Transform write: the client owns
 *   the player Transform and rewrites it every frame, so a direct write is
 *   stomped on the same tick (gameState.ts's respawnPlayer makes the same
 *   point). The pile carries an invisible collider whose top is exactly
 *   VICTORY_STAND_HEIGHT, so the avatar lands on the heap instead of falling
 *   through it.
 *
 * IT IS LOCAL. Every entity here is built on this client alone — no syncEntity,
 * exactly like the death replay's private headstone. Other players see your
 * avatar arrive at the board and celebrate, which is the true part; they do not
 * see the pile under it. One synced pile per winner fighting for one spot is a
 * worse artefact than the one that trade buys.
 *
 * NOTHING SURVIVES THE ROUND. end() deletes every entity it made and hands the
 * camera and the body back, and gameLoop's round reset calls it unconditionally
 * — including on the "Play Again" path, which cuts the win screen short.
 */

import {
  engine,
  Transform,
  GltfContainer,
  MeshCollider,
  ColliderLayer,
  VisibilityComponent,
  MainCamera,
  VirtualCamera,
  InputModifier,
  Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { movePlayerTo, triggerEmote } from '~system/RestrictedActions'
import {
  VICTORY_CINEMATIC_ENABLED,
  VICTORY_STAGE_POSITION,
  VICTORY_PILE_RADIUS,
  VICTORY_PILE_HEIGHT,
  VICTORY_PILE_FALLOFF,
  VICTORY_PILE_SKULLS,
  VICTORY_PILE_SPREAD,
  VICTORY_PILE_CLEAR_RADIUS,
  VICTORY_SKULL_MODELS,
  VICTORY_SKULL_FACE_JITTER,
  VICTORY_SKULL_SCALE_MIN,
  VICTORY_SKULL_SCALE_MAX,
  VICTORY_SKULL_SINK,
  VICTORY_STAND_HEIGHT,
  VICTORY_STAND_RADIUS,
  VICTORY_SET_CLEAR_RADIUS,
  VICTORY_SET_CLEAR_MATCH,
  VICTORY_SET_CLEAR_ALWAYS,
  VICTORY_AVATAR_FACE_T,
  VICTORY_GRAVE_OFFSETS,
  VICTORY_GRAVE_MODEL,
  VICTORY_GRAVE_SCALE,
  VICTORY_GRAVE_YAW,
  VICTORY_SHOT,
  VICTORY_CINEMATIC_SECONDS,
  VICTORY_CINEMATIC_HOLD_SECONDS,
  VICTORY_EMOTES,
  VICTORY_EMOTE_INTERVAL,
  VICTORY_FIRST_EMOTE_DELAY
} from '../config'
import { setCameraLockInvulnerable } from '../gameState'
import { playerPosition } from '../playerTracker'
import { addSafeSystem } from '../safeSystem'
import { playSoundAt, SOUND_BONE_RATTLE } from '../sounds'

/**
 * Is the cinematic on screen right now?
 *
 * Read by cameraShake.ts (which must not fight for MainCamera), skeletons.ts
 * (whose AI stands down so nothing wanders into the shot) and ui.tsx.
 */
export let victoryCinematicActive = false

/**
 * Should the FULL win screen still be held back?
 *
 * Separate from victoryCinematicActive because the two do not end together —
 * the overlay arrives at VICTORY_CINEMATIC_HOLD_SECONDS while the camera is
 * still travelling, and the shot then plays on underneath it. gameLoop freezes
 * its reset countdown on this one, not on the other, or a win would sit on
 * screen for the cinematic AND the full WIN_RESET_SECONDS after it.
 */
export let victoryCinematicHolding = false

let cam: Entity
/** Every entity the pile is made of, in build order, so end() can strike the set. */
let pileParts: Entity[] = []
/** Kept alive for the whole session with nothing rendered — see preload(). */
let preloadParts: Entity[] = []
/**
 * Placed headstones this shot has hidden, and whether each already carried a
 * VisibilityComponent before we touched it.
 *
 * The flag is the whole point. These are main.crdt's entities, not ours, and
 * "put it back" is not the same as "make it visible" — a stone that was hidden
 * by something else before the cinematic started has to go back to hidden. Only
 * the ones this file actually created a component on get it deleted again.
 */
let struckGraves: { entity: Entity; hadComponent: boolean }[] = []
let elapsed = 0
let emoteTimer = 0
let lastEmote = -1
let ready = false
/** Last fov written to the camera component, so the shot only dirties it when it actually changes. */
let shownFov = -1
/**
 * Landing retries left, and the wait before the next one.
 *
 * THE PROBLEM THIS SOLVES. The pile's collider is created and the teleport is
 * issued on the same tick, but they do not travel the same road: entity
 * creation goes out with the frame's CRDT flush while movePlayerTo is its own
 * RPC, and nothing guarantees the renderer has the collider registered before
 * it honours the move. Lose that race once and the hero spends the whole shot
 * standing at the FOOT of the heap with their head inside it, which is the
 * worst possible failure for a frame that exists to be looked at.
 *
 * So the landing is checked rather than assumed, and re-issued if it did not
 * take. Bounded on both axes — a handful of attempts over the first second and
 * a half, never every frame — because if it has not worked by then the cause is
 * not timing and hammering movePlayerTo would only make the avatar jitter.
 */
let landRetries = 0
let landCheck = 0
/**
 * The same idea as landRetries, for the OTHER half of the teleport: did the
 * avatar actually end up facing the lens?
 *
 * THE PROBLEM. The aim, the InputModifier lock and the MainCamera hand-off all
 * go out on the same tick by three different roads — an RPC and two CRDT
 * writes — and the client applies them in whatever order it likes. Lose that
 * race and the body's rotation is set and then immediately overwritten by
 * whatever the camera change decides the avatar should be doing, which is a
 * hero standing on a pile of skulls showing the camera the back of his head
 * for the entire shot.
 *
 * So the facing, like the landing, is checked rather than assumed. Unlike the
 * landing it can be checked cheaply and exactly — the player Transform is
 * readable — so this stops the instant it is right and costs nothing on a
 * client that got it first time.
 *
 * WHY THE NUMBERS. Three attempts 0.12s apart puts the last possible re-aim at
 * 0.36s, comfortably inside VICTORY_FIRST_EMOTE_DELAY (0.45s): a movePlayerTo
 * cuts a running emote, so every retry has to be spent before the celebration
 * starts. The tolerance is loose because the aim is deliberately only a mean
 * bearing across the visible arc (see VICTORY_AVATAR_FACE_T) — this is looking
 * for a body pointing the WRONG WAY, not for a few degrees of drift.
 */
const FACE_CHECK_INTERVAL = 0.12
const FACE_TOLERANCE_DEG = 40
let faceRetries = 0
let faceCheck = 0

// ── THE PILE ───────────────────────────────────────────────────────────────

/**
 * A fixed-seed PRNG, so the heap is scattered but not RANDOM.
 *
 * Every win in a session builds the identical pile. That is on purpose: the
 * shot is composed against this exact silhouette (see the framing numbers on
 * VICTORY_SHOT in config.ts), and a heap that reshuffles itself would be a
 * different picture every time with no way to check any of them. The scatter
 * still has to LOOK unplanned, which is what the generator is for.
 *
 * mulberry32. Small, no state beyond one integer, and good enough for placing
 * skulls — this is set dressing, not a simulation.
 */
function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Height of the cone's surface at radius r from the summit. */
function coneHeight(r: number): number {
  const u = Math.min(1, r / VICTORY_PILE_RADIUS)
  return VICTORY_PILE_HEIGHT * (1 - Math.pow(u, VICTORY_PILE_FALLOFF))
}

/**
 * Raise the heap.
 *
 * Radius is drawn as R * rand^VICTORY_PILE_SPREAD, and that exponent is the one
 * number in here worth understanding. At 0.5 it is the textbook disc-uniform
 * scatter, which is correct for a disc and wrong for this: it leaves the summit
 * — the patch the hero stands on and the camera looks at — nearly bare, with
 * everything banked around the rim. At 1.0 it is a spike. The tuned value sits
 * between, and the verifier fails if a later edit empties the crown again.
 *
 * COLLIDERS ARE STRIPPED off every skull and one clean cylinder is put under
 * the lot. Sixty-odd overlapping model colliders is a surface the avatar
 * skitters across; the cylinder is a floor it stands on. Both masks are named
 * explicitly because invisibleMeshesCollisionMask defaults to CL_PHYSICS —
 * and these are not hypothetical: every one of these asset-pack GLBs really
 * does ship a box-shaped `_collider` mesh alongside its art, so without this
 * the yard would be left holding sixty invisible crates.
 */
function buildPile(): void {
  const rng = makeRng(20260828)
  const base = VICTORY_STAGE_POSITION

  // THE FLOOR FIRST, before a single skull and before the teleport, so the
  // avatar has something under it on the frame it arrives. A cylinder rather
  // than a box: the pile is round, and a box's corners would be four wedges of
  // invisible standable air sticking out of it.
  const floor = engine.addEntity()
  Transform.create(floor, {
    // A tall cylinder sunk into the ground with only its cap at standing
    // height. Sinking it means there is no underside to get caught beneath and
    // no lip to snag on the way up.
    position: Vector3.create(base.x, VICTORY_STAND_HEIGHT - 2, base.z),
    // The collider primitive is 1 unit tall and 0.5 in RADIUS, so the scale is
    // twice the radius you want: a 4m column whose top face is a
    // VICTORY_STAND_RADIUS disc sitting exactly on VICTORY_STAND_HEIGHT.
    scale: Vector3.create(VICTORY_STAND_RADIUS * 2, 4, VICTORY_STAND_RADIUS * 2)
  })
  MeshCollider.setCylinder(floor, 1, 1, ColliderLayer.CL_PHYSICS)
  pileParts.push(floor)

  for (let i = 0; i < VICTORY_PILE_SKULLS; i++) {
    const ang = rng() * Math.PI * 2
    const r =
      VICTORY_PILE_CLEAR_RADIUS +
      Math.pow(rng(), VICTORY_PILE_SPREAD) * (VICTORY_PILE_RADIUS - VICTORY_PILE_CLEAR_RADIUS)
    const scale = VICTORY_SKULL_SCALE_MIN + rng() * (VICTORY_SKULL_SCALE_MAX - VICTORY_SKULL_SCALE_MIN)
    // Sunk by a fraction of its own height, so bigger skulls bed in deeper —
    // a constant sink leaves the small ones buried and the big ones perched.
    const y = coneHeight(r) - VICTORY_SKULL_SINK * scale * 0.45

    // FACING OUT OF THE HEAP, not turned at random — see
    // VICTORY_SKULL_FACE_JITTER for why that one change is the difference
    // between a pile of skulls and a pile of stones.
    //
    // WHICH WAY A SKULL FACES WAS CHECKED, NOT ASSUMED. Both of these models
    // look down their own +Z (confirmed by rendering them head-on from the +Z
    // side); the first version of this line assumed -Z, which is the more
    // common convention, and turned all sixty-two of them to face INTO the
    // heap — every one of them presenting the back of its skull to the camera.
    // A yaw of θ sends local +Z to (sin θ, cos θ), and solving that for the
    // outward direction (cos ang, sin ang) gives the atan2 below.
    const outward = Math.atan2(Math.cos(ang), Math.sin(ang)) * (180 / Math.PI)
    const e = engine.addEntity()
    Transform.create(e, {
      position: Vector3.create(base.x + Math.cos(ang) * r, y, base.z + Math.sin(ang) * r),
      // Pitch and roll are kept well off the extremes: a skull tipped past
      // about a third of a turn is looking at the sky or the ground and its
      // face is lost either way, which undoes the yaw above.
      rotation: Quaternion.fromEulerDegrees(
        -32 + rng() * 64,
        outward + (rng() * 2 - 1) * VICTORY_SKULL_FACE_JITTER,
        -26 + rng() * 52
      ),
      scale: Vector3.create(scale, scale, scale)
    })
    GltfContainer.create(e, {
      src: VICTORY_SKULL_MODELS[Math.floor(rng() * VICTORY_SKULL_MODELS.length)],
      visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
      invisibleMeshesCollisionMask: ColliderLayer.CL_NONE
    })
    pileParts.push(e)
  }
}

/**
 * The two flanking stones — one either side of the heap, nearer the board.
 *
 * Ours, not the yard's: built here and deleted with the pile. See the note on
 * VICTORY_GRAVE_OFFSETS in config.ts for why the real graves are struck rather
 * than dragged into position.
 *
 * Colliders off. They stand for fifteen seconds in a spot players walk through
 * the rest of the time, and a solid prop that appears under someone mid-round
 * is a worse bug than a stone you can walk through for a moment.
 */
function buildGraves(): void {
  const base = VICTORY_STAGE_POSITION
  for (const off of VICTORY_GRAVE_OFFSETS) {
    const e = engine.addEntity()
    Transform.create(e, {
      position: Vector3.create(base.x + off.x, base.y + off.y, base.z + off.z),
      rotation: Quaternion.fromEulerDegrees(0, VICTORY_GRAVE_YAW, 0),
      scale: Vector3.create(VICTORY_GRAVE_SCALE, VICTORY_GRAVE_SCALE, VICTORY_GRAVE_SCALE)
    })
    GltfContainer.create(e, {
      src: VICTORY_GRAVE_MODEL,
      visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
      invisibleMeshesCollisionMask: ColliderLayer.CL_NONE
    })
    pileParts.push(e)
  }
}

/**
 * Clear the yard's own headstones out of the frame.
 *
 * Found by walking every entity that has both a GltfContainer and a Transform
 * and testing the MODEL PATH, rather than by looking names up: the names are
 * hand-typed in another program, and a renamed stone left standing in the
 * middle of the composition is exactly the sort of failure that shows up only
 * in the one shot nobody watches until a player wins.
 *
 * Skips anything this file built. The flanking stones are placed before this
 * runs and share the word "grave" in their path, so without the check the shot
 * would strike the two stones it had just set out.
 */
function strikeStandingGraves(): void {
  const base = VICTORY_STAGE_POSITION
  const ours = new Set(pileParts)
  for (const [entity, gltf, transform] of engine.getEntitiesWith(GltfContainer, Transform)) {
    if (ours.has(entity)) continue
    const src = gltf.src.toLowerCase()

    // TWO RULES, because two very different things are being cleared. The
    // headstones are small props near the stage and a radius is the right test
    // for them. The house is a 20m building whose ORIGIN is 12m away and whose
    // walls the camera sits inside — no radius on its origin describes that, so
    // it is struck on identity alone.
    const always = VICTORY_SET_CLEAR_ALWAYS.some((m) => src.includes(m.toLowerCase()))
    if (!always) {
      if (!VICTORY_SET_CLEAR_MATCH.some((m) => src.includes(m.toLowerCase()))) continue
      const p = transform.position
      if (Math.hypot(p.x - base.x, p.z - base.z) > VICTORY_SET_CLEAR_RADIUS) continue
    }

    const hadComponent = VisibilityComponent.has(entity)
    struckGraves.push({ entity, hadComponent })
    // createOrReplace, so a prop that already carried one is hidden too — and
    // restore() puts its original value back rather than assuming it was on.
    //
    // VISIBILITY ONLY, NEVER THE COLLIDERS. Hiding the house does not open it:
    // its walls and floors still stop the player, which is exactly what should
    // happen. The hero is frozen on the pile for the whole shot anyway, but a
    // round reset that landed mid-cinematic would otherwise hand back a house
    // you could walk through.
    VisibilityComponent.createOrReplace(entity, { visible: false })
  }
}

/** Put every struck prop back exactly as it was found. */
function restoreStandingGraves(): void {
  for (const { entity, hadComponent } of struckGraves) {
    // The entity may not survive to teardown — a round reset can take the
    // composite's entities with it — so every touch is guarded.
    if (!Transform.has(entity)) continue
    if (hadComponent) {
      VisibilityComponent.createOrReplace(entity, { visible: true })
    } else if (VisibilityComponent.has(entity)) {
      VisibilityComponent.deleteFrom(entity)
    }
  }
  struckGraves = []
}

/**
 * Pull the skull meshes into the client's cache at scene load.
 *
 * Without this the first win of a session raises a heap of nothing and the
 * skulls fade in over the opening seconds of the shot — the one moment in the
 * scene where a load pop is most visible, because the camera is already
 * pointed at the empty spot. One invisible instance of each model is enough:
 * the fetch and the decode are per ASSET, so every later copy is free.
 *
 * VisibilityComponent rather than deletion, because a deleted entity's asset is
 * a candidate for eviction. These two sit there, drawing nothing, all session.
 */
function preload(): void {
  for (const src of [...VICTORY_SKULL_MODELS, VICTORY_GRAVE_MODEL]) {
    const e = engine.addEntity()
    Transform.create(e, {
      // On the stage, at ground level, a hundredth of its size and hidden.
      // NOT parked far under the world, which is the obvious place for it: a
      // scene is bounds-checked against its parcels and an entity outside them
      // is a scene-wide error, not a quiet one.
      position: Vector3.create(VICTORY_STAGE_POSITION.x, 0, VICTORY_STAGE_POSITION.z),
      scale: Vector3.create(0.01, 0.01, 0.01)
    })
    GltfContainer.create(e, {
      src,
      visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
      invisibleMeshesCollisionMask: ColliderLayer.CL_NONE
    })
    VisibilityComponent.create(e, { visible: false })
    preloadParts.push(e)
  }
}

// ── THE SHOT ───────────────────────────────────────────────────────────────

/** Smoothstep — eases both ends, so the arc has no visible start or stop. */
function ease(x: number): number {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

/**
 * Where the camera is at normalised time `t`, interpolated through
 * VICTORY_SHOT. Angles are interpolated as plain numbers rather than through a
 * quaternion because the whole path stays inside a 32-degree wedge in front of
 * the board — there is no wrap to get wrong, and a straight lerp on phi is the
 * only version of this whose framing can be checked on paper.
 */
function poseAt(t: number): { pos: Vector3; aim: Vector3; fov: number } {
  const keys = VICTORY_SHOT
  let i = 0
  while (i < keys.length - 2 && t > keys[i + 1].t) i++
  const a = keys[i]
  const b = keys[i + 1]
  const span = b.t - a.t
  const f = ease(span <= 0 ? 1 : (t - a.t) / span)

  const phi = (a.phi + (b.phi - a.phi) * f) * (Math.PI / 180)
  const dist = a.dist + (b.dist - a.dist) * f
  const camY = a.camY + (b.camY - a.camY) * f
  const aimY = a.aimY + (b.aimY - a.aimY) * f
  const fov = a.fov + (b.fov - a.fov) * f

  const s = VICTORY_STAGE_POSITION
  return {
    pos: Vector3.create(s.x + Math.cos(phi) * dist, camY, s.z + Math.sin(phi) * dist),
    aim: Vector3.create(s.x, aimY, s.z),
    fov
  }
}

function placeCamera(t: number): void {
  const p = poseAt(t)
  const tr = Transform.getMutable(cam)
  tr.position = p.pos
  tr.rotation = Quaternion.lookRotation(Vector3.normalize(Vector3.subtract(p.aim, p.pos)))
  // Only when it has actually moved. getMutable dirties the component and puts
  // it on the wire, and the fov crawls from 48 to 53 across eight seconds — at
  // 30fps that is 240 messages to say what a tenth of a degree of change says.
  if (Math.abs(p.fov - shownFov) >= 0.05) {
    shownFov = p.fov
    VirtualCamera.getMutable(cam).fov = p.fov
  }
}

function lockBody(locked: boolean): void {
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({ disableAll: locked })
  })
}

/** How long to leave the avatar alone between landing checks. */
const LAND_CHECK_INTERVAL = 0.35

/**
 * Where the hero looks: at the lens, at eye height.
 *
 * AT THE LENS, not at a fixed bearing. The old aim was a hardcoded +6 on x,
 * which pointed the hero straight out of the board and left him looking past
 * the camera for the whole of the opening. This reads the camera's own path
 * instead, so the aim follows the shot if the shot is ever recut.
 */
function aimPoint(): Vector3 {
  const eye = poseAt(VICTORY_AVATAR_FACE_T).pos
  return Vector3.create(eye.x, VICTORY_STAND_HEIGHT + 1.6, eye.z)
}

/** Flat compass bearing from the stage to the lens, in degrees. */
function aimBearing(): number {
  const s = VICTORY_STAGE_POSITION
  const p = aimPoint()
  return Math.atan2(p.x - s.x, p.z - s.z) * (180 / Math.PI)
}

/**
 * Which way the avatar is ACTUALLY facing, or null if it cannot be read.
 *
 * The player Transform is written by the client and read-only to us, which is
 * the whole reason the aim has to go through movePlayerTo — but reading it is
 * free, and it is the only way to find out whether the aim took.
 */
function playerBearing(): number | null {
  if (!Transform.has(engine.PlayerEntity)) return null
  const f = Vector3.rotate(Vector3.Forward(), Transform.get(engine.PlayerEntity).rotation)
  if (Math.abs(f.x) < 1e-4 && Math.abs(f.z) < 1e-4) return null
  return Math.atan2(f.x, f.z) * (180 / Math.PI)
}

/** Smallest angle between two bearings, 0..180. */
function bearingError(a: number, b: number): number {
  let d = (a - b) % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return Math.abs(d)
}

/**
 * Put the hero on the summit, facing the camera.
 *
 * NO cameraTarget — and its absence is the fix for a hero who spent the whole
 * shot with his back to the lens, staring at the leaderboard.
 *
 * ADR-257 (the proposal that added avatarTarget) is explicit that in third
 * person "the camera and the avatar rotation are two separate things", and
 * says you will usually want to set both fields to the same point. That advice
 * is for a scene whose camera the player still owns. It is wrong here: this
 * shot asserts its own VirtualCamera every frame for the whole sequence, so a
 * cameraTarget cannot move anything the player sees — it can only give the
 * client a second, competing opinion about which way the body should point,
 * and the observed result on a live build was the body ending up facing
 * exactly opposite the point both fields named.
 *
 * Nothing is lost by dropping it. The view the player is handed back is set by
 * resetRound()'s own movePlayerTo, which fires immediately after
 * endVictoryCinematic() on every path out of a win.
 */
function standOnPile(): void {
  const s = VICTORY_STAGE_POSITION
  movePlayerTo({
    newRelativePosition: Vector3.create(s.x, VICTORY_STAND_HEIGHT, s.z),
    avatarTarget: aimPoint()
  }).catch((err) => {
    console.error('victory movePlayerTo failed:', err)
  })
}

/** Fire a celebration emote, never the same one twice running. */
function celebrate(): void {
  if (VICTORY_EMOTES.length === 0) return
  let i = lastEmote
  if (VICTORY_EMOTES.length > 1) {
    while (i === lastEmote) i = Math.floor(Math.random() * VICTORY_EMOTES.length)
  } else {
    i = 0
  }
  lastEmote = i
  triggerEmote({ predefinedEmote: VICTORY_EMOTES[i] }).catch((err) => {
    // Not fatal and not worth a toast: the shot is still a hero on a pile of
    // skulls in front of the board, just a still one.
    console.error('victory emote failed:', err)
  })
}

// ── PUBLIC ─────────────────────────────────────────────────────────────────

/**
 * Take the stage. Called from win() and nowhere else.
 *
 * ORDER MATTERS on this first frame, and each step is here rather than one
 * line later for a reason: the pile (and its collider) exists before the
 * player is moved onto it; the camera is posed before MainCamera is pointed at
 * it, so there is no frame of the rig's default transform; and the teleport is
 * issued last, once there is something under it and something looking at it.
 */
export function startVictoryCinematic(): void {
  if (!VICTORY_CINEMATIC_ENABLED || !ready || victoryCinematicActive) return

  elapsed = 0
  emoteTimer = VICTORY_FIRST_EMOTE_DELAY
  lastEmote = -1

  buildPile()
  // ORDER MATTERS. The flanking stones go up BEFORE the yard's own are struck,
  // because strikeStandingGraves() skips anything already in pileParts — build
  // them after and the shot would hide the two it had just set out.
  buildGraves()
  strikeStandingGraves()
  placeCamera(0)
  MainCamera.getOrCreateMutable(engine.CameraEntity).virtualCameraEntity = cam
  lockBody(true)
  // Belt and braces over win()'s own setQuestInvulnerable: this is the flag
  // every hazard already checks for "the camera is off the player", and the
  // player is standing in the middle of the yard unable to move or see
  // themselves for the whole sequence.
  setCameraLockInvulnerable(true)
  victoryCinematicActive = true
  victoryCinematicHolding = true

  landRetries = 4
  landCheck = LAND_CHECK_INTERVAL
  faceRetries = 3
  faceCheck = FACE_CHECK_INTERVAL
  standOnPile()

  // The heap landing. Positional at the pile rather than global: this one is
  // scenery, unlike the win fanfare gameLoop plays scene-wide on the same
  // frame, and two global sounds at once is just loud.
  const stage = VICTORY_STAGE_POSITION
  playSoundAt(SOUND_BONE_RATTLE, Vector3.create(stage.x, VICTORY_STAND_HEIGHT, stage.z), 1)
}

/**
 * Strike the set. Called from gameLoop's round reset — including the "Play
 * Again" path, which can arrive at any point in the sequence.
 *
 * Everything is unconditional and self-guarding: this is also the safety net
 * for a cinematic that somehow never started, and an early return here is how a
 * pile of skulls survives into the next round.
 */
export function endVictoryCinematic(): void {
  for (const e of pileParts) engine.removeEntity(e)
  pileParts = []
  // Before the active guard, like the deletion above: this touches entities
  // that are NOT ours, and a yard left with three invisible headstones in it is
  // the one piece of damage this file could do that outlives the round.
  restoreStandingGraves()
  if (!victoryCinematicActive) return
  victoryCinematicActive = false
  victoryCinematicHolding = false
  landRetries = 0
  faceRetries = 0
  // Or the next win opens on the last win's field of view: placeCamera writes
  // the component only when the value CHANGES, and a stale cache says 53 is
  // already on screen when the rig has just been handed back at whatever the
  // previous shot left it on.
  shownFov = -1
  MainCamera.getOrCreateMutable(engine.CameraEntity).virtualCameraEntity = undefined
  setCameraLockInvulnerable(false)
  // AND THE BODY, which nothing else will do. resetRound() teleports the
  // player back to the gate but never touches InputModifier — it has never had
  // to, because until this file existed nothing locked the body on a WIN. Leave
  // it out and the reward for escaping is a permanently frozen avatar on the
  // next round. (Falling for the fraction of a frame between the pile being
  // deleted here and resetRound's own movePlayerTo does not matter; nothing
  // reads the player's position in between, and they are landing at the gate
  // either way.)
  lockBody(false)
}

function victorySystem(dt: number): void {
  if (!victoryCinematicActive) return

  elapsed += dt
  // The camera reaches the last keyframe and STAYS there. The win screen is up
  // by then and the frame behind it is a held wide shot rather than a camera
  // that stopped moving and then let go.
  placeCamera(Math.min(1, elapsed / VICTORY_CINEMATIC_SECONDS))

  if (elapsed >= VICTORY_CINEMATIC_HOLD_SECONDS) victoryCinematicHolding = false

  // DID THE LANDING TAKE? See landRetries. The tolerance is deliberately loose
  // — a third of a metre — so this only fires when the avatar is genuinely on
  // the ground rather than settling the last few centimetres onto the collider,
  // and the horizontal check catches a move that was refused outright as well
  // as one that fell through.
  // One re-issue per frame at most: the landing check and the facing check
  // below can both come due on the same tick, and firing two teleports into
  // the same spot on one frame is how you get an avatar that stutters in a
  // shot whose entire job is to be looked at.
  let reIssued = false

  if (landRetries > 0) {
    landCheck -= dt
    if (landCheck <= 0) {
      landCheck = LAND_CHECK_INTERVAL
      const s = VICTORY_STAGE_POSITION
      const offGround = playerPosition.y < VICTORY_STAND_HEIGHT - 0.35
      const offMark = Math.abs(playerPosition.x - s.x) > 0.6 || Math.abs(playerPosition.z - s.z) > 0.6
      if (offGround || offMark) {
        landRetries--
        standOnPile()
        reIssued = true
      } else {
        landRetries = 0
      }
    }
  }

  // DID THE TURN TAKE? See faceRetries.
  if (faceRetries > 0) {
    faceCheck -= dt
    if (faceCheck <= 0) {
      faceCheck = FACE_CHECK_INTERVAL
      const facing = playerBearing()
      if (facing !== null && bearingError(facing, aimBearing()) <= FACE_TOLERANCE_DEG) {
        faceRetries = 0
      } else if (!reIssued) {
        faceRetries--
        standOnPile()
        // Said once, on the last attempt, and only when it never worked: if
        // this line ever appears the cause is not a lost race and no number of
        // retries will help — the client is holding the avatar's rotation
        // itself, and the shot needs recutting rather than re-aiming.
        if (faceRetries === 0) {
          console.log('victory: avatar facing never took — bearing', facing, 'wanted', aimBearing())
        }
      }
    }
  }

  emoteTimer -= dt
  if (emoteTimer <= 0) {
    emoteTimer = VICTORY_EMOTE_INTERVAL
    celebrate()
  }

  // RE-ASSERT, every frame, both of them. The lightning shake and the location
  // preview both write MainCamera and InputModifier without asking who had them
  // — this is the same defence the death replay runs for the same reason, and
  // without it a thunderclap during the win takes the shot away and hands back
  // a camera pointed at wherever the player's own view had drifted to.
  const main = MainCamera.getOrCreateMutable(engine.CameraEntity)
  if (main.virtualCameraEntity !== cam) main.virtualCameraEntity = cam
  const mod = InputModifier.getOrNull(engine.PlayerEntity)
  if (mod?.mode?.$case !== 'standard' || !mod.mode.standard.disableAll) lockBody(true)
}

export function initVictoryCinematic(): void {
  cam = engine.addEntity()
  Transform.create(cam)
  // No defaultTransition: the arrival is a CUT. A win is the one moment in this
  // scene that should land like an edit rather than glide, and the portal has
  // just moved the player 18m across the yard — a camera that flies there
  // instead of cutting spends the first second of the payoff looking at grass.
  VirtualCamera.create(cam, {})

  if (VICTORY_CINEMATIC_ENABLED) preload()

  addSafeSystem(victorySystem, 'victoryCinematic')
  // Last line on purpose. startVictoryCinematic() refuses to run until this is
  // set, so a throw anywhere above leaves the win screen behaving exactly as it
  // did before this file existed rather than half-staging a cinematic with no
  // camera entity to point at. safeInit (index.ts) catches that throw.
  ready = true
}
