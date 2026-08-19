/**
 * PLAYER COMBAT — the knives as weapons.
 *
 *  Key 1 (butcher knife held): slash. Plays the custom knife-slash emote on
 *  the avatar (authored on the official DCL rig), shows the butcher knife
 *  gripped in the right hand, a whoosh, and briefly freezes movement so
 *  locomotion can't override the emote. Damage itself still comes from the
 *  pointer-stab on a skeleton (skeletons.ts) — this is the feedback layer.
 *
 *  THROWN KNIVES WERE DELETED on 2026-08-19 on request — the whole mechanic,
 *  not just its entry point. That removed: the projectile and its continuous
 *  raycast, the stick-in-a-wall landing, the pick-it-back-up hitbox, the
 *  'sh_knife' multiplayer message and the ghost knives that replayed other
 *  players' throws, plus damageSkeletonNear() over in skeletons.ts, which
 *  existed only to serve it. What is left here is the slash feedback layer.
 */

import {
  engine,
  Transform,
  GltfContainer,
  ColliderLayer,
  InputAction,
  PointerEventType,
  inputSystem,
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
import { playSoundAt, SOUND_SWING } from './sounds'
import { MODEL_BUTCHERS_KNIFE_HELD, WEAPONS_ENABLED } from './config'
import { addSafeSystem } from './safeSystem'

const SLASH_EMOTE = 'assets/emotes/knife_slash_emote.glb'
const SWING_FREEZE_SECONDS = 0.7 // matches the 20-frame/30fps emote
const SWING_COOLDOWN_SECONDS = 0.8

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
  // Both masks named explicitly: invisibleMeshesCollisionMask defaults to
  // CL_PHYSICS, and this one is PARENTED TO THE PLAYER — an invisible solid
  // box riding the avatar is the worst place in the scene to inherit that
  // default. Inert on the current model (no collider node) and stays correct
  // if the model is ever swapped.
  GltfContainer.create(knife, {
    src: MODEL_BUTCHERS_KNIFE_HELD,
    visibleMeshesCollisionMask: ColliderLayer.CL_NONE,
    invisibleMeshesCollisionMask: ColliderLayer.CL_NONE
  })
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

/** Round reset: every knife back in hand, cooldown cleared. */
function resetCombatState() {
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

  if (swingCooldown > 0) swingCooldown -= dt

  // Key 1 (desktop): slash. On mobile there's no keyboard, so ui.tsx also
  // calls trySlash() directly from a tap on the butcher-knife hotbar icon.
  if (inputSystem.isTriggered(InputAction.IA_ACTION_3, PointerEventType.PET_DOWN)) trySlash()
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

export function initCombat() {
  onRoundReset(resetCombatState)
  addSafeSystem(combatSystem, 'combatSystem')
}
