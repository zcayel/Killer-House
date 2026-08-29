/**
 * LIGHTNING — the storm outside, and it hits the ground.
 *
 * A strike fires every 20s — LIGHTNING_STRIKE_INTERVAL of quiet (15.37) plus
 * the sequence below (3s of sparks, then 1.63s from the flash to the settle). LIGHTNING_BOLT_COUNT
 * points are picked around the yard, SPARKS CRACKLE on each of them for a few
 * seconds as the telegraph, then the sky double-flashes and the bolts land
 * TOGETHER on one thunderclap: the screen cuts to black for an instant, the
 * camera rumbles, the thunder CRACKS — and anyone standing where any of them
 * hit dies.
 *
 * TWO BOLTS, NOT ONE (on request), kept LIGHTNING_MIN_SEPARATION apart so they
 * read as a forked strike rather than one bolt drawn twice. Note this roughly
 * doubles the lethal ground per strike: each bolt carries a full
 * LIGHTNING_KILL_RADIUS of its own.
 *
 * THERE IS NO TARGET CIRCLE, on request — it read as a game-y skill indicator
 * rather than weather. For a while the only warning was the sky flash, and the
 * numbers were unkind: it fires at strikeClock 0 and the kill lands at
 * THUNDER_AT, which is 0.67s later — reaction time, not enough to cross a 2.6m
 * ring even if you read it perfectly.
 *
 * SPARKS ARE THE REAL TELEGRAPH now. Ground sparks in the bolt's own colour
 * dance on every spot about to be hit, for LIGHTNING_WARN_SECONDS BEFORE the
 * strike, and the points are LOCKED the moment they light — so walking out of
 * the ring always works. Weather, not a skill indicator, and dodgeable.
 *
 * Indoors is always safe: strike points are rejected inside the house
 * footprint, and the kill test independently requires the player to be outside
 * it too, so a strike just beyond a wall cannot reach through it.
 *
 * ON THE VISUAL: the bolt is a BAKED FLIPBOOK, played by stepping a quad's
 * UVs. Decentraland scenes can't author shaders at runtime, so a Voronoi fork
 * has to be rendered offline and shipped as an atlas — that is what
 * lightning-source/lightning_build.py does, headless in Blender, using the
 * same pipeline as energyball-source. Voronoi (4D, Distance to Edge) is the
 * node that makes the fork; the 4th axis steps per frame so the bolt reshapes
 * as it flickers rather than merely dimming.
 *
 * Played ONCE per strike, never looped — frame 0 is the hit, the last frame is
 * gone. Re-bake with different --sx/--sy/--edge to change the fork's character
 * without touching a line of this file.
 */

import {
  engine,
  Transform,
  LightSource,
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
  VisibilityComponent,
  Billboard,
  BillboardMode,
  Entity
} from '@dcl/sdk/ecs'
import { volumeCylinder, endVolumes, VOLUME_COLOURS } from './debug/killVolumes'
import { Vector3, Quaternion, Color3, Color4 } from '@dcl/sdk/math'
import { gameStarted, isPlayerDead, killPlayer, isInvulnerable } from './gameState'
import { playerPosition, predictPlayerPosition } from './playerTracker'
import { playSoundAt } from './sounds'
import { startQuake } from './effects/quake'
import { shakeCamera } from './effects/cameraShake'
import { addSafeSystem } from './safeSystem'
import { registerReplayActor, recordHazardEvent, replayIsPlaying } from './effects/replayStage'
import {
  YARD_BOUNDS,
  HOUSE_RECT,
  LIGHTNING_STRIKE_ENABLED,
  LIGHTNING_KILL_RADIUS,
  LIGHTNING_HOUSE_MARGIN,
  LIGHTNING_FLIPBOOK,
  LIGHTNING_FLIPBOOK_GRID,
  LIGHTNING_BOLT_HEIGHT,
  LIGHTNING_BOLT_WIDTH,
  LIGHTNING_BOLT_SECONDS,
  LIGHTNING_SPEED,
  LIGHTNING_BOLT_COUNT,
  LIGHTNING_MIN_SEPARATION,
  LIGHTNING_HUNT_ENABLED,
  LIGHTNING_HUNT_BOLTS,
  LIGHTNING_LEAD_MAX,
  QUAKE_SECONDS,
  QUAKE_AMPLITUDE,
  LIGHTNING_STRIKE_INTERVAL_MIN,
  LIGHTNING_STRIKE_INTERVAL_MAX,
  LIGHTNING_FLASH_SECONDS,
  LIGHTNING_FLASH_PEAK,
  LIGHTNING_COLOR,
  LIGHTNING_BOLT_EMISSIVE,
  LIGHTNING_IMPACT_INTENSITY,
  LIGHTNING_IMPACT_RANGE,
  LIGHTNING_WARN_SECONDS,
  LIGHTNING_SPARK_COUNT,
  LIGHTNING_SPARK_TEXTURE,
  LIGHTNING_SPARK_ATLAS_GRID,
  LIGHTNING_SPARK_RADIUS,
  LIGHTNING_SPARK_SIZE,
  LIGHTNING_SPARK_CRAWL,
  LIGHTNING_SPARK_GROUND_Y,
  LIGHTNING_SPARK_HZ,
  LIGHTNING_SPARK_EMISSIVE,
  LIGHTNING_WARN_LIGHT_INTENSITY,
  LIGHTNING_WARN_LIGHT_RANGE
} from './config'

/**
 * THREE THUNDER CLAPS, cycled in order — on request 2026-08-20.
 *
 * One sample repeating is what makes a storm read as a loop rather than
 * weather, and at a ~16.6s strike cadence you hear it a lot. Rotating three
 * distinct recordings breaks that up; the existing random volume and pitch
 * then vary each one further, so no two strikes land the same.
 *
 * [1] is the original. [2] and [3] were cut from the BBC storm recording
 * already in the project (assets/scene/Audio/bbc_thunder---_07005238.mp3, a
 * 35s field recording) at its two loudest separated claps — 3.6s and 13.7s —
 * then faded, loudness-matched and converted to the same mono 24kHz PCM as [1]
 * so all three sit at the same level.
 */
export const SOUND_THUNDER = 'assets/sounds/thunder.wav' // CC0, freesound #243614 (trimmed)
export const SOUND_THUNDER_2 = 'assets/sounds/thunder_2.wav'
export const SOUND_THUNDER_3 = 'assets/sounds/thunder_3.wav'
const THUNDER_CLAPS = [SOUND_THUNDER, SOUND_THUNDER_2, SOUND_THUNDER_3]
/** Rotates rather than randomises: random repeats, and a repeat is the thing
 *  this is meant to stop. */
let thunderIndex = 0

/** Screen blackout at the moment the thunder hits (read by the UI overlay). */
export let blackoutAlpha = 0
/**
 * White-blue screen wash at the same moment, also read by the UI overlay.
 *
 * Separate from blackoutAlpha rather than folded into it because they are
 * opposite colours and different lengths: the flash is the bolt (bright, half a
 * second), the blackout is the aftermath (dark, slower). Drawn over the top.
 */
export let flashAlpha = 0

// HOW OFTEN a strike happens — LIGHTNING_STRIKE_INTERVAL_MIN/MAX in config.ts.
// Deliberately NOT scaled by LIGHTNING_SPEED: that knob is the speed of one
// strike, and folding frequency into it would mean "make the thunder faster"
// silently also made it more dangerous.
const FIRST_STRIKE_SECONDS = 12

// ── Strike timings ─────────────────────────────────────────────────────────
// Every one of these divides by LIGHTNING_SPEED so the sequence stays in sync
// with itself at any speed — see the note on that constant in config.ts.
//
// THUNDER_AT is when the bolt lands and the kill test runs. It used to be the
// player's entire dodge window and at 1.35x that is 0.67s, which was not a
// window so much as a reflex check. LIGHTNING_WARN_SECONDS of ground sparks now
// runs BEFORE any of this, so the real window is warning + THUNDER_AT and that
// is the number to change if lightning reads as unfair — not this one.
const THUNDER_AT = 0.9 / LIGHTNING_SPEED
const FLASH_A_END = 0.12 / LIGHTNING_SPEED
const FLASH_B_START = 0.2 / LIGHTNING_SPEED
const FLASH_B_END = 0.38 / LIGHTNING_SPEED
const BOLT_SECONDS = LIGHTNING_BOLT_SECONDS / LIGHTNING_SPEED
const STRIKE_SETTLE = 2.2 / LIGHTNING_SPEED
const BLACKOUT_FADE_RATE = 2.2 * LIGHTNING_SPEED
const BLACKOUT_PEAK = 0.85
// THE THUNDER SHAKES THE CAMERA AGAIN — back on, on request, and now a strict
// two-axis shake: side to side and up and down, nothing else. History, because
// it is the reason the motion is constrained the way it is:
//
//   1. jitter was built in world axes, so part of it ran along the view — a
//      dolly. Fixed by building it from the camera's right/up instead.
//   2. the rig froze at its start pose for 1.6s, so walking during a strike
//      walked you away from your own camera. Fixed by tracking translation.
//   3. "zooming to first person" — the takeover renders from a rig posed off
//      engine.CameraEntity, and in third person that reports a head-anchored
//      position, so the swap collapsed the view into the avatar's head. Now
//      compensated in deathEffects.ts (see the third-person pull-back there).
//
// Shorter than it was: a 1.6s shake outlived the crack that caused it. This is
// tied to the strike sequence's own speed so "make the thunder faster" moves
// the shake with it instead of leaving it trailing behind.
const THUNDER_SHAKES_GROUND = true
const QUAKE_TIME = QUAKE_SECONDS / LIGHTNING_SPEED

// ONE ENTRY PER BOLT, all the same length (LIGHTNING_BOLT_COUNT) and all built
// together in initLightning. A strike fires every index at once.
const flashLights: Entity[] = []
const impactLights: Entity[] = []
const bolts: Entity[] = []
const boltFrames: number[] = [] // which atlas cell each quad is currently showing
const strikePoints: Vector3[] = []

let nextStrike = FIRST_STRIKE_SECONDS
let strikeClock = -1 // -1 = no strike in progress

/**
 * A random spot in the yard that is NOT the house, and not on top of a strike
 * point already chosen for this same strike.
 *
 * Rejection-sampled rather than solved analytically — the yard minus the house
 * is an L-shape and picking uniformly inside it directly is more code than it
 * is worth for something that succeeds on the first try most of the time.
 * Bounded attempts so a bad config can never spin here forever.
 *
 * `taken` holds the points already placed this strike; separation is only
 * checked against those. On the fallback path the separation rule is dropped
 * rather than looping forever — a strike with two bolts closer together than
 * intended is a cosmetic problem, a hung frame is not.
 */
function pickStrikePoint(taken: Vector3[]): Vector3 {
  for (let i = 0; i < 40; i++) {
    const x = YARD_BOUNDS.minX + Math.random() * (YARD_BOUNDS.maxX - YARD_BOUNDS.minX)
    const z = YARD_BOUNDS.minZ + Math.random() * (YARD_BOUNDS.maxZ - YARD_BOUNDS.minZ)
    const insideHouse =
      x > HOUSE_RECT.minX - LIGHTNING_HOUSE_MARGIN &&
      x < HOUSE_RECT.maxX + LIGHTNING_HOUSE_MARGIN &&
      z > HOUSE_RECT.minZ - LIGHTNING_HOUSE_MARGIN &&
      z < HOUSE_RECT.maxZ + LIGHTNING_HOUSE_MARGIN
    if (insideHouse) continue

    let tooClose = false
    for (const t of taken) {
      if (Math.hypot(x - t.x, z - t.z) < LIGHTNING_MIN_SEPARATION) {
        tooClose = true
        break
      }
    }
    if (!tooClose) return Vector3.create(x, 0, z)
  }
  return Vector3.create(YARD_BOUNDS.minX + 1, 0, YARD_BOUNDS.maxZ - 1)
}

/** True while the player is under the roof, which is absolute shelter. */
function insideHouse(x: number, z: number, margin: number): boolean {
  return (
    x > HOUSE_RECT.minX - margin &&
    x < HOUSE_RECT.maxX + margin &&
    z > HOUSE_RECT.minZ - margin &&
    z < HOUSE_RECT.maxZ + margin
  )
}

/**
 * A strike point that LEADS the player — aimed where they will be when the
 * bolt lands, not where they are as it is chosen.
 *
 * Returns null when there is nothing worth aiming at, and the caller falls
 * back to a random point. That happens when the player is under the roof
 * (sheltered, so a bolt aimed at them could never land) or when the lead
 * lands somewhere a bolt is not allowed to strike and cannot be pushed clear.
 *
 * THUNDER_AT is the lead time, taken from the strike timeline rather than
 * configured separately: it is exactly the gap between this choice and the
 * moment playerInStrike() is tested, so aiming any further ahead would be
 * aiming past the kill.
 */
function huntStrikePoint(): Vector3 | null {
  const p = playerPosition
  if (insideHouse(p.x, p.z, 0)) return null

  const lead = predictPlayerPosition(THUNDER_AT)
  let dx = lead.x - p.x
  let dz = lead.z - p.z
  const run = Math.hypot(dx, dz)
  if (run > LIGHTNING_LEAD_MAX) {
    dx = (dx / run) * LIGHTNING_LEAD_MAX
    dz = (dz / run) * LIGHTNING_LEAD_MAX
  }
  let x = Math.min(YARD_BOUNDS.maxX, Math.max(YARD_BOUNDS.minX, p.x + dx))
  let z = Math.min(YARD_BOUNDS.maxZ, Math.max(YARD_BOUNDS.minZ, p.z + dz))

  // A lead that runs under the roof has to be pulled back out to the nearest
  // legal edge. Aiming into the house is not a near miss, it is a bolt that
  // never lands — the strike would silently do nothing.
  if (insideHouse(x, z, LIGHTNING_HOUSE_MARGIN)) {
    const m = LIGHTNING_HOUSE_MARGIN
    const outs = [
      { x: HOUSE_RECT.minX - m, z, d: Math.abs(x - (HOUSE_RECT.minX - m)) },
      { x: HOUSE_RECT.maxX + m, z, d: Math.abs(HOUSE_RECT.maxX + m - x) },
      { x, z: HOUSE_RECT.minZ - m, d: Math.abs(z - (HOUSE_RECT.minZ - m)) },
      { x, z: HOUSE_RECT.maxZ + m, d: Math.abs(HOUSE_RECT.maxZ + m - z) }
    ]
    let best = outs[0]
    for (const o of outs) if (o.d < best.d) best = o
    x = best.x
    z = best.z
    if (x < YARD_BOUNDS.minX || x > YARD_BOUNDS.maxX || z < YARD_BOUNDS.minZ || z > YARD_BOUNDS.maxZ) {
      return null
    }
  }
  return Vector3.create(x, 0, z)
}

/** Is the player standing in ANY of this strike's lethal rings — and outside the house, which is always shelter? */
/** Debug overlay: one cylinder per live strike point. */
function drawStrikeVolumes(): void {
  let n = 0
  for (const s of strikePoints) {
    volumeCylinder('lightning', n++, Vector3.create(s.x, 0, s.z), LIGHTNING_KILL_RADIUS,
                   0, 6, VOLUME_COLOURS.lightning)
  }
  endVolumes('lightning', n)
}

function playerInStrike(): boolean {
  const p = playerPosition
  const shelteredByHouse =
    p.x > HOUSE_RECT.minX && p.x < HOUSE_RECT.maxX && p.z > HOUSE_RECT.minZ && p.z < HOUSE_RECT.maxZ
  if (shelteredByHouse) return false
  for (const s of strikePoints) {
    if (Math.hypot(p.x - s.x, p.z - s.z) < LIGHTNING_KILL_RADIUS) return true
  }
  return false
}

/** Stands each bolt quad on its strike point. */
function placeBolts() {
  for (let i = 0; i < bolts.length; i++) {
    Transform.createOrReplace(bolts[i], {
      position: Vector3.create(strikePoints[i].x, LIGHTNING_BOLT_HEIGHT * 0.5, strikePoints[i].z),
      scale: Vector3.create(LIGHTNING_BOLT_WIDTH, LIGHTNING_BOLT_HEIGHT, 1)
    })
    boltFrames[i] = -1
  }
}

/**
 * Point the quad at one cell of the atlas.
 *
 * setPlane takes 16 UV floats — four corners for the front face, then the same
 * four for the back — in the order bottom-left, top-left, top-right,
 * bottom-right.
 *
 * The V flip is the part that is easy to get wrong: the baker packs frame row
 * 0 at the TOP of the image, while UV space counts V UP from the bottom. So
 * row r lives at v = (GRID-1-r)/GRID .. (GRID-r)/GRID. This mirrors the
 * `rb = (GRID - 1 - r) * CELL` line in lightning_build.py; if one ever
 * changes, the other has to change with it.
 */
function setBoltFrame(bolt: number, frame: number) {
  if (frame === boltFrames[bolt]) return // UVs only change on a frame boundary, not every tick
  boltFrames[bolt] = frame
  const g = LIGHTNING_FLIPBOOK_GRID
  const r = Math.floor(frame / g)
  const c = frame % g
  const u0 = c / g
  const u1 = (c + 1) / g
  const v0 = (g - 1 - r) / g
  const v1 = (g - r) / g
  MeshRenderer.setPlane(bolts[bolt], [u0, v0, u0, v1, u1, v1, u1, v0, u0, v0, u0, v1, u1, v1, u1, v0])
}

/**
 * Step every bolt in the strike to the same atlas cell.
 *
 * They share one frame index on purpose: the flipbook's envelope IS the
 * strike's envelope (frame 0 is the hit, the last frame is gone), so bolts on
 * different frames would be flickering out of step with a single thunderclap.
 */
function setAllBoltFrames(frame: number) {
  for (let i = 0; i < bolts.length; i++) setBoltFrame(i, frame)
}

function showBolts(visible: boolean) {
  for (const b of bolts) VisibilityComponent.createOrReplace(b, { visible })
}

function setImpactLights(active: boolean) {
  for (const l of impactLights) LightSource.getMutable(l).active = active
}

/**
 * THE STORM'S MEMORY — the bolt points of the last few strikes.
 *
 * A strike aims itself: some bolts hunt the player, the rest are rejection
 * sampled around the yard. So a death replay cannot re-derive where the one
 * that killed you landed, it can only be told — and a recap of an
 * electrocution with the bolts somewhere else in the yard is worse than no
 * bolts at all. Four is generous: the storm fires every ~35s and the replay
 * window is 5s, so the killing strike is always the most recent entry.
 */
const REPLAY_KEY = 'lightning'
const STRIKE_MEMORY = 4
const recentStrikes: { id: number; points: Vector3[] }[] = []
let strikeSeq = 0

/** Where the next strike will land. Chosen when the sparks light, not later. */
const pendingPoints: Vector3[] = []
/** Seconds into the spark warning; -1 when nothing is being telegraphed. */
let warnClock = -1

/** One ground spark: its entity, its offset in the ring, and its own phase. */
interface Spark {
  e: Entity
  ox: number
  oz: number
  phase: number
  last: number
  /** Which atlas cell it is currently showing; -1 = nothing set yet. */
  cell: number
  /** Unit heading it crawls along, and how far it gets before re-seeding. */
  hx: number
  hz: number
  reach: number
  /** In-plane spin, so four atlas cells do not read as four repeated stamps. */
  spin: number
}

/**
 * Laid flat, face up. MeshRenderer.setPlane builds its quad standing in XY, so
 * a quarter turn about X drops it onto the ground plane.
 *
 * NOT billboarded, unlike the bolts. A billboard would stand the arc up to face
 * the camera, which is the one thing a spark crawling along the dirt must not
 * do - it would read as a wall of light rather than as electricity earthing.
 */
const SPARK_FLAT = Quaternion.fromEulerDegrees(-90, 0, 0)

const sparks: Spark[] = []

/**
 * Pick this strike's bolt points and remember them for the death replay.
 *
 * Called at the START of the warning, which is the whole point: once the
 * sparks are on the ground the strike is COMMITTED to those spots. A player who
 * walks out of the ring is safe, every time. Re-aiming after the telegraph
 * would make the warning a lie.
 */
function choosePoints(): void {
  pendingPoints.length = 0
  // The hunting bolts go FIRST, so they get the spot they want and the
  // random ones are the ones pushed aside by the separation rule.
  const hunting = LIGHTNING_HUNT_ENABLED && !isInvulnerable() ? LIGHTNING_HUNT_BOLTS : 0
  for (let i = 0; i < LIGHTNING_BOLT_COUNT; i++) {
    const aimed = i < hunting ? huntStrikePoint() : null
    pendingPoints.push(aimed ?? pickStrikePoint(pendingPoints))
  }
  const id = strikeSeq++
  recentStrikes.push({ id, points: pendingPoints.map((p) => Vector3.clone(p)) })
  if (recentStrikes.length > STRIKE_MEMORY) recentStrikes.shift()
  // Recorded HERE rather than at the strike, so a death recap replays the
  // sparks too - the warning is part of what happened to you. Ignored while
  // dead or replaying; see recordHazardEvent.
  recordHazardEvent(REPLAY_KEY, id)
}

/**
 * Show one of the atlas's four arcs, optionally mirrored.
 *
 * Four shapes and a flip is eight apparent variants, which is past the point
 * anyone counts them. UVs only, so a spark changes shape for free - no second
 * material, no second texture.
 */
function setSparkCell(sp: Spark, cell: number, flip: boolean): void {
  if (cell === sp.cell) return
  sp.cell = cell
  const g = LIGHTNING_SPARK_ATLAS_GRID
  const r = Math.floor(cell / g)
  const c = cell % g
  const a = flip ? (c + 1) / g : c / g
  const b = flip ? c / g : (c + 1) / g
  const v0 = (g - 1 - r) / g
  const v1 = (g - r) / g
  MeshRenderer.setPlane(sp.e, [a, v0, a, v1, b, v1, b, v0, a, v0, a, v1, b, v1, b, v0])
}

/** Somewhere random inside one bolt's lethal ring, spread evenly across it. */
function reseed(sp: Spark): void {
  // sqrt on the radius, or every spark crowds the centre: picking r uniformly
  // puts half of them inside the inner quarter of the area.
  const r = LIGHTNING_SPARK_RADIUS * Math.sqrt(Math.random())
  const a = Math.random() * Math.PI * 2
  sp.ox = Math.cos(a) * r
  sp.oz = Math.sin(a) * r
  // A fresh heading each time, so the ring keeps scattering rather than
  // every spark fleeing radially and leaving the middle empty.
  const h = Math.random() * Math.PI * 2
  sp.hx = Math.cos(h)
  sp.hz = Math.sin(h)
  sp.reach = LIGHTNING_SPARK_CRAWL * (0.45 + Math.random())
  sp.spin = Math.random() * 360
  const cells = LIGHTNING_SPARK_ATLAS_GRID * LIGHTNING_SPARK_ATLAS_GRID
  setSparkCell(sp, Math.floor(Math.random() * cells) % cells, Math.random() < 0.5)
}

/** Park every spark and put the ground glow back to its strike setting. */
function hideSparks(): void {
  for (const sp of sparks) VisibilityComponent.createOrReplace(sp.e, { visible: false })
  for (const l of impactLights) {
    const g = LightSource.getMutable(l)
    g.active = false
    g.intensity = LIGHTNING_IMPACT_INTENSITY
    g.range = LIGHTNING_IMPACT_RANGE
  }
}

/** Light the sparks on every point this strike has committed to. */
function seedSparks(): void {
  for (let b = 0; b < LIGHTNING_BOLT_COUNT && b < pendingPoints.length; b++) {
    // The impact light doubles as the warning glow: same lamp, dimmer and
    // tighter, sitting on the ground instead of at chest height. Reusing it
    // keeps this from adding four more lights to a scene already running eight.
    Transform.createOrReplace(impactLights[b], {
      position: Vector3.create(pendingPoints[b].x, 0.5, pendingPoints[b].z)
    })
    const g = LightSource.getMutable(impactLights[b])
    g.active = true
    g.intensity = 0
    g.range = LIGHTNING_WARN_LIGHT_RANGE
    for (let k = 0; k < LIGHTNING_SPARK_COUNT; k++) {
      const sp = sparks[b * LIGHTNING_SPARK_COUNT + k]
      reseed(sp)
      sp.last = 0
      VisibilityComponent.createOrReplace(sp.e, { visible: true })
    }
  }
}

/**
 * Crackle. Each spark hops, shrinks and re-seeds elsewhere in the ring, and the
 * whole thing quickens and brightens as the bolt closes in - so the telegraph
 * reads as "soon" and then as "NOW" without needing a countdown.
 *
 * Position and scale only, deliberately: fading the emissive would be a
 * Material write per spark per frame, and at BOLT_COUNT x SPARK_COUNT that is
 * 28 material updates every frame for something the scale already conveys.
 */
function updateSparks(t: number): void {
  const ramp = Math.min(1, t / LIGHTNING_WARN_SECONDS)
  const rate = LIGHTNING_SPARK_HZ * (0.6 + ramp)
  for (let b = 0; b < LIGHTNING_BOLT_COUNT && b < pendingPoints.length; b++) {
    const c = pendingPoints[b]
    const g = LightSource.getMutable(impactLights[b])
    g.intensity = LIGHTNING_WARN_LIGHT_INTENSITY * (0.2 + 0.8 * ramp) * (0.75 + Math.random() * 0.25)
    for (let k = 0; k < LIGHTNING_SPARK_COUNT; k++) {
      const sp = sparks[b * LIGHTNING_SPARK_COUNT + k]
      const life = (t * rate + sp.phase) % 1
      // Wrapped past the end of its little arc: jump somewhere else in the ring.
      if (life < sp.last) reseed(sp)
      sp.last = life
      const size = LIGHTNING_SPARK_SIZE * (1 - life * 0.75) * (0.6 + 0.4 * ramp)
      // Crawls OUT along its heading rather than up. Height is fixed: this is
      // current running over dirt, and any vertical travel turns it back into
      // an ember.
      const travel = life * sp.reach
      const tr = Transform.getMutable(sp.e)
      tr.position = Vector3.create(
        c.x + sp.ox + sp.hx * travel,
        LIGHTNING_SPARK_GROUND_Y,
        c.z + sp.oz + sp.hz * travel
      )
      tr.rotation = Quaternion.multiply(SPARK_FLAT, Quaternion.fromEulerDegrees(0, 0, sp.spin))
      tr.scale = Vector3.create(size, size, size)
    }
  }
}

/**
 * Start the telegraph. `points` null means the storm choosing for itself;
 * points given means a death replay putting the same warning back.
 */
function beginWarning(points: Vector3[] | null): void {
  if (!LIGHTNING_STRIKE_ENABLED) {
    // No bolts in this build, so there is nothing to stand clear of. Skip
    // straight to the flash and thunder, exactly as before the sparks existed.
    beginStrike([])
    return
  }
  if (points === null) {
    choosePoints()
  } else {
    pendingPoints.length = 0
    for (const p of points) pendingPoints.push(Vector3.clone(p))
  }
  warnClock = 0
  seedSparks()
}

/**
 * Fire the strike itself, on the points the warning already committed to.
 *
 * Everything downstream runs off strikeClock at fixed offsets, so this one call
 * reproduces the whole sequence - double flash, thunder, blackout, quake, the
 * flipbook - with nothing else to drive.
 */
function beginStrike(points: Vector3[]): void {
  strikeClock = 0
  if (!LIGHTNING_STRIKE_ENABLED) return
  // Short of a full set, the bolt loop below would index past the end. Cannot
  // happen from either caller today; cheaper to check than to debug.
  if (points.length < LIGHTNING_BOLT_COUNT) return

  strikePoints.length = 0
  for (const p of points) strikePoints.push(Vector3.clone(p))

  placeBolts()
  // A sky flash PER BOLT, each over its own point, so the yard is lit from the
  // directions the bolts are actually about to come down. One shared light
  // parked at the midpoint would point at open ground where nothing will land.
  for (let i = 0; i < LIGHTNING_BOLT_COUNT; i++) {
    Transform.createOrReplace(flashLights[i], {
      position: Vector3.create(strikePoints[i].x, 26, strikePoints[i].z)
    })
    Transform.createOrReplace(impactLights[i], {
      position: Vector3.create(strikePoints[i].x, 1.2, strikePoints[i].z)
    })
    // Hand the lamp back from warning duty: full strength and full reach, and
    // off until THUNDER_AT switches it on.
    const g = LightSource.getMutable(impactLights[i])
    g.active = false
    g.intensity = LIGHTNING_IMPACT_INTENSITY
    g.range = LIGHTNING_IMPACT_RANGE
  }
}

/** Everything a strike lit up, off. The replay's reset, and its own tidy-up. */
function endStrike(): void {
  strikeClock = -1
  warnClock = -1
  hideSparks()
  for (const l of flashLights) LightSource.getMutable(l).active = false
  showBolts(false)
  setImpactLights(false)
}

function lightningSystem(dt: number) {
  if (!gameStarted) return

  if (blackoutAlpha > 0) blackoutAlpha = Math.max(0, blackoutAlpha - dt * BLACKOUT_FADE_RATE)
  if (flashAlpha > 0) flashAlpha = Math.max(0, flashAlpha - dt / LIGHTNING_FLASH_SECONDS)

  if (strikeClock < 0) {
    // THE TELEGRAPH. Sparks on the ground for LIGHTNING_WARN_SECONDS, then the
    // bolt. The points were locked when the sparks lit, so this window is a
    // real chance to walk out of the ring rather than a decoration.
    if (warnClock >= 0) {
      warnClock += dt
      updateSparks(warnClock)
      if (warnClock >= LIGHTNING_WARN_SECONDS) {
        warnClock = -1
        hideSparks()
        beginStrike(pendingPoints)
      }
      return
    }
    nextStrike -= dt
    // NOT DURING A REPLAY. The recap fires its own strike off the recorded cue,
    // and the storm dropping a live one into the middle of the shot would put
    // bolts in it that were never there. The countdown keeps running, so the
    // strike that was due simply lands once the camera hands back.
    if (nextStrike <= 0 && !isPlayerDead && !replayIsPlaying()) beginWarning(null)
    return
  }

  const prev = strikeClock
  strikeClock += dt

  // double flash, at whatever LIGHTNING_SPEED makes of it: on, off, on again
  const flashOn = strikeClock < FLASH_A_END || (strikeClock >= FLASH_B_START && strikeClock < FLASH_B_END)
  for (const l of flashLights) {
    const f = LightSource.getMutable(l)
    if (f.active !== flashOn) f.active = flashOn
  }

  // the CRACK: sound + instant black + rumble, and the bolt actually lands.
  // Every strike sounds a little different: distance (0..1) picks how
  // loud/deep/hard-hitting this one is.
  if (prev < THUNDER_AT && strikeClock >= THUNDER_AT) {
    const closeness = Math.random() // 0 = far-off roll, 1 = right overhead
    const volume = 0.22 + closeness * 0.26 // ~35% average, 22%-48% span
    const pitch = 0.75 + Math.random() * 0.4 // deep grumble ... sharp crack
    playSoundAt(THUNDER_CLAPS[thunderIndex], playerPosition, volume, pitch)
    thunderIndex = (thunderIndex + 1) % THUNDER_CLAPS.length
    blackoutAlpha = BLACKOUT_PEAK * (0.6 + closeness * 0.4)
    // Near strikes wash out harder than distant ones, same as the blackout.
    flashAlpha = LIGHTNING_FLASH_PEAK * (0.55 + closeness * 0.45)
    // Scaled by proximity, same as the flash: a strike across the yard should
    // register as a tremor, one beside you as a jolt.
    if (THUNDER_SHAKES_GROUND) {
      // BOTH, on purpose. The quake slides the scenery and the shake kicks the
      // view — together they read as one impact that moved the ground and the
      // player standing on it. Either alone still works, which is what makes
      // cameraShake's ENABLED switch a safe thing to flip.
      //
      // FIREBALL-GRADE, deliberately. The module is the same one the Voronoi
      // fireball arena used, but that scene drove it at 0.55..1.0 over 0.42..0.6s
      // and this one was asking for 0.35..0.95 over a flat 0.32s — barely half the
      // energy, which is why the same code read as a twitch here and as a hit
      // there. Distant rolls still only tremor; an overhead bolt now lands.
      const shook = shakeCamera(0.55 + closeness * 0.45, 0.42 + closeness * 0.18)
      // THE QUAKE SIZES ITSELF TO WHAT THE CAMERA DID. When the shake takes the
      // view, the quake is the supporting half of one impact and stays subtle —
      // both at full strength is mush. When the shake DECLINES, which happens on
      // any client that reports the camera at the avatar's head (see
      // cameraShake.ts — declining is what stops the view snapping into the
      // avatar), the quake is the only thing left and has to carry the hit on
      // its own. Sliding the whole world cannot zoom, so it can afford to.
      startQuake(QUAKE_TIME, QUAKE_AMPLITUDE * (0.45 + closeness * 0.8) * (shook ? 1 : 3.2))
    }

    if (LIGHTNING_STRIKE_ENABLED) {
      setAllBoltFrames(0)
      showBolts(true)
      setImpactLights(true)
      // isInvulnerable() covers the respawn grace and the camera-lock preview
      // — the player must never be killed by the sky during a window where
      // they cannot move themselves out of it.
      drawStrikeVolumes()
      if (!isInvulnerable() && playerInStrike()) killPlayer('Struck by lightning')
    }
  }

  // Step the flipbook while the bolt is up. One pass, no loop: the atlas
  // already ends on an empty frame, so the strike dies on its own schedule
  // rather than being cut off by the hide below.
  if (LIGHTNING_STRIKE_ENABLED && strikeClock >= THUNDER_AT && strikeClock < THUNDER_AT + BOLT_SECONDS) {
    const total = LIGHTNING_FLIPBOOK_GRID * LIGHTNING_FLIPBOOK_GRID
    const t = (strikeClock - THUNDER_AT) / BOLT_SECONDS
    setAllBoltFrames(Math.min(total - 1, Math.floor(t * total)))
  }

  if (LIGHTNING_STRIKE_ENABLED && prev < THUNDER_AT + BOLT_SECONDS && strikeClock >= THUNDER_AT + BOLT_SECONDS) {
    showBolts(false)
    setImpactLights(false)
  }

  if (strikeClock > STRIKE_SETTLE) {
    strikeClock = -1
    // Straight through: the configured number IS the quiet gap, and the spark
    // warning that follows it is extra. See LIGHTNING_STRIKE_INTERVAL_MIN.
    nextStrike =
      LIGHTNING_STRIKE_INTERVAL_MIN +
      Math.random() * (LIGHTNING_STRIKE_INTERVAL_MAX - LIGHTNING_STRIKE_INTERVAL_MIN)
    if (LIGHTNING_STRIKE_ENABLED) {
      showBolts(false)
      setImpactLights(false)
    }
  }
}

export function initLightning() {
  // EVERYTHING IS BUILT ONCE, PER BOLT, AND RE-POSED PER STRIKE. Nothing here
  // is created or destroyed while the storm runs: entity churn on a timer is
  // exactly the pattern that leaves a client with orphaned lights, and these
  // are 40000-intensity lights.
  for (let i = 0; i < LIGHTNING_BOLT_COUNT; i++) {
    // A huge cold light high over the plot, moved over this bolt's strike
    // point. Inactive except during the double flash.
    const flash = engine.addEntity()
    Transform.create(flash, { position: Vector3.create(16, 26, 16) })
    LightSource.create(flash, {
      type: LightSource.Type.Point({}),
      active: false,
      color: Color3.create(0.8, 0.85, 1.0),
      intensity: 40000,
      range: 60,
      shadow: false
    })
    flashLights.push(flash)
  }

  if (LIGHTNING_STRIKE_ENABLED) {
    for (let i = 0; i < LIGHTNING_BOLT_COUNT; i++) {
      // Ground flash at the point of impact — brief, and much tighter than the
      // sky flash, so each strike reads as having a location.
      const impact = engine.addEntity()
      Transform.create(impact, { position: Vector3.create(0, 1.2, 0) })
      LightSource.create(impact, {
        type: LightSource.Type.Point({}),
        active: false,
        color: LIGHTNING_COLOR,
        intensity: LIGHTNING_IMPACT_INTENSITY,
        range: LIGHTNING_IMPACT_RANGE,
        shadow: false
      })
      impactLights.push(impact)

      // Billboarded on Y so the bolt always presents its face to the player —
      // a flat card seen edge-on would vanish, and strikes land anywhere
      // around them. Parked underground until a strike poses it.
      const bolt = engine.addEntity()
      Transform.create(bolt, { position: Vector3.create(0, -50, 0) })
      MeshRenderer.setPlane(bolt)
      Material.setPbrMaterial(bolt, {
        texture: Material.Texture.Common({ src: LIGHTNING_FLIPBOOK }),
        alphaTexture: Material.Texture.Common({ src: LIGHTNING_FLIPBOOK }),
        emissiveTexture: Material.Texture.Common({ src: LIGHTNING_FLIPBOOK }),
        emissiveColor: LIGHTNING_COLOR,
        emissiveIntensity: LIGHTNING_BOLT_EMISSIVE,
        transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
        specularIntensity: 0,
        metallic: 0,
        roughness: 1,
        castShadows: false
      })
      Billboard.create(bolt, { billboardMode: BillboardMode.BM_Y })
      VisibilityComponent.create(bolt, { visible: false })
      bolts.push(bolt)
      boltFrames.push(-1)
    }
  }

  // THE SPARKS. Built once, parked, re-posed per warning - the same rule as the
  // bolts and the lights above: nothing here is created or destroyed while the
  // storm runs. Untextured on purpose; a flat emissive quad in the bolt's own
  // colour costs no texture slot, and the scene is already at 38 of about 40.
  for (let i = 0; i < LIGHTNING_BOLT_COUNT * LIGHTNING_SPARK_COUNT; i++) {
    const e = engine.addEntity()
    Transform.create(e, {
      position: Vector3.create(0, -50, 0),
      scale: Vector3.create(LIGHTNING_SPARK_SIZE, LIGHTNING_SPARK_SIZE, LIGHTNING_SPARK_SIZE)
    })
    MeshRenderer.setPlane(e)
    Material.setPbrMaterial(e, {
      texture: Material.Texture.Common({ src: LIGHTNING_SPARK_TEXTURE }),
      // alphaTexture as well as texture, and the SAME file: the arc is a shape
      // cut out of a transparent square, so without this the quad shows as a
      // glowing tile instead of a bolt. Same pairing the bolt flipbook uses.
      alphaTexture: Material.Texture.Common({ src: LIGHTNING_SPARK_TEXTURE }),
      emissiveTexture: Material.Texture.Common({ src: LIGHTNING_SPARK_TEXTURE }),
      albedoColor: Color4.create(1, 1, 1, 1),
      emissiveColor: LIGHTNING_COLOR,
      emissiveIntensity: LIGHTNING_SPARK_EMISSIVE,
      transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
      specularIntensity: 0,
      metallic: 0,
      roughness: 1,
      castShadows: false
    })
    VisibilityComponent.create(e, { visible: false })
    sparks.push({
      e,
      ox: 0,
      oz: 0,
      phase: Math.random(),
      last: 0,
      cell: -1,
      hx: 1,
      hz: 0,
      reach: LIGHTNING_SPARK_CRAWL,
      spin: 0
    })
  }

  // THE STORM'S HANDLE FOR THE DEATH REPLAY. One actor, not one per bolt: a
  // strike is a single event that lands every bolt at once, and the payload is
  // which strike (see recentStrikes).
  registerReplayActor(REPLAY_KEY, {
    reset: endStrike,
    fire: (id: number) => {
      const remembered = recentStrikes.find((r) => r.id === id)
      // Nothing rather than something wrong. If the strike has aged out of the
      // ring (it cannot in practice — see STRIKE_MEMORY) a fresh set of points
      // would put bolts in a part of the yard the player never stood in and
      // present it as a recording.
      if (remembered === undefined || remembered.points.length !== LIGHTNING_BOLT_COUNT) return
      // beginWarning, not beginStrike: the sparks were part of what the player
      // saw, so the recap shows the telegraph and then the bolt.
      beginWarning(remembered.points)
    }
  })

  addSafeSystem(lightningSystem, 'lightningSystem')
}
