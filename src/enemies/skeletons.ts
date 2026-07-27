/**
 * YARD SKELETON — one walking skeleton that haunts the garden.
 *
 * It wanders the yard (inside the outer iron fence, never entering the
 * house). The moment the player is out in the yard too, it chases; a touch
 * is a one-hit kill, same as every other hazard.
 *
 * Fighting back: click/tap it to stab it (you must have picked the butcher
 * knife up first — same "1" hotbar slot as the desktop slash). Each stab
 * knocks it back; SKELETON_HITS_TO_KILL stabs put it down. It crumbles and
 * gets back up at its spawn point after SKELETON_RESPAWN_SECONDS.
 *
 * MULTIPLAYER: fully per-client, same pattern as every other hazard in this
 * scene now (wall spikes, the dart trap, the chandelier, doors, candles, the
 * portal) — every client spawns and simulates its OWN skeleton, with no
 * syncEntity and no host election. This used to be a shared pool of 3: one
 * client, elected "simulation host" by lowest connected address, ran the
 * real AI while every synced Transform/Animator streamed out to everyone
 * else. That broke in exactly the way host-election schemes break on this
 * platform — real testing found host election and cross-device player
 * detection aren't reliable between arbitrary device pairs, which is what
 * caused the documented "six skeletons on one mobile device, exactly 3
 * configured" bug (two devices each concluding THEY were the host, each
 * spawning/syncing a conflicting copy) and left non-host phones seeing
 * frozen or desynced skeletons. Going per-client trades a perfectly shared
 * position (my skeleton and your skeleton won't be standing in the exact
 * same spot) for a hazard that works correctly on every device,
 * unconditionally, with zero dependency on any other client's connection
 * state — the same trade-off multiplayer.ts's own header comment already
 * documents as the scene's current architecture. Each player still gets a
 * fair, fully local, always-functional threat; that's what "skeleton death
 * logic" actually needs to guarantee, on mobile or PC.
 *
 * MOBILE-LEAN MODE: on the mobile client the whole scene reproducibly froze
 * the moment the skeleton noticed the player and closed in — and ONLY then;
 * doors/candles/deaths all work there now. Everything unique to that moment
 * is a platform-risky subsystem: the run/attack animation-clip switches
 * (Animator misbehavior on this client is already documented), the rattle
 * AudioSource volume mutations, the attack sound spawn, and the three
 * continuous raycast feelers. So on mobile ALL of those are disabled
 * (isMobileNow() guards inside ensureAnim/playOneShot/setRattle/the attack
 * sound, and the feelers are only registered once the async platform answer
 * confirms this is NOT mobile). What remains on mobile is the minimal
 * gameplay contract — Transform movement, chase targeting, kill-on-touch —
 * with the walk clip (started by Animator.create and never touched again)
 * looping throughout. If mobile still freezes with all of this off, the
 * culprit is plain Transform/movement; if it stops, reintroduce one
 * subsystem at a time to convict the specific one.
 */

import {
  engine,
  Transform,
  GltfContainer,
  ColliderLayer,
  Animator,
  AudioSource,
  pointerEventsSystem,
  raycastSystem,
  RaycastQueryType,
  InputAction,
  Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import { otherPlayerPositions } from '../multiplayer'
import {
  MODEL_SKELETON,
  SKELETON_SCALE,
  SKELETON_ANIM,
  SKELETON_SPAWNS,
  SKELETON_MODEL_Y_OFFSET,
  SKELETON_YAW_OFFSET_DEGREES,
  SKELETON_WANDER_SPEED,
  SKELETON_CHASE_SPEED,
  SKELETON_TURN_SPEED,
  SKELETON_KILL_RADIUS,
  SKELETON_ATTACK_REST_SECONDS,
  SKELETON_HITS_TO_KILL,
  SKELETON_STAB_MAX_DISTANCE,
  SKELETON_STAB_KNOCKBACK,
  SKELETON_RESPAWN_SECONDS,
  SKELETON_PATROL_BOUNDS,
  YARD_BOUNDS,
  HOUSE_RECT,
  YARD_MAX_Y,
  WEAPONS_ENABLED
} from '../config'
import { killPlayer, isInvulnerable } from '../gameState'
import { addSafeSystem } from '../safeSystem'
import { playerPosition } from '../playerTracker'
import { knifeCollected } from '../quest'
import { playSoundAt, SOUND_SKELETON_ATTACK, SOUND_BONE_RATTLE } from '../sounds'
import { isMobileNow, platformKnown } from '../platform'

type SkeletonState = 'wander' | 'chase' | 'resting' | 'down'

interface Skeleton {
  root: Entity
  audio: Entity // positional bone-rattle loop, on while it walks/chases
  spawn: Vector3
  state: SkeletonState
  target: Vector3
  timer: number
  hits: number
  anim: string // currently playing clip
  animLock: number // seconds a one-shot clip (attack/flinch) keeps priority
  animRefresh: number // seconds until the current looping clip is re-issued (mobile animator watchdog, see ensureAnim)
  rattleVol: number // current bone-rattle loop volume (0 = silent)
  blockAhead: number // distance to the nearest physics collider straight ahead (Infinity = clear)
  blockLeft: number // distance to collider on the left
  blockRight: number // distance to collider on the right
  stuck: number // seconds spent pushing against a collider without moving
  waypoint: Vector3 | null // temporary waypoint for obstacle avoidance
}

const skeletons: Skeleton[] = []

const ANIM_REFRESH_SECONDS = 2.5 // how often a looping clip gets re-issued, see below

/**
 * Switch the looping clip for a state — no-op if already playing or while a
 * one-shot holds. ALSO periodically re-issues the SAME clip even when nothing
 * changed: the mobile client has a documented history of Animator loop clips
 * silently freezing on a single frame (loop:true not respected, or playback
 * stalling outright) while everything else in the scene keeps running fine.
 * Re-sending playSingleAnimation every ANIM_REFRESH_SECONDS is a harmless
 * no-op on a client where the clip is already looping correctly, and bounds
 * a stall on an affected client to a few seconds instead of forever. The
 * skeleton's chase/kill logic never depended on animation state anyway (it's
 * driven by Transform position), so this only fixes what the player SEES —
 * but a skeleton that visibly isn't moving is easy to mistake for one that
 * isn't working at all.
 */
function ensureAnim(s: Skeleton, clip: string, dt: number) {
  if (isMobileNow()) return // mobile-lean: never touch the Animator after create (see header)
  if (s.animLock > 0) return
  if (s.anim === clip) {
    s.animRefresh -= dt
    if (s.animRefresh > 0) return
  }
  s.anim = clip
  s.animRefresh = ANIM_REFRESH_SECONDS
  Animator.playSingleAnimation(s.root, clip)
}

/** Play a one-shot clip (attack/flinch/death) that keeps priority for `lock` seconds. */
function playOneShot(s: Skeleton, clip: string, lock: number) {
  if (isMobileNow()) return // mobile-lean: never touch the Animator after create (see header)
  s.anim = clip
  s.animLock = lock
  Animator.playSingleAnimation(s.root, clip)
}

function insideHouse(x: number, z: number): boolean {
  return x > HOUSE_RECT.minX && x < HOUSE_RECT.maxX && z > HOUSE_RECT.minZ && z < HOUSE_RECT.maxZ
}

function posInYard(p: Vector3): boolean {
  if (p.y > YARD_MAX_Y) return false // on the porch / inside upstairs
  if (p.x < YARD_BOUNDS.minX || p.x > YARD_BOUNDS.maxX || p.z < YARD_BOUNDS.minZ || p.z > YARD_BOUNDS.maxZ) return false
  return !insideHouse(p.x, p.z)
}

export function playerInYard(): boolean {
  return posInYard(playerPosition)
}

/** Flat (x/z) distance to the nearest living skeleton — for the debug readout only. */
export function nearestSkeletonDist(): number {
  let best = 999
  for (const s of skeletons) {
    if (s.state === 'down') continue
    const t = Transform.get(s.root).position
    best = Math.min(best, Math.hypot(t.x - playerPosition.x, t.z - playerPosition.z))
  }
  return best
}

/** Every huntable PLAYER position in the yard: me (if vulnerable) + every other player. */
function playerYardTargets(): Vector3[] {
  const targets: Vector3[] = []
  if (playerInYard() && !isInvulnerable()) targets.push(playerPosition)
  for (const p of otherPlayerPositions()) {
    if (posInYard(p)) targets.push(p)
  }
  return targets
}

/**
 * Idle wander targets are restricted to SKELETON_PATROL_BOUNDS — the back
 * yard only, pulled in from the fence/corners so a random target doesn't
 * land against a collider (on request). That box sits entirely above the
 * house's maxZ, so it can never overlap the house footprint — no
 * insideHouse rejection sampling needed here. Chasing a player is NOT
 * limited to this box; only idle wandering is.
 */
function randomYardPoint(): Vector3 {
  const x = SKELETON_PATROL_BOUNDS.minX + Math.random() * (SKELETON_PATROL_BOUNDS.maxX - SKELETON_PATROL_BOUNDS.minX)
  const z = SKELETON_PATROL_BOUNDS.minZ + Math.random() * (SKELETON_PATROL_BOUNDS.maxZ - SKELETON_PATROL_BOUNDS.minZ)
  return Vector3.create(x, 0, z)
}

function standUp(s: Skeleton) {
  s.state = 'wander'
  s.hits = 0
  s.animLock = 0
  s.target = randomYardPoint()
  // Rise again somewhere random in the yard (never inside the house)
  const rise = randomYardPoint()
  const t = Transform.getMutable(s.root)
  t.position = Vector3.create(rise.x, SKELETON_MODEL_Y_OFFSET, rise.z)
  t.rotation = Quaternion.fromEulerDegrees(0, Math.random() * 360, 0)
  ensureAnim(s, SKELETON_ANIM.walk, 0) // always a fresh clip switch here — dt is irrelevant
}

function knockDown(s: Skeleton) {
  s.state = 'down'
  s.timer = SKELETON_RESPAWN_SECONDS
  // Death animation plays once and freezes on its final collapsed pose
  playOneShot(s, SKELETON_ANIM.death, SKELETON_RESPAWN_SECONDS)
}

function stab(s: Skeleton) {
  if (!WEAPONS_ENABLED) return // weapons parked — see WEAPONS_ENABLED in config.ts
  if (s.state === 'down' || isInvulnerable()) return
  if (!knifeCollected[0]) return // butcher knife (slot 1) required
  routeHit(s)
}

/**
 * One hit of damage from any weapon (stab or thrown knife). Per-client now —
 * my hits only ever apply to my own local skeleton pool, same as everything
 * else about them.
 */
function routeHit(s: Skeleton) {
  applyHit(s, playerPosition)
}

/**
 * One hit of damage from any weapon (stab or thrown knife). `from` is the
 * attacker's position — drives the knockback direction. SKELETON_HITS_TO_KILL
 * hits put the skeleton down.
 */
function applyHit(s: Skeleton, from: Vector3) {
  s.hits += 1
  if (s.hits >= SKELETON_HITS_TO_KILL) {
    knockDown(s)
    return
  }
  playOneShot(s, SKELETON_ANIM.hit, 0.7) // flinch

  // Flinch: shove it straight back from the attacker and make it hesitate
  const t = Transform.getMutable(s.root)
  const awayX = t.position.x - from.x
  const awayZ = t.position.z - from.z
  const len = Math.hypot(awayX, awayZ) || 1
  let nx = t.position.x + (awayX / len) * SKELETON_STAB_KNOCKBACK
  let nz = t.position.z + (awayZ / len) * SKELETON_STAB_KNOCKBACK
  nx = Math.max(YARD_BOUNDS.minX, Math.min(YARD_BOUNDS.maxX, nx))
  nz = Math.max(YARD_BOUNDS.minZ, Math.min(YARD_BOUNDS.maxZ, nz))
  t.position = Vector3.create(nx, SKELETON_MODEL_Y_OFFSET, nz)
  s.state = 'resting'
  s.timer = 0.8
}

/** 3D distance from the player to the nearest standing skeleton (Infinity if none). Drives the heartbeat. */
export function nearestSkeletonDistance(): number {
  let best = Infinity
  for (const s of skeletons) {
    if (s.state === 'down') continue
    const t = Transform.get(s.root).position
    const d = Math.hypot(t.x - playerPosition.x, t.z - playerPosition.z, t.y - playerPosition.y)
    if (d < best) best = d
  }
  return best
}

/** Damage the closest standing skeleton within radius of pos (thrown knife). */
export function damageSkeletonNear(pos: Vector3, radius: number): boolean {
  for (const s of skeletons) {
    if (s.state === 'down') continue
    const t = Transform.get(s.root).position
    if (Math.hypot(t.x - pos.x, t.z - pos.z) < radius && Math.abs(pos.y - (t.y + 1)) < 2.0) {
      routeHit(s)
      return true
    }
  }
  return false
}

function moveToward(s: Skeleton, goal: Vector3, speed: number, dt: number): number {
  const t = Transform.getMutable(s.root)

  // If we have a waypoint (obstacle avoidance), navigate to it first
  let target = goal
  if (s.waypoint !== null) {
    const wpDist = Math.hypot(s.waypoint.x - t.position.x, s.waypoint.z - t.position.z)
    if (wpDist < 0.3) {
      // Waypoint reached, clear it and continue to goal
      s.waypoint = null
    } else {
      // Still approaching waypoint
      target = s.waypoint
    }
  }

  const dx = target.x - t.position.x
  const dz = target.z - t.position.z
  const dist = Math.hypot(dx, dz)
  if (dist < 0.05) return Math.hypot(goal.x - t.position.x, goal.z - t.position.z)

  const step = Math.min(speed * dt, dist)

  // If blocked ahead, try to find a way around via waypoints
  if (s.blockAhead < step + 0.5) {
    s.stuck += dt

    // A waypoint that isn't actually working out (still blocked while
    // approaching it, or it led into another obstacle) used to stick around
    // forever — it was only ever computed ONCE, the moment s.waypoint was
    // null, and never reconsidered afterward. That's the "always gets
    // stuck" bug reported live: nothing in the chase state ever gives up on
    // a bad waypoint (wander at least abandons the whole target eventually
    // — chase has no such fallback at all). Discarding it here lets the
    // block below compute a fresh one instead of freezing on the first
    // failed attempt.
    if (s.stuck > 1.4 && s.waypoint !== null) {
      s.waypoint = null
    }

    // If stuck long enough and no waypoint yet, compute a detour
    if (s.stuck > 0.8 && s.waypoint === null) {
      // Try stepping left or right perpendicular to the obstacle
      const perpX = -dz
      const perpZ = dx
      const perpLen = Math.hypot(perpX, perpZ) || 1

      // Try left first if it's clear
      if (s.blockLeft > 1.0) {
        s.waypoint = Vector3.create(
          t.position.x + (perpX / perpLen) * 2.0,
          0,
          t.position.z + (perpZ / perpLen) * 2.0
        )
      } else if (s.blockRight > 1.0) {
        // Otherwise try right
        s.waypoint = Vector3.create(
          t.position.x - (perpX / perpLen) * 2.0,
          0,
          t.position.z - (perpZ / perpLen) * 2.0
        )
      } else {
        // Boxed in on every side that was checked (a corner/dead-end) —
        // back away instead of just standing there with no plan at all.
        s.waypoint = Vector3.create(
          t.position.x - (dx / dist) * 2.0,
          0,
          t.position.z - (dz / dist) * 2.0
        )
      }
    }
  } else {
    s.stuck = 0
    let nx = t.position.x + (dx / dist) * step
    let nz = t.position.z + (dz / dist) * step

    // Never path into the house — slide along its walls instead
    if (insideHouse(nx, nz)) {
      if (!insideHouse(t.position.x, nz)) nx = t.position.x
      else if (!insideHouse(nx, t.position.z)) nz = t.position.z
      else {
        nx = t.position.x
        nz = t.position.z
      }
    }
    t.position = Vector3.create(nx, SKELETON_MODEL_Y_OFFSET, nz)
  }

  const yaw = Math.atan2(dx, dz) * (180 / Math.PI) + SKELETON_YAW_OFFSET_DEGREES
  t.rotation = Quaternion.slerp(t.rotation, Quaternion.fromEulerDegrees(0, yaw, 0), Math.min(1, SKELETON_TURN_SPEED * dt))
  return Math.hypot(goal.x - t.position.x, goal.z - t.position.z)
}

/**
 * raycastSystem callbacks run OUTSIDE addSafeSystem's protection — there is
 * no wrapper between them and the engine's per-frame tick. These three fire
 * continuously (opts.continuous: true), unconditionally, for every skeleton,
 * from the moment initSkeletons() runs — the single most-frequently-invoked
 * unguarded code in this scene. An unexpected result shape here (any gap
 * between how the mobile client's raycast query fills this callback vs.
 * desktop's) would throw straight into DCL's tick loop with nothing to catch
 * it, which per safeSystem.ts's own header comment aborts EVERY system for
 * that frame — a much bigger blast radius than one broken feature, and on a
 * device where the same bad state recurs every subsequent tick, potentially
 * indistinguishable from the whole scene silently dying for the rest of the
 * session. Fall back to "nothing blocking" rather than let it throw.
 */
function readHitDistance(result: unknown): number {
  try {
    const hits = (result as { hits?: { length: number }[] } | undefined)?.hits
    return hits !== undefined && hits.length > 0 ? hits[0].length : Infinity
  } catch (_) {
    return Infinity
  }
}

/** Update the positional bone-rattle loop to match a state's volume. */
function setRattle(s: Skeleton, wantVol: number) {
  if (isMobileNow()) return // mobile-lean: the loop keeps its created volume, never mutated
  if (wantVol === s.rattleVol) return
  s.rattleVol = wantVol
  const a = AudioSource.getMutable(s.audio)
  a.playing = wantVol > 0
  a.volume = wantVol
}

/**
 * Three feeler rays (forward/left/right) for obstacle avoidance, each on its
 * own child entity — DCL's raycastSystem keys registrations by entity id
 * (Raycast.createOrReplace + a single-entry callback map), so registering all
 * three directly on `root` would let each new one silently replace the last.
 * DESKTOP-ONLY, and registered lazily: the async platform answer isn't in
 * yet when initSkeletons() runs, so skeletonSystem registers these on the
 * first frame after platformKnown() confirms this is not the mobile client
 * (mobile-lean mode drops them entirely — see the header). Until then
 * blockAhead/Left/Right stay Infinity, i.e. "nothing blocking", which just
 * means no detour waypoints for those first moments.
 */
function registerFeelers(s: Skeleton) {
  const feelers: { direction: Vector3; apply: (d: number) => void }[] = [
    { direction: Vector3.Forward(), apply: (d) => (s.blockAhead = d) },
    { direction: Vector3.Left(), apply: (d) => (s.blockLeft = d) },
    { direction: Vector3.Right(), apply: (d) => (s.blockRight = d) }
  ]
  for (const f of feelers) {
    const feeler = engine.addEntity()
    Transform.create(feeler, { parent: s.root })
    raycastSystem.registerLocalDirectionRaycast(
      {
        entity: feeler,
        opts: {
          queryType: RaycastQueryType.RQT_HIT_FIRST,
          direction: f.direction,
          originOffset: Vector3.create(0, 1, 0),
          maxDistance: 2,
          continuous: true,
          collisionMask: ColliderLayer.CL_PHYSICS
        }
      },
      (result) => {
        f.apply(readHitDistance(result))
      }
    )
  }
}

let feelersDecided = false

function skeletonSystem(dt: number) {
  // One-time, deferred: feelers exist only where the platform answer says
  // this is not the mobile client (see registerFeelers).
  if (!feelersDecided && platformKnown()) {
    feelersDecided = true
    if (!isMobileNow()) for (const s of skeletons) registerFeelers(s)
  }

  const targets = playerYardTargets()

  for (const s of skeletons) {
    if (s.animLock > 0) s.animLock -= dt

    // bones clatter while it's on the move — louder when it's coming for you
    // (both bumped up, on request: the walk/wander sfx was too quiet)
    setRattle(s, s.state === 'chase' ? 0.85 : s.state === 'wander' ? 0.55 : 0)

    switch (s.state) {
      case 'down':
        s.timer -= dt
        if (s.timer <= 0) standUp(s)
        break

      case 'resting':
        s.timer -= dt
        ensureAnim(s, SKELETON_ANIM.idle, dt)
        if (s.timer <= 0) s.state = targets.length > 0 ? 'chase' : 'wander'
        break

      case 'wander': {
        if (targets.length > 0) {
          s.state = 'chase'
          break
        }
        ensureAnim(s, SKELETON_ANIM.walk, dt)
        const remaining = moveToward(s, s.target, SKELETON_WANDER_SPEED, dt)
        // Reached the point, or spent too long shoving a fence: pick a new one
        if (remaining < 0.4 || s.stuck > 1.5) {
          s.stuck = 0
          s.target = randomYardPoint()
        }
        break
      }

      case 'chase': {
        // candidates: every player in the yard
        const candidates = targets.slice()
        if (candidates.length === 0) {
          s.state = 'wander'
          s.target = randomYardPoint()
          break
        }
        // hunt whichever is closest
        const skelPos = Transform.get(s.root).position
        let goal = candidates[0]
        let goalDist = Infinity
        for (const p of candidates) {
          const d = Math.hypot(p.x - skelPos.x, p.z - skelPos.z)
          if (d < goalDist) {
            goalDist = d
            goal = p
          }
        }
        ensureAnim(s, SKELETON_ANIM.run, dt)
        const dist = moveToward(s, goal, SKELETON_CHASE_SPEED, dt)
        if (dist < SKELETON_KILL_RADIUS) {
          // Caught someone. Every client decides its OWN death locally, so
          // only kill here if the one in reach is me...
          const myDist = Math.hypot(skelPos.x - playerPosition.x, skelPos.z - playerPosition.z)
          if (myDist < SKELETON_KILL_RADIUS && playerInYard() && !isInvulnerable()) {
            killPlayer('Torn apart by a skeleton')
          }
          playOneShot(s, SKELETON_ANIM.attack, 1.1)
          if (!isMobileNow()) playSoundAt(SOUND_SKELETON_ATTACK, Transform.get(s.root).position, 1)
          s.state = 'resting'
          s.timer = SKELETON_ATTACK_REST_SECONDS
        }
        break
      }
    }
  }
}

export function initSkeletons() {
  for (const spawn of SKELETON_SPAWNS) {
    const root = engine.addEntity()
    Transform.create(root, {
      position: Vector3.create(spawn.x, SKELETON_MODEL_Y_OFFSET, spawn.z),
      rotation: Quaternion.fromEulerDegrees(0, Math.random() * 360, 0),
      scale: Vector3.create(SKELETON_SCALE, SKELETON_SCALE, SKELETON_SCALE)
    })
    GltfContainer.create(root, { src: MODEL_SKELETON, visibleMeshesCollisionMask: ColliderLayer.CL_POINTER })
    Animator.create(root, {
      states: [
        { clip: SKELETON_ANIM.walk, playing: true, loop: true },
        { clip: SKELETON_ANIM.run, loop: true },
        { clip: SKELETON_ANIM.idle, loop: true },
        { clip: SKELETON_ANIM.attack, loop: false },
        { clip: SKELETON_ANIM.hit, loop: false },
        { clip: SKELETON_ANIM.death, loop: false }
      ]
    })

    const audio = engine.addEntity()
    Transform.create(audio, { position: Vector3.create(0, 1, 0), parent: root })
    AudioSource.create(audio, { audioClipUrl: SOUND_BONE_RATTLE, playing: true, loop: true, volume: 0.55 })

    const s: Skeleton = {
      root,
      audio,
      spawn: Vector3.clone(spawn),
      state: 'wander',
      target: randomYardPoint(),
      timer: 0,
      hits: 0,
      anim: SKELETON_ANIM.walk,
      animLock: 0,
      animRefresh: ANIM_REFRESH_SECONDS,
      rattleVol: 0.55, // spawns wandering, matching the audio created above
      blockAhead: Infinity,
      blockLeft: Infinity,
      blockRight: Infinity,
      stuck: 0,
      waypoint: null
    }
    skeletons.push(s)

    // Click/tap to stab (needs the butcher knife in hand) — IA_POINTER so it
    // works with a plain tap on mobile, not just a desktop key. Only
    // registered while weapons are actually enabled — otherwise this was
    // showing a "Stab" hover prompt for an interaction that immediately
    // no-ops (stab() itself already returns early on !WEAPONS_ENABLED),
    // which reads as broken rather than just parked.
    if (WEAPONS_ENABLED) {
      pointerEventsSystem.onPointerDown(
        {
          entity: root,
          opts: { button: InputAction.IA_POINTER, hoverText: 'Stab — butcher knife', maxDistance: SKELETON_STAB_MAX_DISTANCE }
        },
        () => stab(s)
      )
    }
  }

  addSafeSystem(skeletonSystem, 'skeletonSystem')
}
