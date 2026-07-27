/**
 * DEATH EFFECTS — camera shake + bloodstains.
 *
 * On every death:
 *  - The camera snaps to a virtual camera and shakes violently for a beat
 *    (amplitude decays to zero), then control returns to the normal camera
 *    while the death screen plays out.
 *  - A blood pool decal is stamped on the floor where you died. Stains
 *    persist across respawns as "you died here" markers; the oldest is
 *    removed once there are more than BLOOD_MAX_STAINS.
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
  AvatarModifierArea,
  AvatarModifierType,
  Schemas,
  Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { syncEntity } from '@dcl/sdk/network'
import { DEATH_SHAKE_SECONDS, DEATH_SHAKE_AMPLITUDE, BLOOD_POOL_TEXTURE, BLOOD_MAX_STAINS, TOMBSTONE_MODELS } from '../config'
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

// Cause + death-time, synced onto the tombstone itself (on request: hovering
// ANY tombstone — mine or another player's — should show how/when they
// died). diedAt is real wall-clock (Date.now()/1000, unix seconds) rather
// than a local elapsed-counter specifically so a REMOTE viewer's "died Xs
// ago" is computed correctly too, not just for the player it happened to.
const TombstoneInfo = engine.defineComponent('spooky::tombstone-info', {
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

function hoverTextFor(cause: string, diedAt: number): string {
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - diedAt)
  return `${cause}\nDied ${formatElapsed(elapsed)} ago`
}

/**
 * Builds (or refreshes) the local hover hitbox for one tombstone. The
 * PointerEvents helper (pointerEventsSystem.onPointerDown) always PUSHES a
 * new entry rather than replacing one — calling it again every refresh
 * would pile up duplicate entries forever, so after the first registration
 * this mutates that one entry's hoverText directly instead.
 */
function refreshTombstoneHover(entity: Entity, cause: string, diedAt: number) {
  let hitbox = tombstoneHitboxes.get(entity)
  const text = hoverTextFor(cause, diedAt)
  if (hitbox === undefined) {
    hitbox = engine.addEntity()
    Transform.create(hitbox, { position: Vector3.create(0, 0.9, 0), scale: Vector3.create(1, 1.8, 1), parent: entity })
    MeshCollider.setBox(hitbox, ColliderLayer.CL_POINTER)
    pointerEventsSystem.onPointerDown(
      { entity: hitbox, opts: { button: InputAction.IA_ANY, hoverText: text, maxDistance: 8 } },
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

/** Keeps every known tombstone's hover text current — mine and every other player's. Called periodically, not every frame (a "died Xs ago" doesn't need to be sub-second accurate). */
function tombstoneHoverSystem(dt: number) {
  hoverRefreshTimer -= dt
  if (hoverRefreshTimer > 0) return
  hoverRefreshTimer = 1
  for (const [entity, info] of engine.getEntitiesWith(TombstoneInfo)) {
    refreshTombstoneHover(entity, info.cause, info.diedAt)
  }
}

/**
 * A tombstone anyone in the scene can see (synced entity; its later removal
 * syncs too). Used for my own deaths and by the ghost player NPC.
 */
export function spawnSyncedTombstone(pos: Vector3, cause: string): Entity {
  const e = engine.addEntity()
  Transform.create(e, {
    position: Vector3.create(pos.x, pos.y, pos.z),
    rotation: Quaternion.fromEulerDegrees(0, Math.random() * 360, 0)
  })
  GltfContainer.create(e, { src: TOMBSTONE_MODELS[tombstoneIndex] })
  tombstoneIndex = (tombstoneIndex + 1) % TOMBSTONE_MODELS.length
  TombstoneInfo.create(e, { cause, diedAt: Math.floor(Date.now() / 1000) })
  syncEntity(e, [Transform.componentId, GltfContainer.componentId, TombstoneInfo.componentId])
  return e
}

function becomeTombstone(pos: Vector3, cause: string) {
  tombstones.push(spawnSyncedTombstone(pos, cause))

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
  for (const t of tombstones) {
    const hitbox = tombstoneHitboxes.get(t)
    if (hitbox !== undefined) {
      engine.removeEntity(hitbox)
      tombstoneHitboxes.delete(t)
    }
    engine.removeEntity(t)
  }
  tombstones.length = 0
}

export function spawnBloodStain(pos: Vector3) {
  const stain = engine.addEntity()
  const yaw = Math.random() * 360
  const size = 1.2 + Math.random() * 0.9
  Transform.create(stain, {
    // Slightly above the floor to avoid z-fighting with it
    position: Vector3.create(pos.x, pos.y + 0.03, pos.z),
    // Lay the plane flat, spun by a random yaw so no two stains look alike
    rotation: Quaternion.multiply(Quaternion.fromEulerDegrees(0, yaw, 0), Quaternion.fromEulerDegrees(90, 0, 0)),
    scale: Vector3.create(size, size, 1)
  })
  MeshRenderer.setPlane(stain)
  Material.setPbrMaterial(stain, {
    texture: Material.Texture.Common({ src: BLOOD_POOL_TEXTURE }),
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    specularIntensity: 0,
    metallic: 0,
    roughness: 1
  })

  // Synced: my blood stains show on everyone's floor (and my trim of the
  // oldest stain removes it everywhere).
  syncEntity(stain, [Transform.componentId, MeshRenderer.componentId, Material.componentId])

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

/**
 * Shake the camera. natural=true gives a smooth layered-sine rumble
 * (lightning, impacts); natural=false is the violent death jitter.
 *
 * Snapshots the REAL camera's current position+rotation first and hands the
 * shake rig that exact pose before swapping to it, so the swap is visually
 * seamless — whatever the player was looking at is still what they're
 * looking at, just jittering, instead of snapping to a fixed head-height rig
 * facing the avatar's body.
 */
export function cameraShake(seconds: number, amplitude: number, natural = false) {
  shakeTimer = seconds
  shakeDuration = seconds
  shakeAmp = amplitude
  shakeNatural = natural
  shakePhase = 0

  const cam = Transform.get(engine.CameraEntity)
  shakeBasePos = Vector3.create(cam.position.x, cam.position.y, cam.position.z)
  shakeBaseRot = Quaternion.create(cam.rotation.x, cam.rotation.y, cam.rotation.z, cam.rotation.w)
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

  // While the hide-zone is actually parked on a death spot (not underground),
  // keep excludeIds current — a bystander could wander in, or a new player
  // could join, during the respawn countdown.
  if (isPlayerDead) {
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

  // Strong at first, settling to nothing. Offset from the SNAPSHOT pose
  // (shakeBasePos/Rot, captured in cameraShake) — this is why the shake
  // doesn't drag the view back to a fixed rig position every frame.
  const amp = shakeAmp * (shakeTimer / shakeDuration)
  let offset: Vector3
  if (shakeNatural) {
    // layered sines = a low rolling rumble instead of harsh jitter
    shakePhase += dt
    const p = shakePhase
    offset = Vector3.create(
      amp * (0.6 * Math.sin(p * 31) + 0.4 * Math.sin(p * 17 + 1.3)),
      amp * (0.5 * Math.sin(p * 27 + 0.7) + 0.5 * Math.sin(p * 11 + 2.1)),
      amp * (0.6 * Math.sin(p * 23 + 2.6) + 0.4 * Math.sin(p * 13 + 0.4))
    )
  } else {
    offset = Vector3.create(
      (Math.random() - 0.5) * 2 * amp,
      (Math.random() - 0.5) * 2 * amp,
      (Math.random() - 0.5) * 2 * amp
    )
  }
  const t = Transform.getMutable(shakeCam)
  t.position = Vector3.add(shakeBasePos, offset)
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
    try {
      spawnBloodStain(playerPosition)
    } catch (err) {
      reportFailure('death:bloodStain', err instanceof Error ? err.message : String(err))
    }
    try {
      becomeTombstone(playerPosition, cause)
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
  addSafeSystem(tombstoneHoverSystem, 'tombstoneHoverSystem')
}
