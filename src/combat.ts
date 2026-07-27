/**
 * PLAYER COMBAT — the knives as weapons.
 *
 *  Key 1 (butcher knife held): slash. Plays the custom knife-slash emote on
 *  the avatar (authored on the official DCL rig), shows the butcher knife
 *  gripped in the right hand, a whoosh, and briefly freezes movement so
 *  locomotion can't override the emote. Damage itself still comes from the
 *  pointer-stab on a skeleton (skeletons.ts) — this is the feedback layer.
 *
 *  Key 2 (kitchen knife held): THROW the kitchen knife. It flies where the
 *  camera points; hitting a skeleton deals one hit (same as a stab). The
 *  knife then drops to the floor where it ended up and must be picked back
 *  up (E) before it can be thrown again.
 */

import {
  engine,
  Transform,
  GltfContainer,
  MeshCollider,
  ColliderLayer,
  InputAction,
  PointerEventType,
  inputSystem,
  pointerEventsSystem,
  raycastSystem,
  RaycastQueryType,
  AvatarAttach,
  AvatarAnchorPointType,
  Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { triggerSceneEmote } from '~system/RestrictedActions'
import { gameStarted, isPlayerDead, freezePlayer } from './gameState'
import { playerPosition } from './playerTracker'
import { knifeCollected } from './quest'
import { roundPhase, onRoundReset } from './gameLoop'
import { damageSkeletonNear } from './enemies/skeletons'
import { playSoundAt, SOUND_SWING } from './sounds'
import { bus, myId } from './multiplayer'
import { MODEL_KITCHEN_KNIFE, MODEL_BUTCHERS_KNIFE_HELD, PICKUP_MAX_DISTANCE, WEAPONS_ENABLED } from './config'
import { addSafeSystem } from './safeSystem'

const SLASH_EMOTE = 'assets/emotes/knife_slash_emote.glb'
const SWING_FREEZE_SECONDS = 0.7 // matches the 20-frame/30fps emote
const SWING_COOLDOWN_SECONDS = 0.8
const THROW_SPEED = 9 // m/s — slow enough to watch it fly and see where it lands
const THROW_RANGE = 18 // meters before the knife falls
const THROW_HIT_RADIUS = 1.1

let swingCooldown = 0

// --- butcher knife during the swing ---
// The knife is now baked INTO the emote GLB as a DCL emote prop
// (KnifeSlash_Prop clip) — it follows the animated hand exactly, so the
// AvatarAttach fallback below is off. Flip to true if the prop doesn't
// show on some platform:
const USE_ATTACHED_KNIFE_FALLBACK = false
const HELD_KNIFE_POSITION = Vector3.create(0, 0, 0)
const HELD_KNIFE_ROTATION = Vector3.create(180, 0, 0) // euler degrees

const heldList: { anchor: Entity; knife: Entity; ttl: number }[] = []

function showHeldKnife() {
  // IMPORTANT: AvatarAttach OVERRIDES the Transform of its own entity, so any
  // offset/rotation set there is ignored by the engine. The offset must live
  // on a CHILD entity of the attached anchor.
  const anchor = engine.addEntity()
  AvatarAttach.create(anchor, { anchorPointId: AvatarAnchorPointType.AAPT_RIGHT_HAND })
  const knife = engine.addEntity()
  Transform.create(knife, {
    position: Vector3.clone(HELD_KNIFE_POSITION),
    rotation: Quaternion.fromEulerDegrees(HELD_KNIFE_ROTATION.x, HELD_KNIFE_ROTATION.y, HELD_KNIFE_ROTATION.z),
    scale: Vector3.create(1, 1, 1),
    parent: anchor
  })
  GltfContainer.create(knife, { src: MODEL_BUTCHERS_KNIFE_HELD })
  heldList.push({ anchor, knife, ttl: SWING_FREEZE_SECONDS + 0.1 })
}

function swingFeedback(withHeldKnife: boolean) {
  triggerSceneEmote({ src: SLASH_EMOTE, loop: false }).catch((err) => {
    console.error('slash emote failed:', err)
  })
  freezePlayer(SWING_FREEZE_SECONDS)
  if (withHeldKnife && USE_ATTACHED_KNIFE_FALLBACK) showHeldKnife()
  playSoundAt(SOUND_SWING, playerPosition, 1)
}

// --- thrown kitchen knife ---
let thrown: { e: Entity; dir: Vector3; traveled: number } | null = null
// the knife lying on the ground waiting to be picked back up (if any)
let landed: { e: Entity; hitbox: Entity } | null = null

// Ghost knives: other players' throws, replayed here as pure visuals — the
// thrower's own client owns the damage and the landed pickup.
const ghostKnives: { e: Entity; dir: Vector3; traveled: number }[] = []

function spawnGhostKnife(start: Vector3, dir: Vector3) {
  const e = engine.addEntity()
  const tipForward = Quaternion.multiply(Quaternion.lookRotation(dir), Quaternion.fromEulerDegrees(-90, 0, 0))
  Transform.create(e, { position: Vector3.clone(start), rotation: tipForward, scale: Vector3.create(1.4, 1.4, 1.4) })
  GltfContainer.create(e, { src: MODEL_KITCHEN_KNIFE })
  ghostKnives.push({ e, dir: Vector3.clone(dir), traveled: 0 })
}

function throwKnife() {
  knifeCollected[1] = false // leaves the hand
  swingFeedback(false) // the projectile itself is the knife

  const camRot = Transform.get(engine.CameraEntity).rotation
  const dir = Vector3.normalize(Vector3.rotate(Vector3.Forward(), camRot))
  const start = Vector3.create(
    playerPosition.x + dir.x * 0.6,
    playerPosition.y + 1.0 + dir.y * 0.6,
    playerPosition.z + dir.z * 0.6
  )
  // let everyone else watch the same knife fly
  bus.emit('sh_knife', { id: myId(), sx: start.x, sy: start.y, sz: start.z, dx: dir.x, dy: dir.y, dz: dir.z })
  const e = engine.addEntity()
  // Measured from the GLB: the kitchen knife's tip points along model -Y.
  // The X-90 pre-rotation maps that tip onto +Z so it flies POINT-first
  // (and sticks point-first).
  const tipForward = Quaternion.multiply(Quaternion.lookRotation(dir), Quaternion.fromEulerDegrees(-90, 0, 0))
  Transform.create(e, { position: start, rotation: tipForward, scale: Vector3.create(1.4, 1.4, 1.4) })
  GltfContainer.create(e, { src: MODEL_KITCHEN_KNIFE })
  thrown = { e, dir, traveled: 0 }

  // Bullet-style collision: a short continuous ray ahead of the blade — the
  // moment it touches any physics collider (wall, table, floor...) the knife
  // sticks right there and stays retrievable.
  raycastSystem.registerGlobalDirectionRaycast(
    {
      entity: e,
      opts: {
        queryType: RaycastQueryType.RQT_HIT_FIRST,
        direction: dir,
        maxDistance: 1.0,
        continuous: true,
        collisionMask: ColliderLayer.CL_PHYSICS
      }
    },
    (result) => {
      if (thrown === null || thrown.e !== e) return
      if (result.hits.length > 0 && result.hits[0].position) {
        const hp = result.hits[0].position
        landKnife(Vector3.create(hp.x - dir.x * 0.1, hp.y - dir.y * 0.1, hp.z - dir.z * 0.1))
      }
    }
  )
}

/**
 * The knife stops and becomes a pickup. With stickAt (collider hit) it stays
 * embedded right where it struck, keeping its flight orientation; otherwise
 * (range exhausted) it drops flat onto the nearest floor below.
 */
function landKnife(stickAt?: Vector3) {
  if (thrown === null) return
  const e = thrown.e
  raycastSystem.removeRaycasterEntity(e)
  const t = Transform.getMutable(e)
  if (stickAt !== undefined) {
    t.position = stickAt
  } else {
    const pos = t.position
    // Snap to the nearest floor below (yard 0 / ground floor 2.58 / upstairs 8.4)
    const floorY = pos.y >= 8.4 ? 8.4 : pos.y >= 2.58 ? 2.58 : 0
    t.position = Vector3.create(pos.x, floorY + 0.05, pos.z)
    t.rotation = Quaternion.fromEulerDegrees(90, Math.random() * 360, 0) // flat on the ground
  }

  const hitbox = engine.addEntity()
  Transform.create(hitbox, { position: Vector3.create(0, 0, -0.15), scale: Vector3.create(0.5, 0.5, 0.4), parent: e })
  MeshCollider.setBox(hitbox, ColliderLayer.CL_POINTER)
  pointerEventsSystem.onPointerDown(
    { entity: hitbox, opts: { button: InputAction.IA_POINTER, hoverText: 'Pick up the kitchen knife', maxDistance: PICKUP_MAX_DISTANCE } },
    () => {
      if (isPlayerDead) return
      knifeCollected[1] = true
      pointerEventsSystem.removeOnPointerDown(hitbox)
      engine.removeEntity(hitbox)
      engine.removeEntity(e)
      landed = null
    }
  )
  landed = { e, hitbox }
  thrown = null
}

/**
 * Round reset: whatever state the knives ended the round in — mid-flight,
 * stuck in a wall, waiting on the floor — the new round starts with every
 * knife back in the player's hands.
 */
function resetCombatState() {
  if (thrown !== null) {
    raycastSystem.removeRaycasterEntity(thrown.e)
    engine.removeEntity(thrown.e)
    thrown = null
  }
  if (landed !== null) {
    pointerEventsSystem.removeOnPointerDown(landed.hitbox)
    engine.removeEntity(landed.hitbox)
    engine.removeEntity(landed.e)
    landed = null
  }
  for (let i = 0; i < knifeCollected.length; i++) knifeCollected[i] = true
  swingCooldown = 0
}

function combatSystem(dt: number) {
  // drop the held knife once the swing is over
  for (let i = heldList.length - 1; i >= 0; i--) {
    heldList[i].ttl -= dt
    if (heldList[i].ttl <= 0) {
      engine.removeEntity(heldList[i].knife)
      engine.removeEntity(heldList[i].anchor)
      heldList.splice(i, 1)
    }
  }

  // other players' knives in flight (visual only — no damage, no pickup)
  for (let i = ghostKnives.length - 1; i >= 0; i--) {
    const g = ghostKnives[i]
    const t = Transform.getMutable(g.e)
    const step = THROW_SPEED * dt
    t.position = Vector3.create(t.position.x + g.dir.x * step, t.position.y + g.dir.y * step, t.position.z + g.dir.z * step)
    g.traveled += step
    if (g.traveled >= THROW_RANGE) {
      engine.removeEntity(g.e)
      ghostKnives.splice(i, 1)
    }
  }

  // knife in flight
  if (thrown !== null) {
    const t = Transform.getMutable(thrown.e)
    const step = THROW_SPEED * dt
    t.position = Vector3.create(
      t.position.x + thrown.dir.x * step,
      t.position.y + thrown.dir.y * step,
      t.position.z + thrown.dir.z * step
    )
    thrown.traveled += step
    if (damageSkeletonNear(t.position, THROW_HIT_RADIUS) || thrown.traveled >= THROW_RANGE) {
      landKnife()
    }
  }

  if (swingCooldown > 0) swingCooldown -= dt

  // Key 1 (desktop): slash. On mobile there's no keyboard, so ui.tsx also
  // calls trySlash() directly from a tap on the butcher-knife hotbar icon.
  if (inputSystem.isTriggered(InputAction.IA_ACTION_3, PointerEventType.PET_DOWN)) trySlash()

  // Key 2 (desktop): throw. ui.tsx taps the kitchen-knife hotbar icon on mobile.
  if (inputSystem.isTriggered(InputAction.IA_ACTION_4, PointerEventType.PET_DOWN)) tryThrow()
}

/** Slash with the butcher knife, if one is held and off cooldown. Shared by the key-1 hotkey and the mobile hotbar tap. */
export function trySlash() {
  if (!WEAPONS_ENABLED) return // weapons parked — see WEAPONS_ENABLED in config.ts
  if (!gameStarted || isPlayerDead || roundPhase !== 'playing') return
  if (swingCooldown <= 0 && knifeCollected[0]) {
    swingCooldown = SWING_COOLDOWN_SECONDS
    swingFeedback(true)
  }
}

/** Throw the kitchen knife, if one is held, none already in flight, and off cooldown. Shared by the key-2 hotkey and the mobile hotbar tap. */
export function tryThrow() {
  if (!WEAPONS_ENABLED) return // weapons parked — see WEAPONS_ENABLED in config.ts
  if (!gameStarted || isPlayerDead || roundPhase !== 'playing') return
  if (swingCooldown <= 0 && knifeCollected[1] && thrown === null) {
    swingCooldown = SWING_COOLDOWN_SECONDS
    throwKnife()
  }
}

export function initCombat() {
  onRoundReset(resetCombatState)

  bus.on('sh_knife', (v) => {
    if (typeof v?.id === 'string' && v.id === myId()) return // my own echo — I already have the real one
    if (typeof v?.sx !== 'number' || typeof v?.dx !== 'number') return
    spawnGhostKnife(Vector3.create(v.sx, v.sy, v.sz), Vector3.create(v.dx, v.dy, v.dz))
  })

  addSafeSystem(combatSystem, 'combatSystem')
}
