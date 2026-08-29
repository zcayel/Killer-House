/**
 * DEATH EFFECTS — bloodstains, tombstones and the electrocution flash.
 *
 * On every death a blood pool decal is stamped on the floor where you died —
 * on the floor PLANE beneath the death, not at the height the player died at,
 * so dying on the chandelier or mid-jump doesn't leave one hanging in the air
 * (see floorBeneath). Stains are local to you, persist across respawns as "you
 * died here" markers, and the oldest is removed past BLOOD_MAX_STAINS.
 *
 * THE CAMERA SHAKE LIVES IN effects/cameraShake.ts, not here.
 *
 * The version that used to be in this file snapshotted the camera's WORLD
 * position and held it for the duration, then tried to detect a head-anchored
 * third-person report using CameraMode — a renderer-written component that can
 * be absent, in which case the correction never ran and the view snapped into
 * the avatar's skull. That snap is what "the camera zooms in" was, through four
 * attempts to fix it from the motion side.
 *
 * The replacement keeps the camera glued to the player instead: it captures the
 * camera-to-player OFFSET and re-applies it to the live player position every
 * frame, so whatever the client reports is preserved exactly and there is
 * nothing to detect. Ported from New Scene 39, where it is known to work.
 */

import {
  engine,
  Transform,
  MainCamera,
  MeshRenderer,
  MeshCollider,
  ColliderLayer,
  PointerEvents,
  InputAction,
  pointerEventsSystem,
  Material,
  MaterialTransparencyMode,
  GltfContainer,
  Billboard,
  BillboardMode,
  AvatarModifierArea,
  AvatarModifierType,
  VisibilityComponent,
  Schemas,
  Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { syncEntity } from '@dcl/sdk/network'
import { getPlayer } from '@dcl/sdk/players'
import {
  BLOOD_POOL_TEXTURE,
  ELECTROCUTION_TEXTURE,
  ELECTROCUTION_SECONDS,
  ELECTROCUTION_BURST_SIZE,
  ELECTROCUTION_CAUSE,
  ELECTROCUTION_STONE_AT,
  ELECTROCUTION_SKELETON_TEXTURE,
  ELECTROCUTION_SKELETON_HEIGHT,
  BLOOD_POOL_TEXTURES,
  BLOOD_MAX_STAINS,
  TOMBSTONE_MODELS,
  TOMBSTONE_LIFETIME_SECONDS,
  HOUSE_RECT,
  FLOOR_LEVELS_Y,
  FLOOR_SNAP_TOLERANCE,
  YARD_FLOOR_Y,
  QUAKE_AMPLITUDE
} from '../config'
import { onPlayerDeath, isPlayerDead } from '../gameState'
import { playerPosition } from '../playerTracker'
import { otherPlayerIds } from '../multiplayer'
import { onRoundReset } from '../gameLoop'
import { addSafeSystem, reportFailure } from '../safeSystem'
import { deathCamActive, setReplayStoneModel } from './deathCam'
import { shakeCamera } from './cameraShake'
import { startQuake } from './quake'

const stains: Entity[] = []

// While dead, the avatar is hidden and a tombstone stands where you fell.
// The hide-avatars area is created ONCE and never deleted - deleting the
// entity mid-effect can leave the renderer stuck hiding the avatar. Instead
// it's parked far underground while alive and snapped onto the player while
// dead, so "visible again on respawn" is just moving a box.
//
// MOBILE: parking the box is NOT enough on the Godot client — live testing
// found the avatar invisible while standing alive at spawn, 50m above the
// parked box, i.e. that client applies the hide modifier whenever the
// component exists, without respecting the area's position/bounds. So the
// modifier LIST is the real on/off switch now: empty while alive (inert on
// every client, wherever the box sits), populated only while dead. Position
// parking is kept as belt-and-braces for clients that do cull by bounds.
const PARKED_POSITION = Vector3.create(8, -50, 8)

// Every tombstone from this round, kept until the round itself resets (on
// request) — a death no longer erases its own marker the moment you
// respawn; ROUND_HEARTS caps how many can ever pile up in one round anyway
// (3), so this never grows unbounded.
const tombstones: Entity[] = []
let hideAvatarArea: Entity
let wasDead = false
let tombstoneIndex = 0 // cycles through TOMBSTONE_MODELS so each death looks different
let excludeRefreshTimer = 0
let lastExcludeSignature = ''

/**
 * AvatarModifierArea.AMT_HIDE_AVATARS hides EVERY avatar physically inside
 * its box, not just a chosen target (confirmed in the SDK's own component
 * docs) — excludeIds is the only way to exempt specific players. Without
 * this, a bystander standing near a death/tombstone gets their own avatar
 * hidden too (for everyone), which is what "I can't see my avatar" turned
 * out to be during a two-device test. Keep every OTHER player excluded so
 * the zone only ever hides the dying player's own corpse-avatar.
 */
function refreshExcludeIds() {
  const ids = otherPlayerIds()
  const signature = ids.slice().sort().join(',')
  if (signature === lastExcludeSignature) return
  lastExcludeSignature = signature
  AvatarModifierArea.getMutable(hideAvatarArea).excludeIds = ids
}

// Name + cause + death-time, synced onto the tombstone itself (on request:
// hovering ANY tombstone — mine or another player's — should show whose
// grave it is and how/when they died). diedAt is real wall-clock
// (Date.now()/1000, unix seconds) rather than a local elapsed-counter
// specifically so a REMOTE viewer's "died Xs ago" is computed correctly too,
// not just for the player it happened to.
const TombstoneInfo = engine.defineComponent('spooky::tombstone-info', {
  name: Schemas.String,
  cause: Schemas.String,
  diedAt: Schemas.Int
})

// One local hover hitbox per tombstone (mine or discovered from another
// player) — the tombstone model itself carries no collider, and hover
// text/PointerEvents has to be a LOCAL component on each client anyway (it's
// never synced), so every client builds its own the first time it sees a
// given tombstone. Keyed by the synced tombstone entity.
const tombstoneHitboxes = new Map<Entity, Entity>()
let hoverRefreshTimer = 0

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/**
 * m:ss under a minute becomes plain seconds — "0:47" reads as a stopwatch,
 * "47s" reads as a warning, and this line is a warning.
 */
function formatCountdown(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s < 10 ? '0' : ''}${s}`
}

/** Wall-clock seconds. Real time, not scene time, so it stays right across pauses and for remote viewers. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/** Seconds until this grave fades, floored at 0. */
function tombstoneRemaining(diedAt: number): number {
  return Math.max(0, TOMBSTONE_LIFETIME_SECONDS - Math.max(0, nowSeconds() - diedAt))
}

function hoverTextFor(name: string, cause: string, diedAt: number): string {
  const elapsed = Math.max(0, nowSeconds() - diedAt)
  // Both halves are derived from diedAt, which is REAL wall-clock stored on the
  // synced component — so a player looking at someone else's grave sees the
  // same countdown its owner does, without anything extra being synced.
  return `${name}\n${cause}\nDied ${formatElapsed(elapsed)} ago\nFades in ${formatCountdown(tombstoneRemaining(diedAt))}`
}

/**
 * Builds (or refreshes) the local hover hitbox for one tombstone. The
 * PointerEvents helper (pointerEventsSystem.onPointerDown) always PUSHES a
 * new entry rather than replacing one — calling it again every refresh
 * would pile up duplicate entries forever, so after the first registration
 * this mutates that one entry's hoverText directly instead.
 */
function refreshTombstoneHover(entity: Entity, name: string, cause: string, diedAt: number) {
  let hitbox = tombstoneHitboxes.get(entity)
  const text = hoverTextFor(name, cause, diedAt)
  if (hitbox === undefined) {
    hitbox = engine.addEntity()
    Transform.create(hitbox, { position: Vector3.create(0, 0.9, 0), scale: Vector3.create(1, 1.8, 1), parent: entity })
    MeshCollider.setBox(hitbox, ColliderLayer.CL_POINTER)
    pointerEventsSystem.onPointerDown(
      // IA_POINTER, not IA_ANY: the hover UI prints the action's name in front
      // of the text, and IA_ANY prints the literal word "Any" — so the grave
      // read "Any <name> died here". IA_POINTER shows the ordinary click glyph
      // and matches the candle and portal prompts. Nothing happens on click
      // either way; this is a label, not an interaction.
      { entity: hitbox, opts: { button: InputAction.IA_POINTER, hoverText: text, maxDistance: 8 } },
      () => {} // hover info only — nothing happens on click
    )
    tombstoneHitboxes.set(entity, hitbox)
    return
  }
  const pe = PointerEvents.getMutableOrNull(hitbox)
  if (pe !== null && pe.pointerEvents.length > 0 && pe.pointerEvents[0].eventInfo !== undefined) {
    pe.pointerEvents[0].eventInfo.hoverText = text
  }
}

// ── THE GRAVES STEP OUT OF THE RECAP ────────────────────────────────────────
//
// A death raises its headstone the instant it happens, so by the time the death
// replay is watched — off the death screen, or off the HUD chip after
// respawning — there is already a stone standing on the spot the ghost is
// walking toward, in shot for the whole run-up. The replay is a recording of
// you ALIVE. A grave that exists only because of the ending has no business
// being in the opening, and the recap raises its own stone on the frame the
// ghost is hit (raiseReplayStone, deathCam.ts) which is the only part of the
// shot it belongs in.
//
// So every grave in the scene goes out for the length of the shot — not just
// this death's, since an earlier one from the same round is just as much a prop
// from the future as far as the recording is concerned.
//
// HIDDEN LOCALLY, and that is the whole reason this is safe. These are synced
// entities, but only the components named in their syncEntity() call are
// replicated (Transform, GltfContainer, TombstoneInfo). VisibilityComponent is
// not one of them, so nobody else's graves so much as flicker.
let gravesHidden = false

/**
 * Show or hide one grave, hover card included.
 *
 * The hitbox needs its own handling twice over: it is a separate entity (a
 * child, and VisibilityComponent does not inherit), and hiding a collider does
 * not disable it — an invisible one would still hand out a "died 12s ago" card
 * in the middle of the recap. CL_NONE is the off switch.
 */
function setGraveVisible(grave: Entity, visible: boolean) {
  VisibilityComponent.createOrReplace(grave, { visible })
  const hitbox = tombstoneHitboxes.get(grave)
  if (hitbox !== undefined) {
    MeshCollider.setBox(hitbox, visible ? ColliderLayer.CL_POINTER : ColliderLayer.CL_NONE)
  }
}

function setGravesHidden(hidden: boolean) {
  gravesHidden = hidden
  for (const [grave] of engine.getEntitiesWith(TombstoneInfo)) setGraveVisible(grave, !hidden)
}

/** Removes a grave and the local hover hitbox parented to it. */
function removeTombstone(t: Entity) {
  const hitbox = tombstoneHitboxes.get(t)
  if (hitbox !== undefined) {
    engine.removeEntity(hitbox)
    tombstoneHitboxes.delete(t)
  }
  engine.removeEntity(t)
}

/**
 * Ticks every known tombstone: refreshes its hover card and retires it once
 * TOMBSTONE_LIFETIME_SECONDS is up.
 *
 * ONE SECOND, not every frame. That is the countdown's own resolution — it is
 * displayed in whole seconds, so a faster tick would burn work to redraw
 * identical text — and it bounds how long an expired grave can linger to under
 * a second, which nobody can perceive.
 *
 * ONLY THE OWNER RETIRES A GRAVE. `tombstones` holds just the ones this client
 * created, and removing a synced entity syncs that removal — so if every client
 * expired every grave it could see, the same entity would be removed several
 * times over. Remote clients only clean up their own local hitbox, which is
 * what the second loop does: the hitbox is parented to a synced entity that can
 * disappear underneath it at any moment, and orphaned colliders would go on
 * offering hover text over an empty patch of floor.
 */
function tombstoneSystem(dt: number) {
  // Ahead of the throttle below, which only runs once a second — a beat timed
  // to the tenth cannot be driven off a one-second tick.
  if (pendingStone !== null) {
    pendingStone.wait -= dt
    if (pendingStone.wait <= 0) {
      const p = pendingStone
      pendingStone = null
      raiseTombstone(p.pos, p.name, p.cause)
    }
  }

  hoverRefreshTimer -= dt
  if (hoverRefreshTimer > 0) return
  hoverRefreshTimer = 1

  for (const [entity, info] of engine.getEntitiesWith(TombstoneInfo)) {
    refreshTombstoneHover(entity, info.name, info.cause, info.diedAt)
    // A grave that turned up mid-recap (another player just died out there), or
    // whose hover hitbox was only built on this pass, has to arrive already
    // hidden — the edge trigger in shakeSystem has been and gone.
    if (gravesHidden) setGraveVisible(entity, false)
  }

  // Mine, expired.
  for (let i = tombstones.length - 1; i >= 0; i--) {
    const t = tombstones[i]
    const info = TombstoneInfo.getOrNull(t)
    if (info === null) {
      tombstones.splice(i, 1) // already gone (round reset, or never fully built)
      continue
    }
    if (tombstoneRemaining(info.diedAt) <= 0) {
      removeTombstone(t)
      tombstones.splice(i, 1)
    }
  }

  // Anyone's, vanished — drop the hitbox we built for it. Deleting from a Map
  // while iterating it is well-defined in JS, so this needs no staging array.
  for (const [entity, hitbox] of tombstoneHitboxes) {
    if (!TombstoneInfo.has(entity)) {
      engine.removeEntity(hitbox)
      tombstoneHitboxes.delete(entity)
    }
  }
}

/**
 * A tombstone anyone in the scene can see (synced entity; its later removal
 * syncs too). Used for my own deaths and by the ghost player NPC.
 */
export function spawnSyncedTombstone(pos: Vector3, name: string, cause: string): Entity {
  const e = engine.addEntity()
  Transform.create(e, {
    // Stood on the floor UNDER the death, not at the death's own height. Dying
    // mid-air — off a landing, on the chandelier, over the fence — would
    // otherwise leave a headstone hanging in space. Same floor-level snap the
    // blood stain uses; see floorBeneath for why this isn't a raycast.
    position: Vector3.create(pos.x, floorBeneath(pos), pos.z),
    rotation: Quaternion.fromEulerDegrees(0, Math.random() * 360, 0)
  })
  // WALK-THROUGH, DELIBERATELY. This prop was removed once already for getting
  // in players' way where they died, and a solid headstone dropped on the exact
  // spot someone is about to respawn next to — potentially in a doorway, or
  // against the candle that killed them — is a hazard the scene invented for
  // itself. CL_POINTER keeps the hover text working (that is what the
  // name/cause/died-ago card is registered against) while
  // invisibleMeshesCollisionMask 0 drops the physics collider the .glb ships
  // with, so it can never block a step.
  GltfContainer.create(e, {
    src: TOMBSTONE_MODELS[tombstoneIndex],
    visibleMeshesCollisionMask: ColliderLayer.CL_POINTER,
    invisibleMeshesCollisionMask: 0
  })
  tombstoneIndex = (tombstoneIndex + 1) % TOMBSTONE_MODELS.length
  TombstoneInfo.create(e, { name, cause, diedAt: Math.floor(Date.now() / 1000) })
  syncEntity(e, [Transform.componentId, GltfContainer.componentId, TombstoneInfo.componentId])
  return e
}

/**
 * A headstone waiting on its cue. Lightning deaths hold theirs back a short
 * beat (0.3s) so the strike registers before the stone lands — the X-ray sprite
 * is still running underneath it, see ELECTROCUTION_STONE_AT.
 * Null whenever nothing is pending.
 */
let pendingStone: { pos: Vector3; name: string; cause: string; wait: number } | null = null

/**
 * Raise the headstone. Split out of becomeTombstone so it can be DEFERRED
 * without also deferring the body-hide — the avatar has to vanish on the frame
 * you die whatever else is delayed, or the electrocution sprite plays over the
 * top of your own still-standing body and the X-ray joke reads as a glitch.
 */
function raiseTombstone(pos: Vector3, name: string, cause: string) {
  // THE HEADSTONE IS BACK (on request). It was pulled at one point for getting
  // in the way where players died; it returns walk-through and floor-snapped
  // (see spawnSyncedTombstone), which is what that complaint was actually
  // about — it can be looked at, and it cannot be bumped into.
  //
  // Pushed onto `tombstones` so clearTombstones() can sweep it at the round
  // reset. Deaths within a round deliberately accumulate: ROUND_HEARTS caps how
  // many can ever exist at once, and the row of them is a readable record of
  // where this run went wrong.
  const grave = spawnSyncedTombstone(pos, name, cause)
  tombstones.push(grave)
  // TELL THE RECAP WHICH STONE THIS DEATH LEFT. The death replay raises its own
  // local headstone on the frame the ghost is hit, and the models cycle — left
  // to pick for itself it always chose the first one, so the stone that rose in
  // the replay was usually not the stone standing outside it.
  const gltf = GltfContainer.getOrNull(grave)
  if (gltf !== null) setReplayStoneModel(gltf.src)
}

function becomeTombstone(pos: Vector3, name: string, cause: string) {
  // Lightning holds the stone back a short beat; everything else raises it now.
  if (cause === ELECTROCUTION_CAUSE) {
    pendingStone = {
      pos: Vector3.create(pos.x, pos.y, pos.z),
      name,
      cause,
      wait: ELECTROCUTION_STONE_AT
    }
  } else {
    raiseTombstone(pos, name, cause)
  }

  // Move the hide-avatars zone onto the death spot AND switch its modifier
  // on. excludeIds (refreshed every 0.5s while dead) carries every other
  // player, so even on a client that ignores the box bounds entirely (the
  // mobile behavior described above) the only avatar this can ever hide is
  // mine — which, while my tombstone stands in for me, is exactly right.
  const t = Transform.getMutable(hideAvatarArea)
  t.parent = undefined
  t.position = Vector3.create(pos.x, pos.y, pos.z)
  // HOLD THE BODY WHILE THE DEATH CAM IS UP.
  //
  // Hiding the avatar the instant you die means the replay shows a trap
  // swinging through empty air with a headstone next to it — the one thing the
  // shot exists to show, your body being hit, is gone before the camera even
  // cuts. The zone is positioned now (so it lands on the right spot) but the
  // modifier is switched on by shakeSystem once the cam releases.
  if (!deathCamActive) {
    AvatarModifierArea.getMutable(hideAvatarArea).modifiers = [AvatarModifierType.AMT_HIDE_AVATARS]
  }
  refreshExcludeIds() // exclude every current player immediately — only I should vanish
}

function restoreAvatar() {
  // The tombstone itself now deliberately stays behind — see the comment on
  // `tombstones` above. Only the avatar-hide zone resets here: switch the
  // modifier off (the real un-hide) and park the box again.
  const t = Transform.getMutable(hideAvatarArea)
  t.parent = undefined
  t.position = Vector3.clone(PARKED_POSITION)
  AvatarModifierArea.getMutable(hideAvatarArea).modifiers = []
}

/** Wipes every tombstone left from this round — called on round reset, not on individual respawn. */
function clearTombstones() {
  // Drop anything still waiting on its cue, or a stone from the round that just
  // ended surfaces a second into the new one.
  pendingStone = null
  for (const t of tombstones) removeTombstone(t)
  tombstones.length = 0
}

/**
 * The floor plane underneath a death position, so a stain lands flat on the
 * ground instead of hanging in the air where the player happened to be — on
 * the chandelier mid-ride, mid-jump over the spikes, or still falling.
 *
 * REPLACED A RAYCAST THAT NEVER WORKED. The old groundedY() cast straight
 * down with raycastSystem.registerRaycast and read the result inline, which
 * looks synchronous but isn't: that call CREATES the Raycast request and
 * returns whatever RaycastResult the renderer left on the entity from a
 * previous frame (see @dcl/ecs/dist/systems/raycast.js). swingingBlade.ts
 * gets away with the same pattern because it polls every single frame; a
 * stain is cast for exactly once, at the instant of death, so it read null
 * on the first death of a session and fell back to the raw death height —
 * and on every death after that it read the leftover hit from the PREVIOUS
 * death's position, placing the stain at a floor height measured somewhere
 * else in the house. Its three-mask fallback ladder was inert too: the 2nd
 * and 3rd attempts hit `if (!raycast)` and silently reused the 1st attempt's
 * request, so the looser collision masks were never actually tried.
 *
 * Snapping to FLOOR_LEVELS_Y instead is exact, frame-independent, free, and
 * identical on mobile — see the reasoning on that constant.
 *
 * Outside the house footprint there is only the yard, however high up the
 * death happened (going over the iron fence is the usual way).
 */
function floorBeneath(pos: Vector3): number {
  const insideHouse =
    pos.x >= HOUSE_RECT.minX && pos.x <= HOUSE_RECT.maxX && pos.z >= HOUSE_RECT.minZ && pos.z <= HOUSE_RECT.maxZ

  if (insideHouse) {
    for (const level of FLOOR_LEVELS_Y) {
      if (pos.y >= level - FLOOR_SNAP_TOLERANCE) return level
    }
  }
  return YARD_FLOOR_Y
}

/** Cycles the splat designs so consecutive deaths never leave the same mark. */
let bloodDesign = 0


/**
 * THE ELECTROCUTION FLASH — a burst with a skeleton lit up inside it.
 *
 * Two pieces, both billboarded so they face you however the camera was turned
 * at the moment of death:
 *   - the star burst, scaled up from nothing and faded out;
 *   - a flat skeleton cutout standing where you were, which is the joke — the
 *     lightning X-rays you. A SPRITE, not the scene's skeleton .glb: a 0.9s
 *     flash never needs a model that holds up from every angle, and the cutout
 *     always presents the same readable pose.
 *
 * Local and unsynced, like the bloodstains: this is YOUR death, and a yard full
 * of other people's flashes would read as weather rather than as a mistake you
 * made.
 */
const electros: { burst: Entity; bones: Entity; base: Vector3; life: number }[] = []

function spawnElectrocution(pos: Vector3) {
  const groundY = floorBeneath(pos)

  const burst = engine.addEntity()
  Transform.create(burst, {
    position: Vector3.create(pos.x, groundY + 1.15, pos.z),
    scale: Vector3.create(0.2, 0.2, 0.2)
  })
  Billboard.create(burst, { billboardMode: BillboardMode.BM_Y })
  MeshRenderer.setPlane(burst)
  Material.setPbrMaterial(burst, {
    texture: Material.Texture.Common({ src: ELECTROCUTION_TEXTURE }),
    emissiveTexture: Material.Texture.Common({ src: ELECTROCUTION_TEXTURE }),
    // Emissive so it reads as a light source in a scene this dark, rather than
    // a sticker lit by whatever happens to be nearby.
    emissiveColor: Color4.create(0.55, 0.78, 1, 1),
    emissiveIntensity: 2.4,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    specularIntensity: 0,
    metallic: 0,
    roughness: 1
  })

  // The bones, standing in the burst. Same billboard, so it holds the pose
  // whatever direction you were facing when it hit.
  const base = Vector3.create(pos.x, groundY + ELECTROCUTION_SKELETON_HEIGHT * 0.5, pos.z)
  const bones = engine.addEntity()
  Transform.create(bones, {
    position: base,
    scale: Vector3.create(ELECTROCUTION_SKELETON_HEIGHT, ELECTROCUTION_SKELETON_HEIGHT, 1)
  })
  Billboard.create(bones, { billboardMode: BillboardMode.BM_Y })
  Material.setPbrMaterial(bones, {
    texture: Material.Texture.Common({ src: ELECTROCUTION_SKELETON_TEXTURE }),
    emissiveTexture: Material.Texture.Common({ src: ELECTROCUTION_SKELETON_TEXTURE }),
    // Hotter than the burst so the bones stay legible against its bright core.
    emissiveColor: Color4.create(0.82, 0.93, 1, 1),
    emissiveIntensity: 3.2,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    specularIntensity: 0,
    metallic: 0,
    roughness: 1
  })
  MeshRenderer.setPlane(bones)

  electros.push({ burst, bones, base, life: ELECTROCUTION_SECONDS })
}

/** Grows the burst and clears both pieces when the flash is spent. */
function electrocutionSystem(dt: number) {
  for (let i = electros.length - 1; i >= 0; i--) {
    const e = electros[i]
    e.life -= dt
    if (e.life <= 0) {
      engine.removeEntity(e.burst)
      engine.removeEntity(e.bones)
      electros.splice(i, 1)
      continue
    }
    // Snaps open, then eases away — an electrical flash has no wind-up.
    const t = 1 - e.life / ELECTROCUTION_SECONDS
    const spread = ELECTROCUTION_BURST_SIZE * Math.min(1, t * 4.5)
    const tr = Transform.getMutable(e.burst)
    tr.scale = Vector3.create(spread, spread, spread)

    // NUDGE THE BONES TOWARD THE CAMERA. Both planes are BM_Y billboards at the
    // same spot, so they are exactly coplanar and z-fight — the skeleton
    // flickers in and out of the burst. The 3D model this replaced had real
    // depth and never needed it. Which way "toward the camera" points changes
    // as the player turns, so it has to be recomputed rather than baked in.
    if (Transform.has(engine.CameraEntity)) {
      const c = Transform.get(engine.CameraEntity).position
      const dx = c.x - e.base.x
      const dz = c.z - e.base.z
      const len = Math.hypot(dx, dz)
      if (len > 0.001) {
        const bt = Transform.getMutable(e.bones)
        bt.position = Vector3.create(e.base.x + (dx / len) * 0.12, e.base.y, e.base.z + (dz / len) * 0.12)
      }
    }
  }
}

export function spawnBloodStain(pos: Vector3) {
  const stain = engine.addEntity()
  const yaw = Math.random() * 360
  const size = 1.2 + Math.random() * 0.9
  const groundY = floorBeneath(pos)
  Transform.create(stain, {
    // Slightly above the floor to avoid z-fighting with it
    position: Vector3.create(pos.x, groundY + 0.03, pos.z),
    // Lay the plane flat, spun by a random yaw so no two stains look alike
    rotation: Quaternion.multiply(Quaternion.fromEulerDegrees(0, yaw, 0), Quaternion.fromEulerDegrees(90, 0, 0)),
    scale: Vector3.create(size, size, 1)
  })
  bloodDesign = (bloodDesign + 1) % BLOOD_POOL_TEXTURES.length
  MeshRenderer.setPlane(stain)
  Material.setPbrMaterial(stain, {
    texture: Material.Texture.Common({ src: BLOOD_POOL_TEXTURES[bloodDesign] }),
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    specularIntensity: 0,
    metallic: 0,
    roughness: 1
  })

  // LOCAL, deliberately. These used to be synced, so every player's deaths
  // stained every player's floor. Week 2 testers reported being "affected by
  // other players' blood" — with BLOOD_MAX_STAINS per player and a house
  // this dark, a busy scene turned into someone else's crime scene, and the
  // one visual cue that's supposed to mean "YOU died here" meant nothing.
  // Your own stains are the map of your own mistakes; that only works if
  // they're all yours.

  stains.push(stain)
  if (stains.length > BLOOD_MAX_STAINS) {
    const oldest = stains.shift()
    if (oldest !== undefined) engine.removeEntity(oldest)
  }
}

function shakeSystem(dt: number) {
  // Respawn detection: the moment isPlayerDead flips back to false,
  // clear the tombstone and un-hide the avatar.
  if (wasDead && !isPlayerDead) restoreAvatar()
  wasDead = isPlayerDead

  // Graves out for the length of the recap, back the moment it ends. Edge
  // triggered, not every frame: these are component writes, and the set only
  // changes when the shot opens or closes.
  if (gravesHidden !== deathCamActive) setGravesHidden(deathCamActive)

  // The death cam has released and the body is still showing — hide it now.
  // See becomeTombstone: the zone is already parked on the death spot, this
  // only flips the modifier that does the hiding.
  if (isPlayerDead && !deathCamActive) {
    const mod = AvatarModifierArea.getMutable(hideAvatarArea)
    if (mod.modifiers.length === 0) {
      mod.modifiers = [AvatarModifierType.AMT_HIDE_AVATARS]
      refreshExcludeIds()
    }
  }

  if (isPlayerDead) {
    // THE ZONE FOLLOWS THE CORPSE. becomeTombstone drops it on the spot where
    // the player died, which was fine while nothing could move a dead player —
    // but plotBoundary.ts now pushes players back inside the fence DURING the
    // death (that's what stopped "my avatar dies but still gets out"). A dead
    // player shoved back inside walked straight out of a hide-box left behind
    // at the fence line, and reappeared standing there for everyone. Reported
    // as "I can't see the tombstone, just the avatar standing".
    //
    // Tracking the live position instead makes the zone correct for ANY reason
    // a dead player moves — the seal, a respawn teleport, or anything added
    // later — rather than only for the one that caused this.
    const t = Transform.getMutable(hideAvatarArea)
    t.position.x = playerPosition.x
    t.position.y = playerPosition.y
    t.position.z = playerPosition.z

    // Keep excludeIds current too — a bystander could wander in, or a new
    // player could join, during the respawn countdown.
    excludeRefreshTimer -= dt
    if (excludeRefreshTimer <= 0) {
      excludeRefreshTimer = 0.5
      refreshExcludeIds()
    }
  }

}

export function initDeathEffects() {
  // Permanent hide-avatars zone, parked underground until a death snaps it
  // onto the player (see becomeTombstone/restoreAvatar). Created with NO
  // modifiers — inert until a death populates the list — because the mobile
  // client applies modifiers regardless of the box's position (see the
  // PARKED_POSITION note above).
  hideAvatarArea = engine.addEntity()
  Transform.create(hideAvatarArea, { position: Vector3.clone(PARKED_POSITION) })
  AvatarModifierArea.create(hideAvatarArea, {
    area: Vector3.create(4, 4, 4),
    modifiers: [],
    excludeIds: []
  })
  // Synced so other players' clients hide my corpse-avatar too while the
  // tombstone stands in for it.
  syncEntity(hideAvatarArea, [Transform.componentId, AvatarModifierArea.componentId])

  onRoundReset(clearTombstones)

  onPlayerDeath((cause) => {
    // Independent effects, isolated: a throw in spawnBloodStain used to abort
    // this whole callback before becomeTombstone ever ran — the "avatar
    // stays visible, no tombstone" reports could be exactly that. Each gets
    // its own try/catch + reportFailure label so a device that hits this
    // shows exactly which one, in the debug HUD's FAILED row, instead of the
    // other two effects silently never happening too.
    if (cause === ELECTROCUTION_CAUSE) {
      try {
        spawnElectrocution(playerPosition)
      } catch (err) {
        reportFailure('death:electrocution', err instanceof Error ? err.message : String(err))
      }
    }
    try {
      spawnBloodStain(playerPosition)
    } catch (err) {
      reportFailure('death:bloodStain', err instanceof Error ? err.message : String(err))
    }
    try {
      becomeTombstone(playerPosition, getPlayer()?.name ?? 'A player', cause)
    } catch (err) {
      reportFailure('death:tombstone', err instanceof Error ? err.message : String(err))
    }
    try {
      // Full strength over 0.6s — the longest burst the fireball arena used,
      // reserved there for its heaviest impact, and this is the equivalent:
      // the hit that killed you. It overruns the 0.2s DEATH_SCREEN_DELAY_SECONDS
      // by a wide margin, so the screen arrives while the shake is still
      // settling — see that comment; it reads as one impact rather than two
      // events. Still never covers the flash.
      // Same fallback as the thunderclap: if the client's camera report cannot
      // be trusted, shakeCamera declines rather than snap the view into the
      // avatar, and the ground quake has to be the whole impact instead.
      if (!shakeCamera(1.0, 0.6)) startQuake(0.7, QUAKE_AMPLITUDE * 3.2)
    } catch (err) {
      reportFailure('death:shake', err instanceof Error ? err.message : String(err))
    }
  }, 'deathEffects')

  addSafeSystem(shakeSystem, 'shakeSystem')
  addSafeSystem(tombstoneSystem, 'tombstoneSystem')
  addSafeSystem(electrocutionSystem, 'electrocutionSystem')
}
