/**
 * THE RITUAL ROUND — the core game loop (replaces the quest for now).
 *
 * Every connected player has their OWN full copy of the CANDLE_POOL
 * stations, nudged apart by a small per-owner offset (CANDLE_OFFSET_BUCKETS
 * in config.ts) so different players' candles at the "same" spot don't
 * render on top of each other. Each round, each player's OWN pool
 * independently draws a random subset of RITUAL_CANDLES_REQUIRED to be
 * "active" — this just controls how many candles are actually live/visible
 * at once (pacing/spread), not who gets credit. Every player sees every
 * OTHER player's candles too, and credit for lighting ANY of them — mine or
 * someone else's — always goes to whoever personally channels it (on
 * request: "whatever candle they see, when it's lit it adds to their own
 * score"), tracked as a simple local count of candles I've personally lit
 * this round. A candle's lit state is genuinely synced (see the
 * CandleStation component in multiplayer.ts), not a one-off event, so a
 * player joining mid-round sees the real current state immediately rather
 * than only future changes.
 *
 * WIN:      personally light RITUAL_CANDLES_REQUIRED candles — any of
 *           them, from any player's pool — and a portal appears near you.
 *           Step into it to win immediately, or ignore it and it wins for
 *           you automatically after PORTAL_WIN_TIMEOUT_SECONDS.
 * DEFEATED: lose all ROUND_HEARTS (every death costs one), or the timer
 *           dies — but never once your portal has appeared; by then you've
 *           already earned the win and just need to reach it.
 *
 * Lighting a candle is a CHANNEL: walk within range of any unlit active
 * candle (mine or someone else's) and HOLD the interact button (left click
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
  MeshCollider,
  Material,
  MaterialTransparencyMode,
  ColliderLayer,
  LightSource,
  VisibilityComponent,
  InputAction,
  inputSystem,
  pointerEventsSystem,
  Entity
} from '@dcl/sdk/ecs'
import { Vector3, Color3, Color4 } from '@dcl/sdk/math'
import { movePlayerTo } from '~system/RestrictedActions'
import {
  CANDLE_POOL,
  CANDLE_OFFSET_BUCKETS,
  RITUAL_CANDLES_REQUIRED,
  RITUAL_CANDLES_ROUND1,
  RITUAL_CANDLE_SCALE,
  ROUND_SECONDS,
  ROUND_HEARTS,
  CANDLE_CHANNEL_SECONDS,
  CHANNEL_MAX_DISTANCE,
  DEFEAT_RESET_SECONDS,
  WIN_RESET_SECONDS,
  CANDLE_GLOW_INTENSITY,
  CANDLE_GLOW_RANGE,
  CANDLE_CORE_GLOW_INTENSITY,
  CANDLE_CORE_GLOW_RANGE,
  MODEL_CANDLE_UNLIT,
  MODEL_CANDLE_LIT,
  PORTAL_POSITION,
  PORTAL_ENTRY_DELAY_SECONDS,
  PORTAL_WIN_TIMEOUT_SECONDS,
  PORTAL_RADIUS,
  PORTAL_HEIGHT_OFFSET,
  PORTAL_COLOR,
  PORTAL_GLOW_INTENSITY,
  PORTAL_GLOW_RANGE,
  SPAWN_POSITION,
  SPAWN_ROTATION
} from './config'
import { gameStarted, isPlayerDead, onPlayerDeath, setQuestInvulnerable, grantSpawnGrace } from './gameState'
import { playerPosition } from './playerTracker'
import { knifeCollected } from './quest'
import { playSoundAt, SOUND_CANDLE_LIGHT, SOUND_CANDLE_LIGHTING_START, SOUND_PORTAL_APPEAR, SOUND_VICTORY } from './sounds'
import {
  updateMyBestTime,
  readRemoteStats,
  bus,
  createMyCandleStations,
  allCandleStations,
  lightCandleStation,
  setMyStationsForRound,
  myOffsetBucketIndex
} from './multiplayer'
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
export let lastWinSeconds = 0 // how long the winning ritual took
export let lastWinWasBest = false // did the latest win beat the previous personal best?
export let lastWinDelta = 0 // latest win time minus previous best (negative = faster); 0 on first win
export const bestWinTimes: number[] = [] // fastest rituals, ascending, top 5
export let portalReady = false
export let portalCountdown = 0
let roundNumber = 1 // 1 = first round (5 candles), 2+ = standard (7 candles)

export interface RankEntry {
  name: string
  bestTime: number
  me: boolean
}

/**
 * Fastest valid escape times, ranked across every player in the scene.
 *
 * This is THE competitive score. My best comes from bestWinTimes[0]; every
 * other player's from their synced bestTime (0 = never escaped, excluded).
 * Used by the win overlay in ui.tsx.
 */
export function escapeRanking(): RankEntry[] {
  const myName = getPlayer()?.name ?? 'You'
  const ranking: RankEntry[] = []
  if (bestWinTimes.length > 0) ranking.push({ name: myName, bestTime: bestWinTimes[0], me: true })
  for (const o of readRemoteStats()) {
    if (o.bestTime > 0) ranking.push({ name: o.name, bestTime: o.bestTime, me: false })
  }
  ranking.sort((a, b) => a.bestTime - b.bestTime)
  return ranking
}

// the active lighting channel (null = not lighting anything)
export let channelProgress: number | null = null
let channelTarget: { station: Entity; root: Entity } | null = null

/** Local render state for one candle station (mine or someone else's) — keyed by its synced CandleStation entity. */
interface RenderedStation {
  station: Entity // the synced multiplayer.ts CandleStation entity this mirrors
  root: Entity
  body: Entity
  glow: Entity | null // wide room-fill point-light, only exists while lit
  coreGlow: Entity | null // tight, brighter halo right at the flame, only exists while lit
  visibleAsActive: boolean // what the LOCAL visuals currently show — compared each frame against synced truth
  visibleAsLit: boolean
}

// Every station currently known about — mine (created in initGameLoop) plus
// every other connected player's (discovered lazily as their synced data
// arrives). Visuals are built here on first sight and then just kept in
// sync every frame; see syncStationVisuals().
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
 * HLtemplate GltfContainer) — the probe could only ever hit the coarse
 * invisible collision proxy, which doesn't track each room's real floor
 * height closely enough to judge "buried" reliably. It reported all 13 spots
 * unreachable on every single round, always fell back to the full pool
 * anyway, and just added log noise — removed rather than kept fighting a
 * check that can't work against this asset's collision setup. If a specific
 * CANDLE_POOL entry turns out to be genuinely bad, fix that one coordinate
 * directly.
 *
 * Entries flagged `guaranteed: true` in CANDLE_POOL (the table, the
 * butcher's knife) are seeded first so they're in EVERY round's draw, on
 * request; the rest of `needed` is filled randomly from everything else.
 */
function assignRitualCandles() {
  const needed = getCandlesRequired()
  const guaranteed = CANDLE_POOL.reduce<number[]>((acc, spot, idx) => {
    if (spot.guaranteed) acc.push(idx)
    return acc
  }, [])
  const remaining = shuffledIndices(CANDLE_POOL.length).filter((i) => !guaranteed.includes(i))
  const activeIndices = new Set([...guaranteed, ...remaining].slice(0, needed))

  // Owner-only write (see multiplayer.ts) — sets which of MY stations are
  // active this round and resets all of mine back to unlit. Every other
  // client picks up the change the exact same way they pick up anyone
  // else's station state: via syncStationVisuals() reading
  // allCandleStations(). Nothing here is local-only anymore — that's the
  // point (on request: everyone sees everybody's candles).
  setMyStationsForRound(activeIndices)
}

function addFlame(r: RenderedStation) {
  if (r.glow !== null) return
  // swap to the original bake — the model's own flame appears on the wick
  GltfContainer.createOrReplace(r.body, { src: MODEL_CANDLE_LIT })

  const glow = engine.addEntity()
  Transform.create(glow, { position: Vector3.create(0, FLAME_LIGHT_HEIGHT * RITUAL_CANDLE_SCALE, 0), parent: r.root })
  LightSource.create(glow, {
    type: LightSource.Type.Point({}),
    active: true,
    color: FLAME_COLOR,
    intensity: CANDLE_GLOW_INTENSITY,
    range: CANDLE_GLOW_RANGE,
    shadow: false
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
  GltfContainer.createOrReplace(r.body, { src: MODEL_CANDLE_UNLIT })
  if (r.glow !== null) {
    engine.removeEntity(r.glow)
    r.glow = null
  }
  if (r.coreGlow !== null) {
    engine.removeEntity(r.coreGlow)
    r.coreGlow = null
  }
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
  GltfContainer.create(body, { src: MODEL_CANDLE_UNLIT })
  VisibilityComponent.create(body, { visible: false }) // hidden until syncStationVisuals learns it's active

  return { station: stationEntity, root, body, glow: null, coreGlow: null, visibleAsActive: false, visibleAsLit: false }
}

/**
 * Keeps every known station's visuals (mine AND every other connected
 * player's) in sync with their real synced state, building a station's
 * visuals the first time it's seen (including a remote player's, whenever
 * their sync data arrives). Purely visual — on request, credit for a
 * candle now always goes to whoever personally channels it (see
 * lightStation()), not to whichever pool it happened to come from, so this
 * no longer needs to track ownership at all.
 */
function syncStationVisuals() {
  for (const s of allCandleStations()) {
    let r = rendered.get(s.entity)
    if (r === undefined) {
      // s.index is network-sourced — it was written by whichever client
      // created this station, using THEIR loaded CANDLE_POOL.length. If a
      // player is ever connected on a different build with a different
      // CANDLE_POOL size, an out-of-range index would otherwise throw here
      // every single frame forever (addSafeSystem only dedupes the LOG, not
      // the throw itself — see safeSystem.ts), silently freezing the entire
      // game loop for every client, not just the one with the bad station.
      // Skip that one station rather than risk taking everything else down.
      const spot = CANDLE_POOL[s.index]
      if (spot === undefined) continue
      const off = CANDLE_OFFSET_BUCKETS[s.offsetBucket] ?? Vector3.Zero()
      r = buildRenderedStation(s.entity, Vector3.create(spot.pos.x + off.x, spot.pos.y + off.y, spot.pos.z + off.z))
      rendered.set(s.entity, r)
    }
    if (s.active !== r.visibleAsActive) {
      r.visibleAsActive = s.active
      VisibilityComponent.createOrReplace(r.body, { visible: s.active })
    }
    if (s.lit !== r.visibleAsLit) {
      r.visibleAsLit = s.lit
      if (s.lit) addFlame(r)
      else removeFlame(r) // the owner reset their round — snuff it back out for everyone watching
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
 * the fill resets to 0, it does not pause and resume. Eligibility is just
 * "active and unlit" — ANY visible candle, mine or someone else's, since
 * anyone can light anyone's (on request).
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
      if (!r.visibleAsActive || r.visibleAsLit) continue
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
  // Also cancels cleanly if someone else lights this exact candle out from
  // under me mid-channel — r.visibleAsLit is only ever true after
  // syncStationVisuals() observes the real synced flip, so this can't race
  // ahead of what everyone else will also see. Re-checking !r.visibleAsActive
  // here (not just at acquisition) matters because it's someone ELSE'S round
  // that can end and reset mid-channel — the owner's client can deactivate
  // this exact station out from under me at any moment, independent of
  // anything happening on my own client.
  if (r === undefined || isPlayerDead || !r.visibleAsActive || r.visibleAsLit || distToRendered(r) > CHANNEL_MAX_DISTANCE + 0.4) {
    cancelChannel()
    return
  }
  channelProgress = (channelProgress ?? 0) + dt
  if (channelProgress >= CANDLE_CHANNEL_SECONDS) {
    lightStation(target.station, Transform.get(r.root).position)
    cancelChannel()
  }
}

/** Is the player currently in range of ANY unlit active candle (mine or someone else's)? Drives the "hold to light" HUD prompt. */
export function canLightNearby(): boolean {
  for (const r of rendered.values()) {
    if (!r.visibleAsActive || r.visibleAsLit) continue
    if (distToRendered(r) <= CHANNEL_MAX_DISTANCE) return true
  }
  return false
}

function cancelChannel() {
  channelTarget = null
  channelProgress = null
}

function lightStation(stationEntity: Entity, pos: Vector3) {
  // A safe, order-independent flip regardless of whose candle this is (see
  // the CandleStation comment in multiplayer.ts) — syncStationVisuals()
  // picks up the change for every client, so everyone sees it light.
  lightCandleStation(stationEntity)
  playSoundAt(SOUND_CANDLE_LIGHT, pos, 0.8)
  // "Someone has lit a candle" — everyone in the house sees it. bus.emit
  // never echoes back to me, so my own toast is pushed locally alongside it.
  const myName = getPlayer()?.name ?? 'A player'
  pushToast(`${myName} lit a candle`)
  bus.emit('sh_candlelit', { name: myName })

  // Credit always goes to whoever personally channelled it (on request) —
  // not to whichever pool the candle happened to come from. Any visible
  // active candle, mine or someone else's, counts toward MY OWN progress
  // the moment I'M the one who finishes lighting it.
  candlesLit += 1
  if (!portalReady && candlesLit >= getCandlesRequired()) unlockPortal()
}

// --- the portal -------------------------------------------------------------
interface Portal {
  root: Entity
  glow: Entity
  hitbox: Entity
}
let portal: Portal | null = null
let portalPosition: Vector3 | null = null // where the portal opened (for the walk-through win)

function unlockPortal() {
  cancelChannel() // nothing left to channel — you've already earned the win
  portalReady = true
  portalCountdown = PORTAL_WIN_TIMEOUT_SECONDS
  // Invulnerable from this instant: every hazard gates on isInvulnerable(),
  // so this doesn't just avoid COUNTING a death against you (defeat()'s own
  // portalReady guard already did that) — it stops the death from happening
  // at all, so there's no walk-of-shame respawn cycle between "you won" and
  // actually reaching the portal.
  setQuestInvulnerable(true)

  portalPosition = Vector3.create(PORTAL_POSITION.x, PORTAL_POSITION.y, PORTAL_POSITION.z)
  playSoundAt(SOUND_PORTAL_APPEAR, portalPosition, 1, 1, true) // global — on request, everyone should hear a portal/win moment regardless of distance
  pushToast('Your portal has opened in the backyard!')

  const root = engine.addEntity()
  Transform.create(root, {
    position: Vector3.create(PORTAL_POSITION.x, PORTAL_POSITION.y + PORTAL_HEIGHT_OFFSET, PORTAL_POSITION.z),
    scale: Vector3.create(PORTAL_RADIUS * 2, PORTAL_RADIUS * 2, PORTAL_RADIUS * 2)
  })
  MeshRenderer.setSphere(root)
  Material.setPbrMaterial(root, {
    albedoColor: Color4.create(PORTAL_COLOR.r, PORTAL_COLOR.g, PORTAL_COLOR.b, 0.85),
    emissiveColor: Color4.create(PORTAL_COLOR.r, PORTAL_COLOR.g, PORTAL_COLOR.b, 1),
    emissiveIntensity: 2.6,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    metallic: 0,
    roughness: 0.2
  })

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
      if (PORTAL_WIN_TIMEOUT_SECONDS - portalCountdown < PORTAL_ENTRY_DELAY_SECONDS) return
      win()
    }
  )

  portal = { root, glow, hitbox }
}

function removePortal() {
  if (portal !== null) {
    pointerEventsSystem.removeOnPointerDown(portal.hitbox)
    engine.removeEntity(portal.hitbox)
    engine.removeEntity(portal.glow)
    engine.removeEntity(portal.root)
    portal = null
  }
  portalPosition = null
  portalReady = false
  portalCountdown = 0
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
  bestWinTimes.push(lastWinSeconds)
  bestWinTimes.sort((a, b) => a - b)
  if (bestWinTimes.length > 5) bestWinTimes.length = 5
  updateMyBestTime(bestWinTimes[0]) // share my fastest escape so every board can rank it
  phaseCountdown = WIN_RESET_SECONDS
  setQuestInvulnerable(true) // nothing can kill you mid-celebration
  playSoundAt(SOUND_VICTORY, playerPosition, 1, 1, true) // global — a win should be heard scene-wide, not just up close
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

function resetRound() {
  if (roundNumber === 1) roundNumber = 2 // advance past the easier first round
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
  assignRitualCandles() // a fresh random subset every run — also resets MY stations' lit state (setMyStationsForRound)
  candlesLit = 0
  hearts = ROUND_HEARTS
  roundRemaining = ROUND_SECONDS
  roundDeaths = 0
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

function loopSystem(dt: number) {
  if (!gameStarted) return

  // win/defeat screen counts down, then the next round starts itself
  if (roundPhase !== 'playing') {
    phaseCountdown -= dt
    if (phaseCountdown <= 0) resetRound()
    return
  }

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

  // the portal's courtesy auto-win timer
  if (portalReady) {
    portalCountdown -= dt
    if (portalCountdown <= 0) {
      win()
      return
    }
    // Walk-through win: stand in the portal to escape — no tap needed (mobile
    // can't tap the 3D portal). Tapping it still works, gated by the same
    // PORTAL_ENTRY_DELAY_SECONDS below — on request, neither path can enter
    // until the portal's been up a full 5 seconds.
    if (portalPosition !== null && PORTAL_WIN_TIMEOUT_SECONDS - portalCountdown >= PORTAL_ENTRY_DELAY_SECONDS) {
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

  onPlayerDeath(() => {
    if (roundPhase !== 'playing') return
    roundDeaths += 1
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
