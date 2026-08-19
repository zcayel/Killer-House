/**
 * LIGHTNING — the storm outside, and it hits the ground.
 *
 * Every ~35s a strike fires. LIGHTNING_BOLT_COUNT points are picked around the
 * yard, the sky double-flashes over them, and a beat later the bolts land
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
 * rather than weather. The warning is the flash instead: a sky light per bolt
 * is moved OVER its strike point before it fires, so for THUNDER_AT seconds the
 * yard is lit from the directions the bolts are about to come down. That is a
 * real cue and it costs nothing, but it is subtler than a drawn ring, so this
 * death is now less forgiving than it was. LIGHTNING_KILL_RADIUS is the knob
 * if it turns out to be too harsh in testing.
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
import { Vector3, Color3 } from '@dcl/sdk/math'
import { gameStarted, isPlayerDead, killPlayer, isInvulnerable } from './gameState'
import { playerPosition } from './playerTracker'
import { playSoundAt } from './sounds'
import { cameraShake } from './effects/deathEffects'
import { addSafeSystem } from './safeSystem'
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
  LIGHTNING_STRIKE_INTERVAL_MIN,
  LIGHTNING_STRIKE_INTERVAL_MAX,
  LIGHTNING_FLASH_SECONDS,
  LIGHTNING_FLASH_PEAK,
  LIGHTNING_COLOR,
  LIGHTNING_BOLT_EMISSIVE,
  LIGHTNING_IMPACT_INTENSITY,
  LIGHTNING_IMPACT_RANGE
} from './config'

export const SOUND_THUNDER = 'assets/sounds/thunder.wav' // CC0, freesound #243614 (trimmed)

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
// THUNDER_AT is the one with gameplay attached: it is the player's window to
// walk out of the lethal ring after the sky flashes. At 1.35x it drops from
// 0.9s to 0.67s, which is still enough to move but is genuinely less forgiving.
// If lightning deaths start reading as unfair in testing, this is the number to
// look at first (or widen the telegraph another way — LIGHTNING_KILL_RADIUS).
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
const THUNDER_SHAKES_CAMERA = true
const SHAKE_SECONDS = 1.0 / LIGHTNING_SPEED
const SHAKE_AMPLITUDE = 0.45

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

/** Is the player standing in ANY of this strike's lethal rings — and outside the house, which is always shelter? */
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

function lightningSystem(dt: number) {
  if (!gameStarted) return

  if (blackoutAlpha > 0) blackoutAlpha = Math.max(0, blackoutAlpha - dt * BLACKOUT_FADE_RATE)
  if (flashAlpha > 0) flashAlpha = Math.max(0, flashAlpha - dt / LIGHTNING_FLASH_SECONDS)

  if (strikeClock < 0) {
    nextStrike -= dt
    if (nextStrike <= 0 && !isPlayerDead) {
      strikeClock = 0
      if (LIGHTNING_STRIKE_ENABLED) {
        // Fresh points for every bolt, each kept LIGHTNING_MIN_SEPARATION clear
        // of the ones already drawn for this same strike.
        strikePoints.length = 0
        for (let i = 0; i < LIGHTNING_BOLT_COUNT; i++) strikePoints.push(pickStrikePoint(strikePoints))
        placeBolts()
        // A sky flash PER BOLT, each over its own point, so the yard is lit
        // from the directions the bolts are actually about to come down. One
        // shared light parked at the midpoint would point at open ground where
        // nothing is going to land — worse than no cue, since the flash is the
        // only warning there is now the target ring is gone.
        for (let i = 0; i < LIGHTNING_BOLT_COUNT; i++) {
          Transform.createOrReplace(flashLights[i], {
            position: Vector3.create(strikePoints[i].x, 26, strikePoints[i].z)
          })
          Transform.createOrReplace(impactLights[i], {
            position: Vector3.create(strikePoints[i].x, 1.2, strikePoints[i].z)
          })
        }
      }
    }
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
    playSoundAt(SOUND_THUNDER, playerPosition, volume, pitch)
    blackoutAlpha = BLACKOUT_PEAK * (0.6 + closeness * 0.4)
    // Near strikes wash out harder than distant ones, same as the blackout.
    flashAlpha = LIGHTNING_FLASH_PEAK * (0.55 + closeness * 0.45)
    if (THUNDER_SHAKES_CAMERA) cameraShake(SHAKE_SECONDS, SHAKE_AMPLITUDE * (0.5 + closeness * 0.7), true)

    if (LIGHTNING_STRIKE_ENABLED) {
      setAllBoltFrames(0)
      showBolts(true)
      setImpactLights(true)
      // isInvulnerable() covers the respawn grace and the camera-lock preview
      // — the player must never be killed by the sky during a window where
      // they cannot move themselves out of it.
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

  addSafeSystem(lightningSystem, 'lightningSystem')
}
