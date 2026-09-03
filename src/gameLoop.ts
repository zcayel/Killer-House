/**
 * THE RITUAL ROUND — the core game loop (replaces the quest for now).
 *
 * Every connected player has their OWN full copy of the CANDLE_POOL
 * stations, nudged apart by a small per-owner offset (CANDLE_OFFSET_BUCKETS
 * in config.ts) so two players working the "same" spot aren't standing
 * inside each other. Each round, each player's OWN pool
 * independently draws a random subset of RITUAL_CANDLES_REQUIRED to be
 * "active" — this just controls how many candles are actually live at once
 * (pacing/spread).
 *
 * YOUR CANDLES ARE YOUR OWN — ALL OF THEM, ALWAYS. You can only ever light
 * your own stations, and now you can only ever SEE your own: another
 * player's candle is never drawn on your screen in any state, burning or
 * dark. So one player's ritual can never take a location away from
 * another's, and two players working the same spot are simply working two
 * different candles that neither of them can see the other half of.
 *
 * That collapses the reading rule to a single line, which is the whole of
 * what a player has to understand about candles:
 *   - EVERY CANDLE YOU CAN SEE IS YOURS. Dark means you still have to light
 *     it; lit means you already did. Nothing on screen belongs to anyone
 *     else, so there is never a candle in front of you that quietly ignores
 *     your hold, and never a flame that looks like progress you didn't make.
 *
 * (This replaced a shared-flames rule where other players' LIT candles were
 * drawn — Week 2 testers couldn't tell whose candles were whose, and a
 * neighbour's flame at the same cluster point read either as an objective
 * already done or as one refusing to respond. Their light was pretty; it
 * cost more than it was worth.)
 *
 * The fairness guarantee falls straight out of that: the
 * RITUAL_CANDLES_REQUIRED stations I draw for myself stay standing for my
 * whole round, and I am the only client that can write to any of them, so I
 * always have exactly enough candles to finish no matter what everybody else
 * does.
 *
 * WIN:      light all RITUAL_CANDLES_REQUIRED of your own candles, then WALK
 *           TO THE PORTAL in the back yard and step into it. Nothing wins the
 *           round for you — the portal opening is the last objective, not the
 *           ending. You are invulnerable from the moment it appears, so the
 *           walk is a victory lap, not another gauntlet.
 * DEFEATED: lose all ROUND_HEARTS (every death costs one), or the timer runs
 *           out. Hearts stop counting against you once the portal is up (you
 *           can't die then anyway), but the CLOCK does not — dawdling on the
 *           way to the exit can still lose the round.
 *
 * Lighting a candle is a CHANNEL: walk within range of any unlit active
 * candle (they are all yours) and HOLD the interact button (left click
 * on PC; the mobile client's own on-screen interact button — both map to
 * IA_POINTER) for CANDLE_CHANNEL_SECONDS while the progress bar fills. No
 * aiming at the candle is needed — proximity alone picks which one, holding
 * alone decides whether it advances. Letting go, walking out of range, or
 * dying cancels the channel outright (the fill resets, it does not pause).
 * The timer pauses while you're dead (the death screen already costs you a
 * heart and the walk back).
 *
 * Both endings show a full-screen verdict, then the round resets itself:
 * candles snuffed, a fresh random subset drawn, hearts refilled, timer
 * rewound, player back at the gate. Weapons are free — all knives are in
 * hand from the first second.
 */

import {
  engine,
  Transform,
  GltfContainer,
  MeshRenderer,
  Billboard,
  BillboardMode,
  MeshCollider,
  Material,
  MaterialTransparencyMode,
  ColliderLayer,
  LightSource,
  VisibilityComponent,
  ParticleSystem,
  InputAction,
  inputSystem,
  PointerEventType,
  pointerEventsSystem,
  InputModifier,
  VirtualCamera,
  MainCamera,
  raycastSystem,
  RaycastQueryType,
  Entity
} from '@dcl/sdk/ecs'
import { Vector3, Color3, Color4, Quaternion } from '@dcl/sdk/math'
import { movePlayerTo } from '~system/RestrictedActions'
import {
  CANDLE_POOL,
  SECOND_FLOOR_MIN_Y,
  CANDLE_OFFSET_BUCKETS,
  RITUAL_CANDLES_REQUIRED,
  RITUAL_CANDLES_ROUND1,
  RITUAL_CANDLE_SCALE,
  CANDLE_SHADOWS_ENABLED,
  CANDLE_FLICKER_RATE,
  CANDLE_FLICKER_JITTER_RATE,
  CANDLE_FLICKER_DEPTH,
  CANDLE_SMOKE_ENABLED,
  CANDLE_SMOKE_TEXTURE,
  CANDLE_SMOKE_HEIGHT,
  CANDLE_SMOKE_RATE,
  CANDLE_SMOKE_MAX,
  CANDLE_SMOKE_LIFETIME,
  CANDLE_SMOKE_RISE,
  CANDLE_SMOKE_CONE_ANGLE,
  CANDLE_SMOKE_CONE_RADIUS,
  CANDLE_SMOKE_SIZE_START,
  CANDLE_SMOKE_SIZE_END,
  CANDLE_SMOKE_ALPHA,
  CANDLE_HOVER_MAX_DISTANCE,
  ROUND_SECONDS,
  ROUND_HEARTS,
  CANDLE_CHANNEL_SECONDS,
  CHANNEL_MAX_DISTANCE,
  DEFEAT_RESET_SECONDS,
  WIN_RESET_SECONDS,
  CANDLE_GLOW_INTENSITY,
  CANDLE_GLOW_RANGE,
  CHANNEL_GLOW_MAX_INTENSITY,
  CHANNEL_GLOW_RANGE,
  CANDLE_CORE_GLOW_INTENSITY,
  CANDLE_CORE_GLOW_RANGE,
  MODEL_CANDLE_UNLIT,
  MODEL_CANDLE_LIT,
  PORTAL_POSITION,
  PORTAL_ENTRY_DELAY_SECONDS,
  PORTAL_RADIUS,
  PORTAL_HEIGHT_OFFSET,
  PORTAL_COLOR,
  PORTAL_VORTEX_TEXTURE,
  PORTAL_SPIN_SPEED,
  PORTAL_DISC_SCALE,
  PORTAL_GLOW_INTENSITY,
  PORTAL_GLOW_RANGE,
  LAST_CANDLE_PREVIEW_SECONDS,
  LAST_CANDLE_STUCK_SECONDS,
  LAST_CANDLE_PREVIEW_BACK,
  LAST_CANDLE_PREVIEW_UP,
  LAST_CANDLE_PREVIEW_TRANSITION_SECONDS,
  LAST_CANDLE_PREVIEW_MIN_DIST,
  LAST_CANDLE_PREVIEW_TURN_DEGREES,
  SPAWN_POSITION,
  SPAWN_ROTATION,
  VICTORY_CINEMATIC_HOLD_SECONDS
} from './config'
import { gameStarted, isPlayerDead, onPlayerDeath, setQuestInvulnerable, grantSpawnGrace, setCameraLockInvulnerable,
  lastDeathCause
} from './gameState'
import { playerPosition } from './playerTracker'
import { knifeCollected } from './quest'
import { clearDeathReplay, deathCamActive } from './effects/deathCam'
import { playSoundAt, SOUND_CANDLE_LIGHT, SOUND_CANDLE_LIGHTING_START, SOUND_PORTAL_APPEAR, SOUND_VICTORY } from './sounds'
import {
  startVictoryCinematic,
  endVictoryCinematic,
  victoryCinematicHolding
} from './effects/victoryCinematic'
import {
  updateMyBestTime,
  readRemoteStats,
  bus,
  createMyCandleStations,
  myCandleStations,
  setMyStationLit,
  setMyStationsForRound,
  myOffsetBucketIndex
} from './multiplayer'
import { persistedScores, recordDeath, submitScore } from './scores'
import { setSkeletonsForRound } from './enemies/skeletons'
import { pushToast } from './notifications'
import { getPlayer } from '@dcl/sdk/players'
import { addSafeSystem } from './safeSystem'

// Reverted: a (1.0, 0.62, 0.30) @ 700 pass was tried and made things worse
// (read as the wax glowing rather than the flame), not better — this
// original value was confirmed as the correct look.
const FLAME_COLOR = Color3.create(1.0, 0.72, 0.42)
const CANDLE_BODY_HEIGHT = 0.32 // wick height on the model — where the flame sits (pre-scale)
// The point light was sitting exactly AT the wick — i.e. right against the
// top of the wax — so at close range its falloff blew out the wax surface
// into looking lit/emissive itself (reported as "the wax is glowing"). A
// candle has three parts (wax, wick, flame) and only the flame should read
// as a light source. Lifting the light up into where the flame tip actually
// is moves it away from the wax without touching CANDLE_GLOW_INTENSITY/RANGE
// (the room-filling "radius light" that was already confirmed as the wanted
// look) — same room light, no more wax hot-spot.
const FLAME_LIGHT_HEIGHT = CANDLE_BODY_HEIGHT + 0.15

type RoundPhase = 'playing' | 'won' | 'defeated'

export let roundPhase: RoundPhase = 'playing'
export let defeatReason: 'hearts' | 'time' = 'hearts'
export let phaseCountdown = 0 // seconds left on the win/defeat screen
export let hearts = ROUND_HEARTS
export let candlesLit = 0
export let roundRemaining = ROUND_SECONDS
export let roundDeaths = 0

/**
 * THE DEATH RECAP — one entry per death this round, in the order they happened.
 *
 * The defeat screen used to name only the LAST death (defeatSubline), so a run
 * that ended three hearts down told you about one of them. Which trap kept
 * getting you is exactly the thing a player needs to know to do better next
 * time, and it is the one thing the game never said.
 *
 * Recorded here rather than in the UI because gameLoop already owns the round
 * clock and the area tracking, and a recap without WHEN and WHERE is just the
 * same sentence three times.
 */
export interface DeathRecord {
  /** As passed to killPlayer(), e.g. 'Killed by the swinging axe'. */
  cause: string
  /** Seconds remaining on the round clock at the moment it happened. */
  atRemaining: number
  /** How far in you had got, by the same labels the defeat line uses. */
  area: string
}
export const deathLog: DeathRecord[] = []
export let lastWinSeconds = 0 // how long the winning ritual took
export let lastWinWasBest = false // did the latest win beat the previous personal best?
export let lastWinDelta = 0 // latest win time minus previous best (negative = faster); 0 on first win
export const bestWinTimes: number[] = [] // fastest rituals, ascending, top 5
/**
 * Hearts left on the run that set bestWinTimes[0] — NOT the most hearts ever.
 * Kept in step with that one entry so a board row always describes one escape.
 * -1 until a first win, matching the "not recorded" convention in scores.ts.
 */
export let bestWinHearts = -1
/**
 * Is the full win screen being held back for the victory cinematic?
 *
 * OWNED HERE RATHER THAN READ STRAIGHT OFF victoryCinematicHolding, because
 * this one flag decides two things that must never disagree: whether ui.tsx
 * draws the win overlay, and whether the reset countdown below is ticking. If
 * the UI held and the clock ran, the round would reset behind a screen the
 * player never saw.
 *
 * It also carries a DEAD MAN'S SWITCH. addSafeSystem contains a throwing
 * system by swallowing its error and calling it again next frame (see
 * safeSystem.ts) — so a victoryCinematic that starts and then throws every
 * frame would leave victoryCinematicHolding stuck true forever, with no win
 * screen, no countdown and no way to start another round. Holding on OUR OWN
 * clock instead means the worst that failure can do is cost the player a shot
 * they were going to see anyway.
 */
export let winScreenHeld = false
let winHoldSeconds = 0
/**
 * How long past the cinematic's own hold this will keep waiting before it stops
 * believing it. Four seconds is far longer than any legitimate overshoot (the
 * hold is a fixed timer, not a wait on anything) and far shorter than a player
 * would sit staring at a frozen screen.
 */
const WIN_HOLD_CEILING = VICTORY_CINEMATIC_HOLD_SECONDS + 4

export let portalReady = false
export let portalOpenSeconds = 0
let roundNumber = 1 // 1 = first round (5 candles), 2+ = standard (7 candles)

export interface RankEntry {
  name: string
  bestTime: number
  /** Hearts left on the run that set bestTime. -1 = not recorded. */
  hearts: number
  me: boolean
}

/**
 * Fastest valid escape times, ranked across every player who has ever escaped.
 *
 * This is THE competitive score, and it is fed from THREE places now, in
 * descending order of durability:
 *
 *   1. persistedScores() — the all-time board, read back from the database in
 *      scores.ts. This is the only source that survives everyone leaving the
 *      scene; before it existed the board reset itself every time the room
 *      went cold, which is the whole bug this merge exists to fix.
 *   2. bestWinTimes[0] — my best THIS SESSION. Kept as a source even though a
 *      submitted run also lands in (1), because the submit is asynchronous and
 *      guests never submit at all: without this, your own record would vanish
 *      off the board for the seconds between escaping and the round trip
 *      landing, which reads as the game losing your run.
 *   3. readRemoteStats() — everyone standing here right now, over syncEntity.
 *      Live but session-scoped; a stranger's record shows up the instant they
 *      set it rather than at the next 90-second refresh.
 *
 * DEDUPED BY NAME, not by address. The persisted rows carry an address and the
 * live ones cannot — PlayerStats is a synced component, not a player entity,
 * so there is no address on it to match against. Names are what the board
 * draws anyway, so a collision here shows the same text twice with one time
 * rather than something wrong. The database keys on address regardless, so the
 * stored data never duplicates; this is only about what one client renders.
 *
 * Used by the win overlay in ui.tsx and the physical board in leaderboard.ts.
 */
export function escapeRanking(): RankEntry[] {
  const player = getPlayer()
  const myName = player?.name ?? 'You'
  const myAddress = (player?.userId ?? '').toLowerCase()

  const byName = new Map<string, RankEntry>()

  /** Fold one time in, keeping the fastest and never downgrading a `me` flag. */
  function add(name: string, bestTime: number, hearts: number, mine: boolean): void {
    if (bestTime <= 0) return
    const key = name.toLowerCase()
    const prev = byName.get(key)
    if (prev === undefined) {
      byName.set(key, { name, bestTime, hearts, me: mine })
      return
    }
    // Hearts travel WITH the time they belong to — replaced together or not at
    // all, so a row never mixes two runs.
    if (bestTime < prev.bestTime) {
      prev.bestTime = bestTime
      prev.hearts = hearts
    }
    prev.me = prev.me || mine
  }

  for (const s of persistedScores()) {
    add(s.name, s.bestTime, s.hearts, myAddress !== '' && s.address === myAddress)
  }
  if (bestWinTimes.length > 0) add(myName, bestWinTimes[0], bestWinHearts, true)
  // PlayerStats carries no hearts, so a player visible only as a live in-room
  // peer reports them as unrecorded rather than inventing a number. In practice
  // they are almost always in the persisted list too, which does carry hearts.
  for (const o of readRemoteStats()) add(o.name, o.bestTime, -1, false)

  const ranking: RankEntry[] = []
  byName.forEach((entry) => ranking.push(entry))
  ranking.sort((a, b) => a.bestTime - b.bestTime)
  return ranking
}

// the active lighting channel (null = not lighting anything)
export let channelProgress: number | null = null
let channelTarget: { station: Entity; root: Entity } | null = null
let channelGlow: Entity | null = null

/** Build-up glow on the candle itself while holding — grows with progress, so the candle answers "is this working" without the player needing to check the HUD. */
function updateChannelGlow(root: Entity, progress: number) {
  if (channelGlow === null) {
    channelGlow = engine.addEntity()
    Transform.create(channelGlow, { position: Vector3.create(0, FLAME_LIGHT_HEIGHT * RITUAL_CANDLE_SCALE, 0), parent: root })
    LightSource.create(channelGlow, {
      type: LightSource.Type.Point({}),
      active: true,
      color: FLAME_COLOR,
      intensity: 0,
      range: CHANNEL_GLOW_RANGE,
      shadow: false
    })
  }
  LightSource.getMutable(channelGlow).intensity = CHANNEL_GLOW_MAX_INTENSITY * Math.min(1, progress)
}

function clearChannelGlow() {
  if (channelGlow !== null) {
    engine.removeEntity(channelGlow)
    channelGlow = null
  }
}

/** Local render state for one of MY candle stations — keyed by its CandleStation entity. */
interface RenderedStation {
  station: Entity // the multiplayer.ts CandleStation entity this mirrors
  root: Entity
  body: Entity
  targetable: boolean // PointerEvents currently registered on the body — i.e. drawn, unlit, and wearing the hover outline
  glow: Entity | null // wide room-fill point-light, only exists while lit
  coreGlow: Entity | null // tight, brighter halo right at the flame, only exists while lit
  shown: boolean // what the LOCAL visuals currently show — compared each frame against the station's state
  visibleAsLit: boolean
  flickerPhase: number // per-candle random offset so lit candles don't all pulse in lockstep
  smoke: Entity | null // wisp above the flame; built once and toggled, never destroyed (see buildSmoke)
}

// My own stations, and only mine (created in initGameLoop) — no other
// player's candle is ever drawn, so nothing else can end up in here. Visuals
// are built on first sight and then just kept in sync every frame; see
// syncStationVisuals().
const rendered = new Map<Entity, RenderedStation>()

export function getCandlesRequired(): number {
  return roundNumber === 1 ? RITUAL_CANDLES_ROUND1 : RITUAL_CANDLES_REQUIRED
}

function shuffledIndices(n: number): number[] {
  const arr: number[] = []
  for (let i = 0; i < n; i++) arr.push(i)
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

/**
 * (Re)draws which of MY OWN 13 stations are active this round. Draws from
 * the full CANDLE_POOL — every entry is hand-vetted (see the comments on
 * CANDLE_POOL in config.ts). An earlier version of this function ran a
 * raycast probe to auto-detect buried/floating spots, but the house's
 * visible meshes carry zero collision (visibleMeshesCollisionMask: 0 on the
 * house GltfContainer, dh_new.glb) — the probe could only ever hit the coarse
 * invisible collision proxy, which doesn't track each room's real floor
 * height closely enough to judge "buried" reliably. It reported all 13 spots
 * unreachable on every single round, always fell back to the full pool
 * anyway, and just added log noise — removed rather than kept fighting a
 * check that can't work against this asset's collision setup. If a specific
 * CANDLE_POOL entry turns out to be genuinely bad, fix that one coordinate
 * directly.
 *
 * Entries flagged `guaranteed: true` in CANDLE_POOL are seeded first so they're
 * in EVERY round's draw, on request; the rest of `needed` is filled randomly
 * from everything else.
 *
 * The SECOND FLOOR is seeded the same way but as a TIER rather than a fixed
 * spot: one upstairs candle is guaranteed every round, picked at random from
 * whichever pool entries are up there. Pinning one entry with `guaranteed`
 * would have worked too, but it would put the same candle in the same corner
 * every single game — this keeps the floor certain and the spot varied.
 */
function assignRitualCandles() {
  const needed = getCandlesRequired()
  const guaranteed = CANDLE_POOL.reduce<number[]>((acc, spot, idx) => {
    if (spot.guaranteed) acc.push(idx)
    return acc
  }, [])
  // Seed the upstairs unless a `guaranteed` entry is already up there, so the
  // two rules can never spend two of `needed` on the same requirement.
  const seeded = guaranteed.slice()
  const alreadyUpstairs = guaranteed.some((i) => CANDLE_POOL[i].pos.y >= SECOND_FLOOR_MIN_Y)
  if (!alreadyUpstairs) {
    const upstairs = shuffledIndices(CANDLE_POOL.length).filter(
      (i) => CANDLE_POOL[i].pos.y >= SECOND_FLOOR_MIN_Y && !seeded.includes(i)
    )
    if (upstairs.length > 0) seeded.push(upstairs[0])
  }

  const remaining = shuffledIndices(CANDLE_POOL.length).filter((i) => !seeded.includes(i))
  const activeIndices = new Set([...seeded, ...remaining].slice(0, needed))

  // Owner-only write (see multiplayer.ts) — sets which of MY stations are
  // active this round and snuffs all of mine back out. syncStationVisuals()
  // picks the change up on the next frame the same way it picks up any
  // station state. These `needed` stations of mine now stay standing for my
  // whole round, and no other client can write to them, which is what
  // guarantees I always have enough candles to finish regardless of what
  // everyone else is doing.
  setMyStationsForRound(activeIndices)

  // The yard scales with the round too: one skeleton for the 5-candle
  // introduction, two from the 7-candle round on. Pushed rather than pulled —
  // see setSkeletonsForRound for why skeletons.ts must not import this module.
  setSkeletonsForRound(needed)
}

// PBParticleSystem's BlendMode and SimulationSpace are `const enum`s in the
// SDK's generated protobuf types. Const enums do not survive every TS build
// configuration intact, and this project compiles through the Creator Hub's
// toolchain rather than a tsconfig anyone here controls — so the wire values
// are written out instead of imported, the same way CAMERA_TYPE_THIRD_PERSON is
// in effects/deathEffects.ts. Shape has a real helper (ParticleSystem.Shape),
// so that one is used properly below.
const PS_BLEND_ALPHA = 0 // PBParticleSystem_BlendMode.PSB_ALPHA
const PS_SPACE_WORLD = 1 // PBParticleSystem_SimulationSpace.PSS_WORLD

/**
 * The wisp of smoke above a candle's flame.
 *
 * BUILT ONCE PER CANDLE AND THEN ONLY TOGGLED — unlike the two lights, which
 * are created and destroyed on every light/snuff. Two reasons it has to work
 * that way round:
 *
 *   - Destroying an emitter kills the particles already in the air with it, so
 *     snuffing a candle would make its smoke vanish in the same frame as the
 *     flame. Setting active=false stops NEW particles while the ones already
 *     rising finish their lifetime, which is what smoke does when a flame goes
 *     out.
 *   - A round snuffs and relights the whole pool. Churning a particle system
 *     that often is exactly the kind of per-round entity traffic this scene has
 *     already been burned by on the mobile client.
 *
 * simulationSpace is WORLD so a puff, once emitted, stays where the air left
 * it instead of being dragged around by its parent's transform.
 */
function buildSmoke(parent: Entity): Entity {
  const smoke = engine.addEntity()
  Transform.create(smoke, {
    position: Vector3.create(0, CANDLE_SMOKE_HEIGHT * RITUAL_CANDLE_SCALE, 0),
    parent
  })
  ParticleSystem.create(smoke, {
    active: false, // nothing emits until the candle is actually lit
    rate: CANDLE_SMOKE_RATE,
    maxParticles: CANDLE_SMOKE_MAX,
    lifetime: CANDLE_SMOKE_LIFETIME,
    loop: true,
    // No gravity at all, and a constant upward force instead. Smoke off a
    // candle is buoyant, not ballistic — giving it an initial speed and letting
    // gravity win produces a fountain, which is the classic wrong look.
    gravity: 0,
    additionalForce: Vector3.create(0, CANDLE_SMOKE_RISE, 0),
    initialVelocitySpeed: { start: 0.04, end: 0.13 },
    // A narrow cone off a wick-sized mouth: a candle wisp is nearly vertical
    // and only spreads once it has risen and cooled.
    shape: ParticleSystem.Shape.Cone({ angle: CANDLE_SMOKE_CONE_ANGLE, radius: CANDLE_SMOKE_CONE_RADIUS }),
    initialSize: { start: CANDLE_SMOKE_SIZE_START * 0.8, end: CANDLE_SMOKE_SIZE_START * 1.25 },
    // sizeOverTime is a MULTIPLIER on the birth size, so this is the expansion
    // ratio rather than an absolute size — derived from the two config values
    // so they stay the things you actually edit.
    sizeOverTime: { start: 1, end: CANDLE_SMOKE_SIZE_END / CANDLE_SMOKE_SIZE_START },
    // Slow roll. Billboarded, so only the Z spin is visible — it exists to stop
    // the sprite's baked noise pattern from repeating identically on every puff.
    rotationOverTime: Quaternion.fromEulerDegrees(0, 0, 16),
    initialColor: {
      start: Color4.create(0.78, 0.77, 0.74, CANDLE_SMOKE_ALPHA),
      end: Color4.create(0.62, 0.62, 0.64, CANDLE_SMOKE_ALPHA)
    },
    // Multiplied over initialColor across the particle's life: full at birth,
    // gone by the end, so a wisp thins out rather than popping.
    colorOverTime: { start: Color4.create(1, 1, 1, 1), end: Color4.create(1, 1, 1, 0) },
    texture: { src: CANDLE_SMOKE_TEXTURE },
    // ALPHA, never ADD. Additive smoke over a flame brightens the very thing it
    // is supposed to be a dark trace of.
    blendMode: PS_BLEND_ALPHA,
    billboard: true,
    simulationSpace: PS_SPACE_WORLD
  })
  return smoke
}

/** Emit or stop emitting, leaving particles already in the air to finish. */
function setSmoking(r: RenderedStation, on: boolean) {
  if (r.smoke === null) return
  const ps = ParticleSystem.getMutableOrNull(r.smoke)
  if (ps !== null && ps.active !== on) ps.active = on
}

function addFlame(r: RenderedStation) {
  if (r.glow !== null) return
  // swap to the original bake — the model's own flame appears on the wick.
  // Mask repeated on purpose: createOrReplace rebuilds the whole component,
  // so leaving it off here would silently strip the candle's pointer collider
  // and with it the hover outline (see buildRenderedStation).
  GltfContainer.createOrReplace(r.body, { src: MODEL_CANDLE_LIT, visibleMeshesCollisionMask: ColliderLayer.CL_POINTER, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })
  setSmoking(r, true)

  const glow = engine.addEntity()
  Transform.create(glow, { position: Vector3.create(0, FLAME_LIGHT_HEIGHT * RITUAL_CANDLE_SCALE, 0), parent: r.root })
  LightSource.create(glow, {
    type: LightSource.Type.Point({}),
    active: true,
    color: FLAME_COLOR,
    intensity: CANDLE_GLOW_INTENSITY,
    range: CANDLE_GLOW_RANGE,
    // Shadows on the ROOM-FILL light only, on request — this is the one that
    // reaches furniture and walls, so it's the one that makes a lit candle
    // throw the room into relief. The core halo below deliberately stays
    // shadowless: two shadow-casting lights 6cm apart on the same flame would
    // double every edge for no visible gain, at twice the cost.
    //
    // Shadow-casting point lights are the single most expensive thing in this
    // scene's lighting budget and there can be RITUAL_CANDLES_REQUIRED of them
    // burning at once. If mobile framerate drops after this, flip it back —
    // it's one boolean, and nothing else depends on it.
    shadow: CANDLE_SHADOWS_ENABLED
  })
  r.glow = glow

  // Core light: a touch higher than the room-fill light above, so its extra
  // intensity still stays clear of the wax, with a short range so the extra
  // brightness stays a tight halo right at the flame instead of spreading
  // the room-fill radius any further.
  const coreGlow = engine.addEntity()
  Transform.create(coreGlow, { position: Vector3.create(0, (FLAME_LIGHT_HEIGHT + 0.06) * RITUAL_CANDLE_SCALE, 0), parent: r.root })
  LightSource.create(coreGlow, {
    type: LightSource.Type.Point({}),
    active: true,
    color: FLAME_COLOR,
    intensity: CANDLE_CORE_GLOW_INTENSITY,
    range: CANDLE_CORE_GLOW_RANGE,
    shadow: false
  })
  r.coreGlow = coreGlow
}

function removeFlame(r: RenderedStation) {
  // Mask repeated — same reason as addFlame.
  GltfContainer.createOrReplace(r.body, { src: MODEL_CANDLE_UNLIT, visibleMeshesCollisionMask: ColliderLayer.CL_POINTER, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })
  setSmoking(r, false)
  if (r.glow !== null) {
    engine.removeEntity(r.glow)
    r.glow = null
  }
  if (r.coreGlow !== null) {
    engine.removeEntity(r.coreGlow)
    r.coreGlow = null
  }
}

let flickerClock = 0

/**
 * Fast flicker for every currently-lit flame: only the wide room-fill
 * light's range drifts, on request — the tight core halo stays fixed so the
 * brightness right at the wick doesn't jitter. Two sine waves per candle (a
 * quick pulse + a faster, smaller jitter on top) so it reads as flicker and
 * not a metronome; each candle's own flickerPhase offset keeps a room full
 * of them from pulsing in unison.
 */
function flameFlickerSystem(dt: number) {
  flickerClock += dt
  for (const r of rendered.values()) {
    if (r.glow === null) continue

    // -1 .. 1. The main wave carries most of it; the faster, smaller one on
    // top keeps the two from ever settling into a visible beat.
    const wave =
      0.74 * Math.sin(flickerClock * CANDLE_FLICKER_RATE + r.flickerPhase) +
      0.26 * Math.sin(flickerClock * CANDLE_FLICKER_JITTER_RATE + r.flickerPhase * 1.7)
    // 1 at the peak, (1 - depth) at the trough.
    const factor = 1 - (CANDLE_FLICKER_DEPTH * (1 - wave)) / 2

    const g = LightSource.getMutable(r.glow)
    // INTENSITY is the one that reads. This used to animate `range` alone, by
    // about +/-18%, and the flicker was invisible — on a 34m light, changing
    // the range only slides a falloff edge that is nowhere near the player,
    // while the brightness they're actually looking at never moved at all.
    // Intensity changes how bright the room is, which is what "flicker" means
    // to anyone watching.
    g.intensity = CANDLE_GLOW_INTENSITY * factor
    // Range still rides along, but gently — a hard swing here makes the whole
    // room's lit radius visibly breathe in and out, which reads as a bug.
    g.range = CANDLE_GLOW_RANGE * (0.9 + 0.1 * factor)

    // The tight core halo at the wick is deliberately NOT flickered: it sits
    // right in front of the player while they channel, and jittering the
    // brightness there was already rejected once as "the wax is glowing".
  }
}

// LAST CANDLE TRACKING — see config.ts header comment. lastCandleStation
// tracks WHICH of my own stations is currently "the last one" (so a frame
// where the count is still 1 but it's the SAME candle as last frame doesn't
// re-trigger anything) — the last-candle camera preview and the
// camera preview both key off it. The beacon beam/light/chime that used to
// live here was removed, on request, once the camera preview made
// it redundant.
let lastCandleStation: Entity | null = null

// LAST CANDLE CAMERA PREVIEW — see config.ts header comment. Same
// VirtualCamera swap pattern deathEffects.ts uses for its death-shake rig,
// just with a real transition time instead of an instant cut (smoother, on
// request), the MainCamera points at it, then hands back. Input is frozen
// and the player is invulnerable for the same window
// (setCameraLockInvulnerable), so a blind, motionless player can't wander
// into a hazard or take a hit they can't see coming.
let locationPreviewCam: Entity
let locationPreviewTimer = 0
/**
 * Is the location preview on screen right now, and is it showing the PORTAL
 * rather than a candle?
 *
 * Read by ui.tsx to draw the converging arrows over it. The preview camera
 * always aims dead centre at whatever it's orbiting (updatePreviewCamera
 * builds its rotation with lookRotation straight at previewCenter), so the
 * UI can point at the target without knowing where it is in the world — it is
 * always the middle of the screen.
 */
export let previewActive = false
/**
 * WHAT the preview is showing, so the UI can label it truthfully.
 *
 * Three call sites reach startLocationPreview and they do NOT mean the same
 * thing. lastCandleTrackerSystem fires only when exactly one candle is left;
 * stuckHintSystem fires after a minute of no progress and shows the NEAREST
 * candle, which can be one of several still standing; unlockPortal shows the
 * way out. Labelling all three "your last candle" was wrong for the middle
 * one — and wrong in the worst direction, since it tells a struggling player
 * they're nearly finished when they aren't.
 */
export type PreviewKind = 'candle' | 'lastCandle' | 'portal'
export let previewKind: PreviewKind = 'candle'
let previewRayAnchor: Entity

// The orbit the camera sweeps through during a preview — a fixed center
// (the candle), radius and height found once at the start (see
// findClearCameraPose) and a start angle it turns LAST_CANDLE_PREVIEW_TURN_DEGREES
// away from over the course of the preview. Angle convention: 0 = +Z,
// positive turns toward +X.
let previewCenter = Vector3.create(0, 0, 0)
let previewRadius = 0
let previewHeight = 0
let previewStartAngle = 0

// Tried in order until one has a clear line back to the candle — a wall or
// piece of furniture can block the default "behind and above" angle
// depending on where the candle happens to sit (reported: sometimes a wall
// or model ends up between the camera and the candle). Each entry is a
// horizontal direction plus how far back/up along it; the last one is a
// near-overhead shot that's clear almost everywhere, as a fallback of last
// resort — pulled back further than before (was reading as too close).
const PREVIEW_CAMERA_CANDIDATES: { dir: Vector3; back: number; up: number }[] = [
  { dir: Vector3.create(0, 0, 1), back: LAST_CANDLE_PREVIEW_BACK, up: LAST_CANDLE_PREVIEW_UP },
  { dir: Vector3.create(0, 0, -1), back: LAST_CANDLE_PREVIEW_BACK, up: LAST_CANDLE_PREVIEW_UP },
  { dir: Vector3.create(1, 0, 0), back: LAST_CANDLE_PREVIEW_BACK, up: LAST_CANDLE_PREVIEW_UP },
  { dir: Vector3.create(-1, 0, 0), back: LAST_CANDLE_PREVIEW_BACK, up: LAST_CANDLE_PREVIEW_UP },
  { dir: Vector3.create(0, 0, 1), back: 1.4, up: 2.2 }
]

/**
 * Finds an unobstructed orbit (radius + height + starting angle) around
 * targetPos (a candle, or the portal). For each PREVIEW_CAMERA_CANDIDATES
 * entry, casts a ray FROM the target toward that candidate's position: if
 * something's in the way, the radius/height are scaled down proportionally
 * to land just short of it — still along the same direction, so that closer
 * point is guaranteed clear too — as long as what's left over still clears
 * LAST_CANDLE_PREVIEW_MIN_DIST (a usable shot, not the camera sitting on top
 * of the target). Falls through to the next candidate otherwise, and to the
 * plain default offset if every candidate was too tight, so the preview
 * never silently shows nothing. The camera only orbits AROUND this one
 * resolved radius/height — the sweep itself isn't re-checked point-by-point
 * for new obstructions.
 */
function findClearCameraPose(targetPos: Vector3): { radius: number; height: number; angle: number } {
  const rayOrigin = Vector3.create(targetPos.x, targetPos.y + 0.6, targetPos.z)
  Transform.createOrReplace(previewRayAnchor, { position: rayOrigin })

  for (const c of PREVIEW_CAMERA_CANDIDATES) {
    const offset = Vector3.create(c.dir.x * c.back, c.up, c.dir.z * c.back)
    const desiredDist = Vector3.length(offset)
    const dir = Vector3.normalize(offset)

    let clearDist = desiredDist
    try {
      const result = raycastSystem.registerRaycast(
        previewRayAnchor,
        raycastSystem.globalDirectionOptions({
          queryType: RaycastQueryType.RQT_HIT_FIRST,
          direction: dir,
          maxDistance: desiredDist,
          collisionMask: ColliderLayer.CL_PHYSICS
        })
      )
      const hit = result?.hits?.[0]
      if (hit?.position !== undefined) {
        const hitDist = Math.hypot(hit.position.x - rayOrigin.x, hit.position.y - rayOrigin.y, hit.position.z - rayOrigin.z)
        clearDist = hitDist - 0.3 // pull back off the wall a little
      }
    } catch (_) {
      continue // this candidate's ray failed outright — try the next one
    }

    if (clearDist >= LAST_CANDLE_PREVIEW_MIN_DIST) {
      const scale = clearDist / desiredDist
      return { radius: c.back * scale, height: c.up * scale, angle: Math.atan2(c.dir.x, c.dir.z) }
    }
  }

  // Every candidate was too tight — use the plain default orbit anyway
  // rather than show nothing.
  return { radius: LAST_CANDLE_PREVIEW_BACK, height: LAST_CANDLE_PREVIEW_UP, angle: 0 }
}

/** Places the preview camera at its current point along the orbit, always looking at the target (a candle, or the portal). progress goes 0 (start angle) to 1 (start angle + the full turn). */
function updatePreviewCamera(progress: number) {
  const angle = previewStartAngle + progress * (LAST_CANDLE_PREVIEW_TURN_DEGREES * (Math.PI / 180))
  const camPos = Vector3.create(
    previewCenter.x + Math.sin(angle) * previewRadius,
    previewCenter.y + previewHeight,
    previewCenter.z + Math.cos(angle) * previewRadius
  )
  const dir = Vector3.normalize(Vector3.subtract(previewCenter, camPos))
  const t = Transform.getMutable(locationPreviewCam)
  t.position = camPos
  t.rotation = Quaternion.lookRotation(dir)
}

/** Cuts the camera briefly to targetPos — a candle, or (see unlockPortal) the portal — orbiting it for LAST_CANDLE_PREVIEW_SECONDS. */
function startLocationPreview(targetPos: Vector3) {
  const pose = findClearCameraPose(targetPos)
  previewCenter = Vector3.create(targetPos.x, targetPos.y + 0.6, targetPos.z)
  previewRadius = pose.radius
  previewHeight = pose.height
  previewStartAngle = pose.angle
  updatePreviewCamera(0) // set the starting pose immediately — no default-transform flash before the next tick

  MainCamera.getOrCreateMutable(engine.CameraEntity).virtualCameraEntity = locationPreviewCam
  InputModifier.createOrReplace(engine.PlayerEntity, { mode: InputModifier.Mode.Standard({ disableAll: true }) })
  setCameraLockInvulnerable(true)
  locationPreviewTimer = LAST_CANDLE_PREVIEW_SECONDS
  previewActive = true
  stuckTimer = 0 // whatever triggered this cut, the player just got a fresh look — restart their minute
}

function endLocationPreview() {
  locationPreviewTimer = 0
  previewActive = false
  MainCamera.getOrCreateMutable(engine.CameraEntity).virtualCameraEntity = undefined
  InputModifier.createOrReplace(engine.PlayerEntity, { mode: InputModifier.Mode.Standard({ disableAll: false }) })
  setCameraLockInvulnerable(false)
}

/**
 * Long enough after the cut that the press which caused it can't also dismiss
 * it. Small — the point of the skip is that it's instant.
 */
const PREVIEW_SKIP_GRACE_SECONDS = 0.35

/**
 * Has the player asked to be given their camera back?
 *
 * NOT ESC, though that is what was asked for. Esc is reserved by the explorer
 * for its own menu and is never delivered to a scene — there is no InputAction
 * for it, so a HUD line promising it would be promising something that cannot
 * happen. Click/tap is the one control that exists on both desktop and mobile,
 * with E as a keyboard alternative, and the HUD names whichever applies.
 *
 * InputModifier's disableAll only stops LOCOMOTION (walk/jog/run/jump/emote —
 * see PBInputModifier_StandardInput), so scene input actions still arrive
 * normally while the preview has the player frozen. That is what makes this
 * work at all.
 */
function previewSkipPressed(): boolean {
  return (
    inputSystem.isTriggered(InputAction.IA_POINTER, PointerEventType.PET_DOWN) ||
    inputSystem.isTriggered(InputAction.IA_PRIMARY, PointerEventType.PET_DOWN) ||
    inputSystem.isTriggered(InputAction.IA_SECONDARY, PointerEventType.PET_DOWN)
  )
}

/**
 * Finds MY OWN last remaining unlit active candle (if there's exactly one) —
 * only cares about "exactly one left", since with two or more standing
 * there's no single answer to point at, and with zero the round's already
 * won. The moment a candle becomes the last one, the camera cuts to it
 * briefly (startLocationPreview). lastCandleStation is kept between frames
 * so the preview fires once per NEW last candle rather than every frame.
 */
function lastCandleTrackerSystem(dt: number) {
  if (!gameStarted || roundPhase !== 'playing') {
    lastCandleStation = null
    if (locationPreviewTimer > 0) endLocationPreview()
    return
  }

  if (locationPreviewTimer > 0) {
    locationPreviewTimer -= dt
    // Skip out of it. The camera lock takes the player's controls away for
    // several seconds, and a player who has already seen what they're being
    // shown should not have to sit through the rest of the orbit. Ends the
    // whole thing immediately — control, camera and invulnerability all come
    // back through the same endLocationPreview() the timer would have called.
    const elapsed = LAST_CANDLE_PREVIEW_SECONDS - locationPreviewTimer
    if (elapsed > PREVIEW_SKIP_GRACE_SECONDS && previewSkipPressed()) {
      endLocationPreview()
    } else if (locationPreviewTimer <= 0) {
      endLocationPreview()
    } else {
      updatePreviewCamera(1 - locationPreviewTimer / LAST_CANDLE_PREVIEW_SECONDS)
    }
  }

  let unlitCount = 0
  let lastUnlit: RenderedStation | null = null
  for (const r of rendered.values()) {
    if (!r.shown || r.visibleAsLit) continue
    unlitCount++
    lastUnlit = r
  }

  if (unlitCount !== 1 || lastUnlit === null) {
    lastCandleStation = null
    return
  }

  if (lastCandleStation !== lastUnlit.station) {
    lastCandleStation = lastUnlit.station
    // lastCandleStation always updates above regardless;
    // the cut itself only fires if nothing's already showing — guards the
    // rare same-frame overlap with stuckHintSystem below.
    if (locationPreviewTimer <= 0) {
      previewKind = 'lastCandle'
      startLocationPreview(Transform.get(lastUnlit.root).position)
    }
  }
}

let stuckTimer = 0

/**
 * If a full minute passes with no candle lit at all — not "down to the last
 * one", just genuinely stuck — the camera also cuts, to whichever of the
 * player's own remaining candles is nearest right now. Same mechanism as
 * lastCandleTrackerSystem, different trigger: this one can fire with several
 * candles still standing, not just the final one.
 */
function stuckHintSystem(dt: number) {
  // deathCamActive is in here for the same reason isPlayerDead is: the camera
  // is not the player's right now. The death recap can be opened from the HUD
  // chip AFTER respawning, so a live, un-stuck player can be watching a replay
  // when this timer matures — and a preview cutting in on top would steal that
  // shot and then lose its own camera-lock invulnerability the moment the
  // replay ended (both share the one flag). Resetting the timer rather than
  // just skipping also means the minute starts over once the recap is done.
  if (!gameStarted || roundPhase !== 'playing' || isPlayerDead || portalReady || deathCamActive) {
    stuckTimer = 0
    return
  }

  stuckTimer += dt
  if (stuckTimer < LAST_CANDLE_STUCK_SECONDS) return
  if (locationPreviewTimer > 0) return // something's already being shown

  let nearest: RenderedStation | null = null
  let nearestDist = Infinity
  for (const r of rendered.values()) {
    if (!r.shown || r.visibleAsLit) continue
    const p = Transform.get(r.root).position
    const d = Math.hypot(playerPosition.x - p.x, playerPosition.y - p.y, playerPosition.z - p.z)
    if (d < nearestDist) {
      nearestDist = d
      nearest = r
    }
  }
  if (nearest === null) return // nothing left to point at

  // Nearest, not last — several candles can still be standing here.
  previewKind = 'candle'
  startLocationPreview(Transform.get(nearest.root).position)
}

function buildRenderedStation(stationEntity: Entity, pos: Vector3): RenderedStation {
  const root = engine.addEntity()
  Transform.create(root, { position: Vector3.clone(pos) })

  // The unlit look: the real candle model (wax + wick) with its flame
  // geometry cut out in Blender — no emissive anywhere. Lighting it swaps
  // in the original bake (its own flame showing) — see addFlame().
  const body = engine.addEntity()
  Transform.create(body, {
    scale: Vector3.create(RITUAL_CANDLE_SCALE, RITUAL_CANDLE_SCALE, RITUAL_CANDLE_SCALE),
    parent: root
  })
  // CL_POINTER on the model's own VISIBLE meshes is what earns the client's
  // native hover outline — the same treatment the doors get, and the reason
  // they read as interactive without this scene drawing anything itself.
  // Never CL_PHYSICS: the candle must stay walk-through, not an obstruction
  // in a dark room. MUST be repeated in addFlame/removeFlame, which
  // createOrReplace this component to swap the lit/unlit bake and would
  // otherwise silently drop the mask.
  //
  // invisibleMeshesCollisionMask MUST be set explicitly too, and that is the
  // half this was missing: it DEFAULTS TO CL_PHYSICS, so naming only the
  // visible mask left the .glb's own invisible collider mesh solid. The
  // comment above was true of the visible geometry and wrong about the
  // candle overall — players were walking into an invisible box at every
  // station. Same fix the tombstones already carry (deathEffects.ts) and the
  // wall spikes (wallSpikes.ts).
  GltfContainer.create(body, { src: MODEL_CANDLE_UNLIT, visibleMeshesCollisionMask: ColliderLayer.CL_POINTER, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })
  VisibilityComponent.create(body, { visible: false }) // hidden until syncStationVisuals decides it should show

  return {
    station: stationEntity,
    root,
    body,
    // Nothing is registered on the body yet — syncStationVisuals owns this
    // from here and turns it on the first time the candle is drawn and unlit.
    targetable: false,
    glow: null,
    coreGlow: null,
    shown: false,
    visibleAsLit: false,
    flickerPhase: Math.random() * Math.PI * 2,
    smoke: CANDLE_SMOKE_ENABLED ? buildSmoke(root) : null
  }
}

/**
 * Keeps my stations' visuals in sync, building a station's visuals the first
 * time it's seen.
 *
 * This is where the reading rule in this file's header is actually enforced,
 * and it is now enforced by what this loop never looks at: myCandleStations()
 * returns only my own, so no other player's candle can reach the render path
 * at all — not as a dark candle offering a hold that would silently refuse,
 * and not as a flame that reads like progress the player didn't make. Every
 * field read here is written only by me, so nothing in this loop can race
 * anything.
 */
function syncStationVisuals() {
  for (const s of myCandleStations()) {
    let r = rendered.get(s.entity)
    if (r === undefined) {
      // s.index is mine and always in range, but the component is still a
      // synced one and this runs every frame — an out-of-range index would
      // throw here forever (addSafeSystem only dedupes the LOG, not the
      // throw itself — see safeSystem.ts), silently freezing the entire game
      // loop. Skip the one station rather than risk taking everything down.
      const spot = CANDLE_POOL[s.index]
      if (spot === undefined) continue
      const off = CANDLE_OFFSET_BUCKETS[s.offsetBucket] ?? Vector3.Zero()
      r = buildRenderedStation(s.entity, Vector3.create(spot.pos.x + off.x, spot.pos.y + off.y, spot.pos.z + off.z))
      rendered.set(s.entity, r)
    }
    // Drawn whenever it's one of this round's draw. Lit or unlit, it's mine.
    const show = s.active
    if (show !== r.shown) {
      r.shown = show
      VisibilityComponent.createOrReplace(r.body, { visible: show })
    }
    // Tied to `show`, not to s.lit alone: a flame carries two real point
    // lights, and this scene has a history of stray lights costing frames.
    // Belt-and-braces against ever leaving one burning on a candle that
    // isn't being drawn.
    const burning = show && s.lit
    if (burning !== r.visibleAsLit) {
      r.visibleAsLit = burning
      if (burning) addFlame(r)
      else removeFlame(r) // round reset snuffed it
    }
    // THE HOVER OUTLINE — the same one the doors have. Registering
    // PointerEvents on an entity whose GLTF carries a CL_POINTER collider is
    // all it takes; the client draws the highlight itself, on the candle's
    // real silhouette, and it costs no geometry of our own.
    //
    // Only ever registered on a candle that is DRAWN and UNLIT, so the outline
    // and its "Hold to light" prompt can never appear on a station sitting out
    // the round or on one already burning. The click callback is deliberately
    // empty — lighting is proximity + hold (candleChannelSystem), and a 3D tap
    // is exactly what didn't register reliably on mobile. This is hover
    // affordance only, the same pattern the tombstone hover uses.
    const targetable = show && !s.lit
    if (targetable !== r.targetable) {
      r.targetable = targetable
      if (targetable) {
        pointerEventsSystem.onPointerDown(
          {
            entity: r.body,
            // The client prepends the icon for the bound input itself — a
            // left-mouse glyph on desktop, the touch/interact glyph on
            // mobile — so the text must not name a device. IA_POINTER is what
            // maps to both (same binding the doors and the channel use).
            opts: { button: InputAction.IA_POINTER, hoverText: 'Come closer to light', maxDistance: CANDLE_HOVER_MAX_DISTANCE }
          },
          () => {}
        )
      } else {
        // Paired with the registration above so entries can't pile up — the
        // helper PUSHES rather than replaces (see refreshTombstoneHover in
        // effects/deathEffects.ts for where that already bit this project).
        pointerEventsSystem.removeOnPointerDown(r.body)
      }
    }
  }
}

/** Full 3D distance from the player to a rendered station's base — start and sustain use the SAME metric. */
function distToRendered(r: RenderedStation): number {
  const p = Transform.get(r.root).position
  return Math.hypot(playerPosition.x - p.x, playerPosition.y - p.y, playerPosition.z - p.z)
}

/**
 * HOLD-TO-LIGHT: called every frame while playing. No aiming at a specific
 * candle — proximity alone picks the nearest eligible one (same "walk up to
 * it" philosophy the mobile fixes established elsewhere; aiming a 3D pointer
 * at a small hitbox is exactly what didn't reliably register there), and
 * inputSystem.isPressed(IA_POINTER) alone decides whether progress advances.
 * IA_POINTER is left click on PC and the mobile client's own on-screen
 * interact button — same action, same code path, no platform branch needed.
 * Releasing the button (or walking out of range, or dying) cancels outright:
 * the fill resets to 0, it does not pause and resume.
 *
 * Eligibility is "standing and unlit" — the "mine" half of the old rule is
 * gone because it can no longer fail: nothing but my own stations is ever
 * rendered (see syncStationVisuals), so every dark candle the player can
 * walk up to is one this will pick up.
 */
function candleChannelSystem(dt: number) {
  if (!inputSystem.isPressed(InputAction.IA_POINTER)) {
    if (channelTarget !== null) cancelChannel()
    return
  }

  if (channelTarget === null) {
    let best: { station: Entity; root: Entity } | null = null
    let bestD = CHANNEL_MAX_DISTANCE
    for (const r of rendered.values()) {
      if (!r.shown || r.visibleAsLit) continue
      const d = distToRendered(r)
      if (d <= bestD) {
        bestD = d
        best = { station: r.station, root: r.root }
      }
    }
    if (best === null) return
    channelTarget = best
    channelProgress = 0
    playSoundAt(SOUND_CANDLE_LIGHTING_START, Transform.get(best.root).position, 0.8)
  }

  const target = channelTarget
  const r = rendered.get(target.station)
  // Nothing another player does can land in here: the target is always one of
  // MY stations, and every field of a station is written only by its owner.
  // So a hold can only ever end the way the player themselves ended it —
  // released, walked off, or died. No stolen candles, no cancelled fills.
  if (r === undefined || isPlayerDead || !r.shown || r.visibleAsLit || distToRendered(r) > CHANNEL_MAX_DISTANCE + 0.4) {
    cancelChannel()
    return
  }
  channelProgress = (channelProgress ?? 0) + dt
  updateChannelGlow(r.root, channelProgress / CANDLE_CHANNEL_SECONDS)
  if (channelProgress >= CANDLE_CHANNEL_SECONDS) {
    lightStation(target.station, Transform.get(r.root).position)
    cancelChannel()
  }
}

/** Is the player in range of one of THEIR OWN unlit candles? Drives the "hold to light" HUD prompt — same eligibility as the channel itself, so the prompt never appears on a candle that wouldn't respond. */
export function canLightNearby(): boolean {
  for (const r of rendered.values()) {
    if (!r.shown || r.visibleAsLit) continue
    if (distToRendered(r) <= CHANNEL_MAX_DISTANCE) return true
  }
  return false
}

function cancelChannel() {
  channelTarget = null
  channelProgress = null
  clearChannelGlow()
}

function lightStation(stationEntity: Entity, pos: Vector3) {
  stuckTimer = 0 // real progress — the stuck-for-a-minute clock starts over
  // Owner-only write — this is always one of my own stations, so I'm the only
  // client that ever writes it and there's no race to think about. It IS
  // synced, though: syncStationVisuals() on every client puts the flame up,
  // so the whole house sees it burn and gets the light from it.
  setMyStationLit(stationEntity)
  playSoundAt(SOUND_CANDLE_LIGHT, pos, 0.8)

  // Credit is trivially unambiguous now: the only candles I can light are my
  // own, and nobody else can light them, so a lit candle of mine is always
  // exactly one candle of my own progress. Incremented before the toast so
  // the count it reports is the one the player just reached, not the one
  // before it.
  candlesLit += 1
  // My own toast shows MY progress toward MY win condition — on request,
  // "1/5 candles lit to escape" rather than a generic "you lit a candle".
  // Other players still just hear that I lit one (their own progress isn't
  // affected by mine, so a count of MY candles wouldn't mean anything to
  // them) — bus.emit never echoes back to me, so this doesn't double up.
  const myName = getPlayer()?.name ?? 'A player'
  pushToast(`${candlesLit}/${getCandlesRequired()} candles lit to escape`)
  bus.emit('sh_candlelit', { name: myName })

  if (!portalReady && candlesLit >= getCandlesRequired()) unlockPortal()
}

// --- the portal -------------------------------------------------------------
interface Portal {
  root: Entity
  glow: Entity
  hitbox: Entity
  /** The spinning vortex plane. Child of a billboard, so it can rotate. */
  disc: Entity
}
let portal: Portal | null = null
/** Accumulated spin, degrees. Kept here so a round reset starts it over. */
let portalSpin = 0
let portalPosition: Vector3 | null = null // where the portal opened (for the walk-through win)

function unlockPortal() {
  cancelChannel() // nothing left to channel — you've already earned the win
  portalReady = true
  portalOpenSeconds = 0
  // Invulnerable from this instant: every hazard gates on isInvulnerable(),
  // so this doesn't just avoid COUNTING a death against you (defeat()'s own
  // portalReady guard already did that) — it stops the death from happening
  // at all, so there's no walk-of-shame respawn cycle between "you won" and
  // actually reaching the portal.
  setQuestInvulnerable(true)

  portalPosition = Vector3.create(PORTAL_POSITION.x, PORTAL_POSITION.y, PORTAL_POSITION.z)
  playSoundAt(SOUND_PORTAL_APPEAR, portalPosition, 1, 1, true) // global — on request, everyone should hear a portal/win moment regardless of distance
  pushToast('Your portal has opened in the backyard!')
  // Same camera-cut-and-orbit reveal the last candle gets — on request,
  // players need to know where to go after their final candle just as much
  // as they need to know where that candle was. Already invulnerable (above)
  // and the round's already won, so there's no risk in taking the camera for
  // a few seconds here.
  previewKind = 'portal'
  startLocationPreview(portalPosition)

  const root = engine.addEntity()
  Transform.create(root, {
    position: Vector3.create(PORTAL_POSITION.x, PORTAL_POSITION.y + PORTAL_HEIGHT_OFFSET, PORTAL_POSITION.z),
    scale: Vector3.create(PORTAL_RADIUS * 2, PORTAL_RADIUS * 2, PORTAL_RADIUS * 2)
  })
  // THE VORTEX. Billboard on the ROOT so the disc always faces the player, and
  // the spinning plane as its CHILD — a Billboard overrides its own entity's
  // rotation, so anything that needs to spin has to live underneath it.
  Billboard.create(root, { billboardMode: BillboardMode.BM_Y })

  const disc = engine.addEntity()
  Transform.create(disc, {
    scale: Vector3.create(PORTAL_DISC_SCALE, PORTAL_DISC_SCALE, PORTAL_DISC_SCALE),
    parent: root
  })
  MeshRenderer.setPlane(disc)
  Material.setPbrMaterial(disc, {
    texture: Material.Texture.Common({ src: PORTAL_VORTEX_TEXTURE }),
    // Emissive from the same texture: the arms and the hot core glow on their
    // own rather than being lit by whatever happens to be nearby, which in a
    // back yard at night is nothing.
    emissiveTexture: Material.Texture.Common({ src: PORTAL_VORTEX_TEXTURE }),
    emissiveColor: Color4.create(1, 1, 1, 1),
    emissiveIntensity: 2.2,
    albedoColor: Color4.create(1, 1, 1, 1),
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    specularIntensity: 0,
    metallic: 0,
    roughness: 1
  })
  portalSpin = 0

  const glow = engine.addEntity()
  Transform.create(glow, { parent: root })
  LightSource.create(glow, {
    type: LightSource.Type.Point({}),
    active: true,
    color: PORTAL_COLOR,
    intensity: PORTAL_GLOW_INTENSITY,
    range: PORTAL_GLOW_RANGE,
    shadow: false
  })

  const hitbox = engine.addEntity()
  Transform.create(hitbox, { scale: Vector3.create(2.4, 2.4, 2.4), parent: root })
  MeshCollider.setSphere(hitbox, ColliderLayer.CL_POINTER)
  pointerEventsSystem.onPointerDown(
    { entity: hitbox, opts: { button: InputAction.IA_POINTER, hoverText: 'Step through the portal', maxDistance: 6 } },
    () => {
      if (roundPhase !== 'playing') return
      // Same entry delay as the walk-through check below — a click
      // shouldn't be able to win instantly the moment the portal spawns.
      if (portalOpenSeconds < PORTAL_ENTRY_DELAY_SECONDS) return
      win()
    }
  )

  portal = { root, glow, hitbox, disc }
}

function removePortal() {
  if (portal !== null) {
    pointerEventsSystem.removeOnPointerDown(portal.hitbox)
    engine.removeEntity(portal.hitbox)
    engine.removeEntity(portal.glow)
    engine.removeEntity(portal.disc)
    engine.removeEntity(portal.root)
    portal = null
  }
  portalPosition = null
  portalReady = false
  portalOpenSeconds = 0
}

function win() {
  cancelChannel()
  removePortal()
  roundPhase = 'won'
  lastWinSeconds = Math.max(0, Math.round(ROUND_SECONDS - roundRemaining))
  // Improvement feedback: compare against the previous personal best BEFORE
  // this run is folded into bestWinTimes.
  const priorBest = bestWinTimes.length > 0 ? bestWinTimes[0] : null
  lastWinWasBest = priorBest === null || lastWinSeconds < priorBest
  lastWinDelta = priorBest === null ? 0 : lastWinSeconds - priorBest
  // Only when this run actually IS the new best, so hearts never drift onto a
  // time from a different escape.
  if (lastWinWasBest) bestWinHearts = hearts
  bestWinTimes.push(lastWinSeconds)
  bestWinTimes.sort((a, b) => a - b)
  if (bestWinTimes.length > 5) bestWinTimes.length = 5
  updateMyBestTime(bestWinTimes[0]) // share my fastest escape with everyone in the room right now
  // THIS RUN's time and hearts, not the best-ever time. Sending bestWinTimes[0]
  // (as this did) would pair a previous run's time with this run's hearts and
  // put a combination on the board that never happened. The server keeps
  // whichever is faster, so there is nothing lost by reporting honestly.
  submitScore(lastWinSeconds, hearts)
  phaseCountdown = WIN_RESET_SECONDS
  setQuestInvulnerable(true) // nothing can kill you mid-celebration
  playSoundAt(SOUND_VICTORY, playerPosition, 1, 1, true) // global — a win should be heard scene-wide, not just up close
  // THE ONLY PLACE THE CELEBRATION IS EVER STARTED, and win() has exactly one
  // caller — the portal, by tap or by walking into it. Wiring it here rather
  // than at either of those two call sites is what makes "it only plays after
  // you got in the portal" a property of the code instead of a promise.
  //
  // LAST, after the score is banked and submitted: the cinematic takes the
  // camera and the body for the next several seconds, and none of the bookkeeping
  // above should be sitting behind a shot. It is also self-guarding (disabled
  // flag, un-ready init, already-running), so a scene where it failed to
  // initialise still wins rounds exactly as it did before.
  winHoldSeconds = 0
  startVictoryCinematic()
  // Read back rather than assumed: startVictoryCinematic declines silently if
  // the feature is off or its init never completed, and in that case the win
  // screen must come up immediately, exactly as it did before any of this
  // existed.
  winScreenHeld = victoryCinematicHolding
}

function defeat(reason: 'hearts' | 'time') {
  // Once the portal is up you've already earned this round's win — dying a
  // few more times or running out the clock while walking to it shouldn't
  // flip that into a loss.
  if (portalReady) return
  cancelChannel()
  roundPhase = 'defeated'
  defeatReason = reason
  phaseCountdown = DEFEAT_RESET_SECONDS
  setQuestInvulnerable(true)
}

// Other modules (combat) register cleanup here so every new round starts
// from a clean slate — knives back in hand, etc.
const roundResetHooks: (() => void)[] = []
export function onRoundReset(cb: () => void) {
  roundResetHooks.push(cb)
}

/**
 * "Play Again" button — lets the win/defeat screen skip the rest of its
 * auto-continue countdown instead of forcing everyone to sit through the
 * full WIN_RESET_SECONDS/DEFEAT_RESET_SECONDS wait. Only does anything while
 * a round is actually over; harmless no-op if somehow called mid-round.
 */
export function playAgainNow() {
  if (roundPhase === 'playing') return
  resetRound()
}

function resetRound() {
  // Only step up to the harder requirement after an actual WIN — losing at
  // the easy count and trying again should stay easy, not silently get
  // harder. Once you've won once, roundNumber never drops back to 1, so this
  // block only ever fires the single time you graduate off round 1.
  if (roundNumber === 1 && roundPhase === 'won') roundNumber = 2
  // Isolated per hook — combat.ts registers independent cleanup here
  // (knives back in hand); one throwing must not skip the rest or leave the
  // new round in a half-reset state.
  for (const cb of roundResetHooks) {
    try {
      cb()
    } catch (err) {
      console.error('onRoundReset hook threw:', err)
    }
  }
  removePortal()
  // Strike the celebration set BEFORE the teleport below: it deletes the pile
  // and hands the camera back, and the player is standing on top of that pile.
  // Unconditional and self-guarding, so it also covers "Play Again" pressed
  // mid-shot and a round that was never won at all.
  endVictoryCinematic()
  winScreenHeld = false
  winHoldSeconds = 0
  assignRitualCandles() // a fresh random subset every run — also snuffs all of my own candles, for every viewer
  candlesLit = 0
  hearts = ROUND_HEARTS
  roundRemaining = ROUND_SECONDS
  roundDeaths = 0
  deathLog.length = 0
  clearDeathReplay() // a new round must not replay last round's death
  furthestArea = 0
  roundPhase = 'playing'
  setQuestInvulnerable(false)

  // back to the gate for a fresh attempt
  const lookDir = Vector3.rotate(Vector3.Forward(), SPAWN_ROTATION)
  movePlayerTo({
    newRelativePosition: SPAWN_POSITION,
    cameraTarget: Vector3.add(SPAWN_POSITION, Vector3.scale(lookDir, 5))
  }).catch((err) => {
    console.error('round reset movePlayerTo failed:', err)
  })
  grantSpawnGrace()
}

// FURTHEST AREA REACHED — a coarse Y-based read of yard / ground floor /
// upstairs, on request (playtest feedback: unsuccessful players need to see
// SOME progress, not just candle count). Bands come from CANDLE_POOL's own
// real coordinates: yard candles sit near y=0, ground-floor ones ~2.6-4,
// upstairs ~8.4-8.5 — thresholds split the gaps between those clusters.
const AREA_LABELS = ['the yard', 'the ground floor', 'upstairs']
let furthestArea = 0

function areaIndexForY(y: number): number {
  if (y >= 6) return 2
  if (y >= 2) return 1
  return 0
}

/** Furthest area reached this round, for the defeat screen's "you got this far" readout. */
export function furthestAreaLabel(): string {
  return AREA_LABELS[furthestArea]
}

function loopSystem(dt: number) {
  if (!gameStarted) return

  // win/defeat screen counts down, then the next round starts itself
  if (roundPhase !== 'playing') {
    // THE CLOCK STOPS WHILE YOU ARE WATCHING THE REPLAY.
    //
    // The recap is most worth watching after the death that ended the run, and
    // that is exactly when a countdown is running underneath it. Left ticking,
    // the round would reset out from under the shot - the replay would be cut
    // off mid-swing and the screen would jump to a fresh round. Holding it is
    // free: the replay ends itself (deathCam's own tail), and the round reset
    // calls clearDeathReplay() anyway, so this cannot deadlock.
    //
    // AND WHILE THE WIN CINEMATIC IS STILL HOLDING THE SCREEN, for the same
    // reason: the win overlay is suppressed for that window (ui.tsx), so a
    // countdown running underneath it would be counting down a screen nobody
    // can see, and could reset the round out from under the shot. The hold
    // ends before the camera move does — see VICTORY_CINEMATIC_HOLD_SECONDS —
    // so the last seconds of the arc play under the win screen with the
    // countdown running normally.
    if (winScreenHeld) {
      winHoldSeconds += dt
      if (!victoryCinematicHolding || winHoldSeconds >= WIN_HOLD_CEILING) winScreenHeld = false
    }
    if (!deathCamActive && !winScreenHeld) {
      phaseCountdown -= dt
      if (phaseCountdown <= 0) resetRound()
    }
    return
  }

  const areaIdx = areaIndexForY(playerPosition.y)
  if (areaIdx > furthestArea) furthestArea = areaIdx

  // Keep every station's visuals (mine AND everyone else's) in sync with
  // current synced state.
  syncStationVisuals()

  // Hold-to-light: acquires the nearest eligible candle while IA_POINTER is
  // held, advances its fill, cancels on release/out-of-range/death. Credit
  // (and the win check) happens directly inside lightStation() now — it
  // only ever fires from MY OWN completed channel, never a remote write, so
  // there's no separate "check every frame" path needed anymore.
  candleChannelSystem(dt)

  // the round clock — paused while dead (the death already costs a heart),
  // and frozen once the portal is up (you've already won this round)
  if (!isPlayerDead && !portalReady) {
    roundRemaining -= dt
    if (roundRemaining <= 0) {
      roundRemaining = 0
      defeat('time')
      return
    }
  }

  // THE PORTAL NEVER WINS FOR YOU. It used to: PORTAL_WIN_TIMEOUT_SECONDS after
  // it opened, win() fired whether or not the player had gone anywhere near it.
  // Removed on request — you have to actually reach the way out now.
  //
  // That courtesy was quietly deleting the last beat of the run. The portal is
  // parked in one fixed spot in the back yard (PORTAL_POSITION), so crossing to
  // it IS the finale, and a timer that hands you the win for standing still
  // turns that into a cutscene you wait out.
  //
  // THERE IS NOW NO DEADLINE ON THE WALK, and that is deliberate rather than an
  // oversight. Once the portal is up the round clock is frozen (see the timer
  // above) and defeat() refuses to fire, so nothing ends the round except
  // actually reaching the exit — it waits for the player as long as they need.
  // They are also invulnerable from the instant it opens, so the walk cannot
  // kill them either. If a deadline is wanted later, unfreezing that clock is
  // the one-line version, but note it would also make the score honest in a way
  // it currently isn't: "escape time" presently stops at the last candle rather
  // than at the exit.
  //
  // Not a soft-lock risk: portalPosition is assigned from PORTAL_POSITION at the
  // top of unlockPortal(), before any entity is built, so even if the portal's
  // visuals fail to spawn the walk-through check below still works.
  if (portalReady) {
    portalOpenSeconds += dt
    // SWIRL. Advanced by dt rather than set from portalOpenSeconds so the spin
    // stays smooth if the clock is ever paused or reset under it.
    if (portal !== null) {
      portalSpin = (portalSpin + PORTAL_SPIN_SPEED * dt) % 360
      Transform.getMutable(portal.disc).rotation = Quaternion.fromEulerDegrees(0, 0, portalSpin)
    }
    // Walk-through win: stand in the portal to escape — no tap needed (mobile
    // can't tap the 3D portal). Tapping it still works, gated by the same
    // PORTAL_ENTRY_DELAY_SECONDS — on request, neither path can enter until the
    // portal's been up a full 5 seconds.
    if (portalPosition !== null && portalOpenSeconds >= PORTAL_ENTRY_DELAY_SECONDS) {
      const d = Math.hypot(playerPosition.x - portalPosition.x, playerPosition.z - portalPosition.z)
      if (d <= PORTAL_RADIUS + 1) {
        win()
        return
      }
    }
  }
}

export function initGameLoop() {
  // Weapons are free in this mode — every knife starts in hand.
  for (let i = 0; i < knifeCollected.length; i++) knifeCollected[i] = true

  // Creates MY OWN 13 synced candle stations (never anyone else's — see the
  // header comment on CandleStation in multiplayer.ts for why). My own
  // offset bucket is a pure function of my own player id, so it can't shift
  // just because someone else joins or leaves later.
  createMyCandleStations(CANDLE_POOL.length, myOffsetBucketIndex(CANDLE_OFFSET_BUCKETS.length))
  assignRitualCandles()

  // Virtual camera for the last-candle preview cut — same pattern as
  // deathEffects.ts's shake rig, just repositioned/aimed fresh every time
  // startLocationPreview() fires instead of every frame. A real transition
  // time (was an instant Time(0) cut) so the swap reads as a smooth pan
  // rather than a snap, on request, both heading to the candle and back.
  locationPreviewCam = engine.addEntity()
  Transform.create(locationPreviewCam)
  VirtualCamera.create(locationPreviewCam, {
    defaultTransition: { transitionMode: VirtualCamera.Transition.Time(LAST_CANDLE_PREVIEW_TRANSITION_SECONDS) }
  })
  previewRayAnchor = engine.addEntity()
  Transform.create(previewRayAnchor)

  onPlayerDeath(() => {
    if (roundPhase !== 'playing') return
    roundDeaths += 1
    // Counted on the same guard as roundDeaths, deliberately: deaths during a
    // win/defeat screen are not part of a run and must not pad the tally.
    recordDeath()
    deathLog.push({
      cause: lastDeathCause,
      atRemaining: roundRemaining,
      area: furthestAreaLabel()
    })
    // clamped at 0 — once the portal is up (see defeat()'s guard) dying more
    // is harmless, but hearts shouldn't visibly drift negative on the HUD
    hearts = Math.max(0, hearts - 1)
    cancelChannel()
    if (hearts <= 0) defeat('hearts')
  }, 'gameLoop')

  bus.on('sh_candlelit', (v) => {
    if (typeof v?.name === 'string') pushToast(`${v.name} lit a candle`)
  })

  addSafeSystem(loopSystem, 'loopSystem')
  addSafeSystem(flameFlickerSystem, 'flameFlickerSystem')
  addSafeSystem(lastCandleTrackerSystem, 'lastCandleTrackerSystem')
  addSafeSystem(stuckHintSystem, 'stuckHintSystem')
}

/** 0..1 fill for the channel bar (null = no channel running). */
export function channelFill(): number | null {
  return channelProgress === null ? null : Math.min(1, channelProgress / CANDLE_CHANNEL_SECONDS)
}

/** "M:SS" for the HUD timer and the leaderboard. */
export function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r < 10 ? '0' : ''}${r}`
}
