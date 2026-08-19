/**
 * MULTIPLAYER LAYER — the parts of the scene that genuinely need cross-player
 * data (fastest-escape ranking, remote death/result info). Everything that
 * matters for actually PLAYING the game (skeletons, traps, doors, candles,
 * the portal) runs entirely per-client now, on purpose: real testing found
 * this specific pairing's devices don't reliably detect each other at the
 * platform level, so anything gameplay-critical can't depend on that
 * connection working. What's left here rides on syncEntity — the
 * actively-maintained SDK7 sync API. (The old MessageBus is deprecated and
 * doesn't deliver reliably in current clients, so it is NOT used.)
 *
 *  - One-shot events (this file's `bus`): each client owns one synced
 *    "outbox" entity. Emitting writes {seq, kind, data} to it; every other
 *    client sees the component change and dispatches to its handlers.
 *    Late joiners skip whatever happened before they arrived.
 *  - Ongoing STATE (PlayerStats, and the candle stations below): each client
 *    owns and syncs its own entity/entities; everyone else just reads the
 *    current value, so unlike the event bus, late joiners see the real
 *    up-to-date state immediately, not just future changes.
 *  - `isSimulationHost`/host election is kept only for whatever still uses
 *    it (currently just the parked ghost NPC) — the lowest connected address
 *    is host, computed identically by everyone, no negotiation needed.
 */

import { engine, Transform, PlayerIdentityData, Schemas, Entity } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { syncEntity } from '@dcl/sdk/network'
import { getPlayer } from '@dcl/sdk/players'
import { onPlayerDeath } from './gameState'
import { addSafeSystem, reportFailure } from './safeSystem'
import { pushToast } from './notifications'

// One per client. seq bumps on every event; kind/data describe the latest one.
const EventOutbox = engine.defineComponent('spooky::event-outbox', {
  seq: Schemas.Int,
  kind: Schemas.String,
  data: Schemas.String
})

// One per client: my running score, synced as plain STATE. Other clients
// just read the current values — nothing to miss, late joiners see the
// up-to-date tally immediately. Feeds the physical leaderboard. bestTime is
// my fastest escape in seconds (0 = never escaped yet) — the primary
// competitive score ranked across every player in the scene.
const PlayerStats = engine.defineComponent('spooky::player-stats', {
  name: Schemas.String,
  deaths: Schemas.Int,
  bestTime: Schemas.Int
})

// One entity per MY OWN candle station (13, one per CANDLE_POOL cluster
// point).
//
// PRIVATE TO THE OWNER, both ways. You can only light your own, and now you
// can only SEE your own: no client renders another client's station in any
// state, lit or unlit (see syncStationVisuals in gameLoop.ts). Week 2
// playtest feedback drove this — testers couldn't tell which candles were
// theirs, and another player's flame standing at the same cluster point read
// as an objective that had either already been done or was refusing to
// respond. With this rule there is exactly one kind of candle in the world
// and every one of them is yours.
//
// EVERY FIELD HERE IS WRITTEN ONLY BY THE CLIENT THAT OWNS THE STATION,
// `lit` included. That single property is what makes the whole candle system
// safe and easy to reason about — there is no concurrent write anywhere in
// it, no ordering to get right, and no way for one player's round to reach
// into another's.
//
// The syncEntity call below is now doing nothing visible, since nobody reads
// anyone else's stations. It is left in deliberately rather than removed:
// flipping shared flames back on is a one-line change in gameLoop.ts's
// syncStationVisuals while this stays, and the traffic is a handful of
// booleans on a component that only changes when a candle is lit or a round
// resets. Drop it if the private rule is confirmed to be permanent.
// (An earlier version let ANY player flip `lit` on ANY candle. The write
// itself was race-free, but it meant the first player to reach a candle
// removed it from everyone else's ritual — and since each player draws
// exactly the number of candles they need, a player whose candles were taken
// could be left unable to finish the round at all.)
//
// I create exactly MY OWN CANDLE_POOL.length of these, once, at init — never anyone else's.
// With no host and no election (see this file's header), that's what avoids
// duplication: if every client tried to create a shared global set of
// station entities, each client's local engine.addEntity() calls would
// replicate out AND arrive back from every other client, multiplying the
// count by however many players are connected — the same class of bug as
// the documented "six skeletons, three configured" host-election failure,
// just via a different mechanism. Creating only what's mine and reading
// everyone else's the same way readRemoteStats() already does for
// PlayerStats sidesteps that entirely.
const CandleStation = engine.defineComponent('spooky::candle-station', {
  index: Schemas.Int, // which CANDLE_POOL cluster point (0..N-1)
  // CANDLE_OFFSET_BUCKETS index. Originally this kept two owners' candles at
  // the same cluster point from rendering on top of each other; with private
  // candles there is nothing to overlap with anymore, so all it still buys is
  // that two players working "the same" spot stand half a metre apart instead
  // of inside each other. Kept for that, and because shared visibility needs
  // it again if it ever comes back.
  offsetBucket: Schemas.Int,
  active: Schemas.Boolean, // is this one of MY drawn candles this round (vs sitting out, hidden)
  lit: Schemas.Boolean // burning
})

const myStationEntities: Entity[] = []

/**
 * Random per-SESSION bucket, picked once and kept for the whole session.
 * Originally this hashed myId() (the player's wallet address) instead —
 * deterministic and stable, but it meant two connections sharing the same
 * wallet (e.g. testing with the same account on PC and mobile at once, a
 * very real scenario, not a hypothetical) got the IDENTICAL bucket every
 * time — their entire candle clusters rendered exactly on top of each
 * other, indistinguishable, with channel-target-picking silently landing on
 * whichever overlapping station happened to be nanometers closer. A random
 * per-session pick has no such guaranteed collision: it doesn't care
 * whether two connections share a wallet, only that each one rolled
 * independently. Stability across the session (not shifting just because
 * someone else joins/leaves) was always the actual requirement — nothing
 * required it to be a pure function of identity.
 */
export function myOffsetBucketIndex(bucketCount: number): number {
  return bucketCount > 0 ? Math.floor(Math.random() * bucketCount) : 0
}

/** Create MY OWN `count` candle stations (idempotent — only ever called once, from initGameLoop). */
export function createMyCandleStations(count: number, offsetBucket: number): Entity[] {
  for (let i = 0; i < count; i++) {
    const e = engine.addEntity()
    CandleStation.create(e, { index: i, offsetBucket, active: false, lit: false })
    syncEntity(e, [CandleStation.componentId])
    myStationEntities.push(e)
  }
  return myStationEntities.slice()
}

export interface MyCandleStation {
  entity: Entity
  index: number
  offsetBucket: number
  active: boolean
  lit: boolean
}

/**
 * MY OWN candle stations, and only mine — the complete set gameLoop.ts
 * renders.
 *
 * Candles are private now (playtest feedback: testers couldn't tell which
 * candles were theirs, and other players' flames read as objectives that
 * silently refused to respond). Nothing in the scene draws or reads another
 * player's station anymore, so this deliberately iterates myStationEntities
 * directly rather than engine.getEntitiesWith(CandleStation): the cost is a
 * fixed CANDLE_POOL.length per frame instead of that times however many
 * players are connected.
 *
 * Their stations still arrive over the wire and still sit in the engine —
 * see the note on CandleStation above for why the sync is left in place.
 */
export function myCandleStations(): MyCandleStation[] {
  const out: MyCandleStation[] = []
  for (const entity of myStationEntities) {
    const data = CandleStation.getOrNull(entity)
    if (data === null) continue
    out.push({ entity, index: data.index, offsetBucket: data.offsetBucket, active: data.active, lit: data.lit })
  }
  return out
}

/**
 * Light one of MY OWN candles. Ignores any entity that isn't mine — the
 * caller already only ever picks from my own stations, and this makes "a
 * station is written only by its owner" a property of this module rather
 * than something every caller has to keep remembering.
 */
export function setMyStationLit(entity: Entity) {
  if (!myStationEntities.includes(entity)) return
  if (CandleStation.has(entity)) CandleStation.getMutable(entity).lit = true
}

/**
 * Owner-only: (re)draw which of MY OWN stations stand in the world this
 * round, and snuff them all back out. Nothing else can write these, so once
 * drawn they are guaranteed to stay standing and lightable for the rest of
 * my round — no other player's progress or round reset can take one of my
 * candles away from me.
 */
export function setMyStationsForRound(activeIndices: Set<number>) {
  for (const e of myStationEntities) {
    if (!CandleStation.has(e)) continue
    const data = CandleStation.getMutable(e)
    data.active = activeIndices.has(data.index)
    data.lit = false
  }
}

type Handler = (value: any, sender: string) => void
const handlers: Record<string, Handler[]> = {}
const outgoing: { kind: string; data: string }[] = []
let myOutbox: Entity | null = null
const lastSeen = new Map<Entity, number>()

/**
 * MessageBus-shaped API over the synced outbox, so game code just does
 * bus.emit('sh_spike', {...}) / bus.on('sh_spike', cb). Own events are never
 * echoed back to the local client.
 */
export const bus = {
  emit(kind: string, payload: Record<string, any>) {
    outgoing.push({ kind, data: JSON.stringify(payload) })
  },
  on(kind: string, cb: Handler) {
    if (handlers[kind] === undefined) handlers[kind] = []
    handlers[kind].push(cb)
  }
}

function eventSystem(_dt: number) {
  // Flush one queued outgoing event per frame. One CRDT write per frame per
  // client is plenty for deaths/trap triggers, and guarantees no event is
  // lost by two writes landing in the same tick.
  if (myOutbox !== null && outgoing.length > 0) {
    const next = outgoing.shift()
    if (next !== undefined) {
      const box = EventOutbox.getMutable(myOutbox)
      box.seq += 1
      box.kind = next.kind
      box.data = next.data
    }
  }

  // Read everyone else's outboxes; dispatch anything new.
  for (const [entity, box] of engine.getEntitiesWith(EventOutbox)) {
    if (entity === myOutbox) continue
    const prev = lastSeen.get(entity)
    if (prev === undefined) {
      // First time seeing this outbox (scene start or late join): record its
      // current seq without dispatching, so old events aren't replayed.
      lastSeen.set(entity, box.seq)
      continue
    }
    if (box.seq === prev) continue
    lastSeen.set(entity, box.seq)

    const list = handlers[box.kind]
    if (list === undefined) continue
    let value: any = {}
    try {
      value = JSON.parse(box.data)
    } catch (_) {}
    // Isolated per handler and per remote entity — one bad handler (or one
    // player's malformed event) must not stop this loop from reaching every
    // OTHER connected player's events this frame.
    for (const cb of list) {
      try {
        cb(value, '')
      } catch (err) {
        console.error(`bus handler for '${box.kind}' threw:`, err)
      }
    }
  }
}

export function myId(): string {
  return (getPlayer()?.userId ?? '').toLowerCase()
}

/** Am I the client that runs the shared simulation (skeleton AI)? */
export function isSimulationHost(): boolean {
  const me = myId()
  if (me === '') return true // profile not loaded yet — simulate alone
  let lowest: string | null = null
  for (const [, data] of engine.getEntitiesWith(PlayerIdentityData)) {
    // data.address can be missing on a player entity that's still mid-connect
    // in-world — guard it so this (called every frame by the skeleton/spike
    // systems) can't throw and take the whole update loop down.
    if (typeof data.address !== 'string' || data.address === '') continue
    const addr = data.address.toLowerCase()
    if (lowest === null || addr < lowest) lowest = addr
  }
  return lowest === null || lowest === me
}

/** Positions of every OTHER player currently in the scene. */
export function otherPlayerPositions(): Vector3[] {
  const out: Vector3[] = []
  try {
    for (const [entity] of engine.getEntitiesWith(PlayerIdentityData, Transform)) {
      if (entity === engine.PlayerEntity) continue
      const p = Transform.get(entity).position
      out.push(Vector3.create(p.x, p.y, p.z))
    }
  } catch (err) {
    // A player entity mid-connect (comms/realm handshake still settling —
    // the same transient window isSimulationHost() above already guards
    // for .address) can throw here. This is called every frame by
    // skeletonSystem; addSafeSystem only isolates a throw AFTER it happens
    // once, and by then the skeleton AI that depends on this read is
    // permanently dead for the rest of the session. Keep whatever positions
    // were already read this frame instead of losing the whole read, and
    // surface it — if this is really what's killing skeletons on mobile,
    // the debug HUD's FAILED row should now say so.
    reportFailure('otherPlayerPositions', err instanceof Error ? err.message : String(err))
  }
  return out
}

/** Addresses of every OTHER player currently in the scene (for AvatarModifierArea.excludeIds — see deathEffects.ts). */
export function otherPlayerIds(): string[] {
  const out: string[] = []
  for (const [entity, data] of engine.getEntitiesWith(PlayerIdentityData)) {
    if (entity === engine.PlayerEntity) continue
    out.push(data.address)
  }
  return out
}

let myStats: Entity | null = null

/** Live stats of every OTHER player in the scene, read from their synced state. */
export function readRemoteStats(): { name: string; deaths: number; bestTime: number }[] {
  const out: { name: string; deaths: number; bestTime: number }[] = []
  for (const [entity, stats] of engine.getEntitiesWith(PlayerStats)) {
    if (entity === myStats) continue
    out.push({ name: stats.name !== '' ? stats.name : 'Stranger', deaths: stats.deaths, bestTime: stats.bestTime })
  }
  return out
}

/** Record my fastest escape (seconds) so every leaderboard in the scene can rank it. */
export function updateMyBestTime(seconds: number) {
  if (myStats === null) return
  const cur = PlayerStats.get(myStats).bestTime
  if (cur === 0 || seconds < cur) PlayerStats.getMutable(myStats).bestTime = seconds
}

function statsNameSystem(_dt: number) {
  // The profile loads a beat after scene start — stamp my name once it's there
  if (myStats === null) return
  const stats = PlayerStats.get(myStats)
  const name = getPlayer()?.name ?? ''
  if (name !== '' && stats.name !== name) {
    PlayerStats.getMutable(myStats).name = name
  }
}

export function initMultiplayer() {
  // My outbox: a tiny synced entity every other client watches for my events.
  myOutbox = engine.addEntity()
  EventOutbox.create(myOutbox, { seq: 0, kind: '', data: '' })
  syncEntity(myOutbox, [EventOutbox.componentId])

  // My scoreboard state: synced out so every leaderboard in the scene has me
  myStats = engine.addEntity()
  PlayerStats.create(myStats, { name: getPlayer()?.name ?? '', deaths: 0, bestTime: 0 })
  syncEntity(myStats, [PlayerStats.componentId])

  onPlayerDeath(() => {
    if (myStats !== null) PlayerStats.getMutable(myStats).deaths += 1
  }, 'multiplayerStats')

  // "Someone has died" — everyone in the house sees it, not just the
  // player it happened to. bus.emit never echoes back to me (see the bus
  // doc comment above), so my own toast is pushed locally alongside it.
  // Includes the cause now, on request (killPlayer(cause) already threads
  // it through onPlayerDeath — this just wasn't using it before).
  onPlayerDeath((cause) => {
    const name = getPlayer()?.name ?? 'A player'
    pushToast(`${name} died — ${cause}`)
    bus.emit('sh_died', { name, cause })
  }, 'multiplayerDeathNotify')
  bus.on('sh_died', (v) => {
    if (typeof v?.name === 'string') {
      const cause = typeof v?.cause === 'string' ? v.cause : 'died'
      pushToast(`${v.name} died — ${cause}`)
    }
  })

  addSafeSystem(eventSystem, 'eventSystem')
  addSafeSystem(statsNameSystem, 'statsNameSystem')
}
