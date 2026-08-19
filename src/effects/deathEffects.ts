/**
 * DEATH EFFECTS — camera shake + bloodstains.
 *
 * On every death:
 *  - The camera snaps to a virtual camera and shakes violently for a beat
 *    (amplitude decays to zero), then control returns to the normal camera
 *    while the death screen plays out.
 *  - A blood pool decal is stamped on the floor where you died — on the
 *    floor PLANE beneath the death, not at the height the player died at, so
 *    dying on the chandelier or mid-jump doesn't leave one hanging in the
 *    air (see floorBeneath). Stains are local to you, persist across
 *    respawns as "you died here" markers, and the oldest is removed once
 *    there are more than BLOOD_MAX_STAINS.
 *
 * The shake camera is NOT parented to the player and carries no fixed
 * head-height/facing assumption — cameraShake() snapshots wherever the
 * player's REAL camera actually is the instant it's called (1st or 3rd
 * person, looking any direction) and jitters around that exact pose. It used
 * to be a fixed rig at head height inheriting the avatar's body rotation,
 * which is very often NOT the direction the player is actually looking (a
 * lightning strike could visibly snap the view to face the avatar's body,
 * and jump position if the player was in third person) — reported as "why
 * does it 180 turn / zoom" for the thunder shake specifically.
 */

import {
  engine,
  Transform,
  MainCamera,
  CameraMode,
  VirtualCamera,
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
  Schemas,
  Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { syncEntity } from '@dcl/sdk/network'
import { getPlayer } from '@dcl/sdk/players'
import {
  DEATH_SHAKE_SECONDS,
  DEATH_SHAKE_AMPLITUDE,
  BLOOD_POOL_TEXTURE,
  ELECTROCUTION_TEXTURE,
  ELECTROCUTION_SECONDS,
  ELECTROCUTION_BURST_SIZE,
  ELECTROCUTION_CAUSE,
  MODEL_SKELETON,
  SKELETON_SCALE,
  BLOOD_POOL_TEXTURES,
  BLOOD_MAX_STAINS,
  TOMBSTONE_MODELS,
  TOMBSTONE_LIFETIME_SECONDS,
  HOUSE_RECT,
  FLOOR_LEVELS_Y,
  FLOOR_SNAP_TOLERANCE,
  YARD_FLOOR_Y
} from '../config'
import { onPlayerDeath, isPlayerDead } from '../gameState'
import { playerPosition } from '../playerTracker'
import { otherPlayerIds } from '../multiplayer'
import { onRoundReset } from '../gameLoop'
import { addSafeSystem, reportFailure } from '../safeSystem'

const stains: Entity[] = []
let shakeCam: Entity
let shakeTimer = 0
// The real camera's pose at the instant cameraShake() was called — the
// shake jitters around this, not around a fixed rig position.
let shakeBasePos = Vector3.create(0, 0, 0)
let shakeBaseRot = Quaternion.Identity()
// Where the PLAYER was when the shake started. The rig follows their
// translation from here — see the note in shakeSystem on why it must.
let shakeStartPlayer = Vector3.create(0, 0, 0)

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
  hoverRefreshTimer -= dt
  if (hoverRefreshTimer > 0) return
  hoverRefreshTimer = 1

  for (const [entity, info] of engine.getEntitiesWith(TombstoneInfo)) {
    refreshTombstoneHover(entity, info.name, info.cause, info.diedAt)
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

function becomeTombstone(pos: Vector3, name: string, cause: string) {
  // THE HEADSTONE IS BACK (on request). It was pulled at one point for getting
  // in the way where players died; it returns walk-through and floor-snapped
  // (see spawnSyncedTombstone), which is what that complaint was actually
  // about — it can be looked at, and it cannot be bumped into.
  //
  // Pushed onto `tombstones` so clearTombstones() can sweep it at the round
  // reset. Deaths within a round deliberately accumulate: ROUND_HEARTS caps how
  // many can ever exist at once, and the row of them is a readable record of
  // where this run went wrong.
  tombstones.push(spawnSyncedTombstone(pos, name, cause))

  // Move the hide-avatars zone onto the death spot AND switch its modifier
  // on. excludeIds (refreshed every 0.5s while dead) carries every other
  // player, so even on a client that ignores the box bounds entirely (the
  // mobile behavior described above) the only avatar this can ever hide is
  // mine — which, while my tombstone stands in for me, is exactly right.
  const t = Transform.getMutable(hideAvatarArea)
  t.parent = undefined
  t.position = Vector3.create(pos.x, pos.y, pos.z)
  AvatarModifierArea.getMutable(hideAvatarArea).modifiers = [AvatarModifierType.AMT_HIDE_AVATARS]
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
 *   - the skeleton model standing where you were, which is the joke — the
 *     lightning X-rays you.
 *
 * Local and unsynced, like the bloodstains: this is YOUR death, and a yard full
 * of other people's flashes would read as weather rather than as a mistake you
 * made.
 */
const electros: { burst: Entity; bones: Entity; life: number }[] = []

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

  // The bones, standing in the burst. Slightly in front of the plane so the
  // billboard cannot z-fight with it.
  const bones = engine.addEntity()
  Transform.create(bones, {
    position: Vector3.create(pos.x, groundY, pos.z),
    scale: Vector3.create(SKELETON_SCALE, SKELETON_SCALE, SKELETON_SCALE)
  })
  Billboard.create(bones, { billboardMode: BillboardMode.BM_Y })
  GltfContainer.create(bones, {
    src: MODEL_SKELETON,
    // Never solid: this is a 0.9s visual on top of a corpse, and an invisible
    // collider left in the yard would be a wall nobody can see.
    visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
    invisibleMeshesCollisionMask: ColliderLayer.CL_NONE
  })

  electros.push({ burst, bones, life: ELECTROCUTION_SECONDS })
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

let shakeDuration = DEATH_SHAKE_SECONDS
let shakeAmp = DEATH_SHAKE_AMPLITUDE
let shakeNatural = false // false = violent random jitter (death), true = smooth rumble (thunder)
let shakePhase = 0

// CameraType is a `const enum` inside the SDK's generated protobuf types and is
// NOT re-exported from '@dcl/sdk/ecs', so the wire value is written out here.
// CT_FIRST_PERSON = 0, CT_THIRD_PERSON = 1, CT_CINEMATIC = 2.
const CAMERA_TYPE_THIRD_PERSON = 1
// How far behind the reported camera the rig sits when the pull-back below
// kicks in. The explorer's own third-person orbit is roughly this far back.
const THIRD_PERSON_PULLBACK = 4.0
// Horizontal distance under which the reported camera counts as sitting ON the
// avatar rather than orbiting behind it.
const HEAD_ANCHOR_TOLERANCE = 0.8

/**
 * Shake the camera. natural=true gives the storm's two-axis rumble (lightning,
 * impacts); natural=false is the violent death jitter.
 *
 * Snapshots the REAL camera's current position+rotation first and hands the
 * shake rig that exact pose before swapping to it, so the swap is visually
 * seamless — whatever the player was looking at is still what they're
 * looking at, just jittering, instead of snapping to a fixed head-height rig
 * facing the avatar's body.
 *
 * THE THIRD-PERSON PULL-BACK. This is the fix for the repeatedly-reported
 * "camera zooms to first person when it shakes".
 *
 * The rig renders from wherever we put it, and we put it wherever
 * engine.CameraEntity says the camera is. In THIRD person that report comes
 * back anchored to the avatar's head rather than out at the orbit position, so
 * handing it straight to the rig teleports the view from behind the avatar into
 * its skull — which is exactly what a zoom to first person looks like.
 *
 * Detected rather than assumed, so this can only ever fire on the broken case:
 * CameraMode has to say third person AND the reported camera has to be sitting
 * on top of the player. If a client reports the orbit position properly, the
 * distance test fails and the pose is used untouched. Pushing back along the
 * camera's own -forward keeps the view direction identical and only restores
 * the distance, which is the single thing that was lost.
 */
export function cameraShake(seconds: number, amplitude: number, natural = false) {
  shakeTimer = seconds
  shakeDuration = seconds
  shakeAmp = amplitude
  shakeNatural = natural
  shakePhase = 0

  const cam = Transform.get(engine.CameraEntity)
  shakeBaseRot = Quaternion.create(cam.rotation.x, cam.rotation.y, cam.rotation.z, cam.rotation.w)
  shakeBasePos = Vector3.create(cam.position.x, cam.position.y, cam.position.z)

  const mode = CameraMode.getOrNull(engine.CameraEntity)
  const thirdPerson = mode !== null && (mode.mode as number) === CAMERA_TYPE_THIRD_PERSON
  const headAnchored =
    Math.hypot(shakeBasePos.x - playerPosition.x, shakeBasePos.z - playerPosition.z) < HEAD_ANCHOR_TOLERANCE
  if (thirdPerson && headAnchored) {
    const forward = Vector3.rotate(Vector3.Forward(), shakeBaseRot)
    shakeBasePos = Vector3.create(
      shakeBasePos.x - forward.x * THIRD_PERSON_PULLBACK,
      shakeBasePos.y - forward.y * THIRD_PERSON_PULLBACK,
      shakeBasePos.z - forward.z * THIRD_PERSON_PULLBACK
    )
  }

  shakeStartPlayer = Vector3.create(playerPosition.x, playerPosition.y, playerPosition.z)
  const t = Transform.getMutable(shakeCam)
  t.position = shakeBasePos
  t.rotation = shakeBaseRot

  MainCamera.getOrCreateMutable(engine.CameraEntity).virtualCameraEntity = shakeCam
}

function startShake() {
  cameraShake(DEATH_SHAKE_SECONDS, DEATH_SHAKE_AMPLITUDE, false)
}

function shakeSystem(dt: number) {
  // Respawn detection: the moment isPlayerDead flips back to false,
  // clear the tombstone and un-hide the avatar.
  if (wasDead && !isPlayerDead) restoreAvatar()
  wasDead = isPlayerDead

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

  if (shakeTimer <= 0) return
  shakeTimer -= dt

  if (shakeTimer <= 0) {
    // Shake over - hand the camera back. No position reset needed: the rig
    // is inactive and gets a fresh snapshot next time cameraShake() fires.
    MainCamera.getOrCreateMutable(engine.CameraEntity).virtualCameraEntity = undefined
    return
  }

  // THE RIG TRAVELS WITH THE PLAYER. This is the real cause of the "camera
  // zooms when it shakes" report, and it was NOT the jitter axes.
  //
  // The pose is snapshotted once when the shake starts and held for the whole
  // duration — 1.6s for thunder. A player walking during a strike therefore
  // walks AWAY from their own camera, which stays nailed where they were: the
  // world slides past and everything ahead appears to pull in. A dolly, read
  // as a zoom.
  //
  // Tracking the player's own translation cancels it exactly. playerPosition
  // comes from engine.PlayerEntity, NOT from CameraEntity, which matters:
  // while the virtual camera is active the camera entity reports the rig's own
  // pose, so following that would feed back into itself and drift.
  const travel = Vector3.create(
    playerPosition.x - shakeStartPlayer.x,
    playerPosition.y - shakeStartPlayer.y,
    playerPosition.z - shakeStartPlayer.z
  )

  // Strong at first, settling to nothing.
  const amp = shakeAmp * (shakeTimer / shakeDuration)

  // NO FORWARD COMPONENT — this is why the shake used to read as a zoom.
  //
  // The offset used to be built in WORLD axes, so whichever way the player
  // happened to be facing, part of every shake ran along their view direction.
  // A 0.45m lurch toward what you're looking at is a dolly, and it was
  // reported as the camera zooming in.
  //
  // Building it from the camera's own RIGHT and UP instead confines the motion
  // to the screen plane: the view can sway and heave, but the distance to
  // everything in front of the player never changes.
  const right = Vector3.rotate(Vector3.Right(), shakeBaseRot)
  const up = Vector3.rotate(Vector3.Up(), shakeBaseRot)

  let sway: number
  let heave: number
  if (shakeNatural) {
    // SIDE TO SIDE, AND UP AND DOWN — two axes, one clean oscillation each (on
    // request). This used to be two summed sines per axis, which is a smoother
    // rumble but reads as formless shudder; a single frequency per axis is what
    // makes the direction of the motion legible.
    //
    // The two rates are deliberately unrelated (≈4.1Hz lateral against ≈2.7Hz
    // vertical) so they drift in and out of phase instead of tracing the same
    // diagonal over and over, and the vertical is the shallower of the two —
    // ground shock throws you sideways more than it lifts you.
    shakePhase += dt
    const p = shakePhase
    sway = amp * Math.sin(p * 26)
    heave = amp * 0.55 * Math.sin(p * 17)
  } else {
    sway = (Math.random() - 0.5) * 2 * amp
    heave = (Math.random() - 0.5) * 2 * amp
  }
  const offset = Vector3.create(
    right.x * sway + up.x * heave,
    right.y * sway + up.y * heave,
    right.z * sway + up.z * heave
  )
  const t = Transform.getMutable(shakeCam)
  t.position = Vector3.add(Vector3.add(shakeBasePos, travel), offset)
  t.rotation = shakeBaseRot
}

export function initDeathEffects() {
  // Shake rig: unparented — cameraShake() poses it to match the real camera
  // exactly at the moment each shake starts (see its own comment). Instant
  // transition so the swap itself never adds a visible pan/zoom on top.
  shakeCam = engine.addEntity()
  Transform.create(shakeCam)
  VirtualCamera.create(shakeCam, {
    defaultTransition: { transitionMode: VirtualCamera.Transition.Time(0) }
  })

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
      startShake()
    } catch (err) {
      reportFailure('death:shake', err instanceof Error ? err.message : String(err))
    }
  }, 'deathEffects')

  addSafeSystem(shakeSystem, 'shakeSystem')
  addSafeSystem(tombstoneSystem, 'tombstoneSystem')
  addSafeSystem(electrocutionSystem, 'electrocutionSystem')
}
