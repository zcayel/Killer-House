/**
 * THE AUTHORITATIVE SERVER — and the only reason one exists in this scene.
 *
 * It runs headlessly, alongside the world deploy, and it does exactly one job:
 * hold the escape leaderboard somewhere that survives every player leaving.
 * It renders nothing, spawns nothing, and knows nothing about traps, candles
 * or skeletons — index.ts returns before any of that is reached on this side.
 *
 * WHY THIS REPLACED AN EXTERNAL DATABASE. The first fix for the resetting
 * leaderboard pointed the scene at Supabase over signedFetch, on the
 * conclusion that Decentraland had no storage of its own. That conclusion was
 * wrong: `Storage` (@dcl/sdk/server) is first-party, free, hosted with the
 * world, and it is what other DCL games are already using — a Goal Legends
 * backup is one Storage key holding one JSON blob keyed by wallet address,
 * precisely the shape below. It is simply invisible from the stable @dcl/sdk;
 * it needs the `auth-server` branch. No account, no API key, no third party,
 * nothing to keep alive.
 *
 * WHAT THE SERVER BUYS BEYOND PERSISTENCE — and this is the bigger half — is
 * that scores stop being client-trusted. The address on a submission is
 * `context.from`, resolved by the platform from a signed message, not a field
 * the client filled in. Over plain HTTP to a database, anyone who unpacked the
 * scene bundle could POST a two-second escape under any name they liked. Here
 * they cannot even name themselves.
 */

import { Storage } from '@dcl/sdk/server'
import { room } from '../shared/messages'

/**
 * The one key everything lives under, versioned in the name.
 *
 * Versioned because the value is a JSON blob whose shape is defined nowhere
 * but in this file. The day it needs a third map, an old server reading a new
 * blob (or the reverse, during a rolling deploy) is a corrupted board rather
 * than an error. Bumping to _v2 makes that a fresh empty board instead — bad,
 * but bad in a way that is instantly obvious rather than subtly wrong.
 */
const STORAGE_KEY = 'killer_house_leaderboard_v1'

/**
 * TWO PARALLEL MAPS, BOTH KEYED BY LOWERCASED WALLET ADDRESS.
 *
 * Not an array of rows: the hot operation is "does this player already have a
 * time, and is it faster than the new one", which is one lookup here and a
 * scan there. Address is the identity because it is the only thing about a
 * player that cannot be changed or spoofed — display names change, and two
 * players can pick the same one.
 *
 * Names are stored rather than looked up because the server has no profile
 * API; the client tells it, and it keeps the most recent spelling.
 */
interface Board {
  times: Record<string, number>
  names: Record<string, string>
  /**
   * Hearts left at the end of the run that set the time above — NOT the most
   * hearts ever, and not the hearts of the latest run. A row has to describe
   * one escape or the board is quietly lying: "0:36 with 3 hearts" when the
   * 0:36 was a bloodbath and the 3-heart run took two minutes.
   */
  hearts: Record<string, number>
  /**
   * Lifetime deaths, across every round and every visit. Unlike times this
   * only ever goes UP, so there is no "keep the better one" rule — every
   * reported death is a real one that already happened.
   */
  deaths: Record<string, number>
}

/** Nothing below this is a human escaping; see also the client-side guard. */
const MIN_SECONDS = 20
/** ROUND_SECONDS in config.ts — a run cannot outlast the round it happened in. */
const MAX_SECONDS = 600
/** How many rows the client is sent. The board art has 5 plates; 10 is slack. */
const TOP_N = 10
/** Longest stored display name, so one player cannot bloat the blob. */
const MAX_NAME_CHARS = 32
/** ROUND_HEARTS in config.ts. A run cannot end with more than it started. */
const MAX_HEARTS = 3

let board: Board = { times: {}, names: {}, hearts: {}, deaths: {} }

/**
 * Until the first Storage read comes back, this server does not know what the
 * record times are, so it cannot decide whether a submitted time is a record.
 */
let loaded = false

/**
 * Submissions that arrived before Storage had loaded, replayed once it has.
 *
 * NOT PARANOIA — this is a live race. The Room queues client messages while it
 * is connecting and delivers them the moment it is ready, which can easily be
 * before this server's first `Storage.get` resolves. Simply dropping those
 * would silently discard genuine records, and the client only re-sends on its
 * NEXT win, which for a player who escaped once and left is never. Queueing
 * costs nothing and closes the window completely.
 */
const deferred: { address: string; seconds: number; hearts: number; name: string }[] = []

/**
 * Deaths that arrived in the same window, queued for the same reason.
 *
 * This used to be a bare `if (!loaded) return`, on the reasoning that "a lost
 * death is a cosmetic tally, not a record". That reasoning is weaker than it
 * looks: the window is widest exactly when the server has just restarted, which
 * is when a room full of players is most likely to be dying, and unlike an
 * escape a death is never re-sent — the client fires once per death and moves
 * on. So the deaths board would quietly run light, by an amount nobody could
 * measure, for the one board whose whole content is a count.
 *
 * An address per death rather than a tally per address: the replay below adds
 * one for each entry, which is the same "one message, one death" rule the wire
 * format is built on (see recordDeath in shared/messages.ts).
 */
const deferredDeaths: { address: string; name: string }[] = []

/**
 * NOTE ON THE STORAGE API, because the obvious guess is wrong twice over.
 *
 * It is `Storage.get/set` for scene-scoped data — NOT `Storage.world.*`, which
 * does not exist (`IStorage extends ISceneStorage`, and only the player scope
 * is namespaced, as `Storage.player`). And it SERIALIZES FOR YOU: `set` takes
 * any value and JSON-encodes it, `get<T>` returns the parsed value or null.
 * Wrapping these calls in JSON.stringify/JSON.parse would double-encode the
 * board into a string-containing-a-string and it would come back unusable.
 *
 * Verified against @dcl/sdk@auth-server's own .d.ts, not from documentation.
 */
async function load(): Promise<void> {
  try {
    const stored = await Storage.get<Partial<Board>>(STORAGE_KEY)
    if (stored !== null && stored !== undefined && typeof stored === 'object') {
      // Defensive: a blob written by an older or newer shape must not leave
      // `times`/`names` undefined, because every read below assumes objects.
      board = {
        times: stored.times !== undefined ? stored.times : {},
        names: stored.names !== undefined ? stored.names : {},
        // Absent in blobs written before hearts existed. Those rows keep their
        // times and simply report hearts as unknown — see topJson().
        hearts: stored.hearts !== undefined ? stored.hearts : {},
        deaths: stored.deaths !== undefined ? stored.deaths : {}
      }
    }
    console.log(`[Server] leaderboard loaded — ${Object.keys(board.times).length} players on record`)
  } catch (e) {
    // Start empty rather than throwing: an unreadable blob must not take the
    // server down and with it the whole world. The next successful write
    // repairs it. This is the one case that can lose scores, so it is loud.
    console.error(`[Server] leaderboard failed to load, starting empty: ${e}`)
    board = { times: {}, names: {}, hearts: {}, deaths: {} }
  }
  loaded = true
}

async function save(): Promise<void> {
  try {
    // set() reports failure by RETURNING FALSE, not by throwing, so a bare
    // try/catch here would let a failed write pass as a successful one — the
    // exact silent data loss this file exists to end.
    const ok = await Storage.set(STORAGE_KEY, board)
    if (!ok) console.error('[Server] leaderboard write was rejected by the storage service')
  } catch (e) {
    // The in-memory board is still correct, so the session carries on and the
    // next record sets up another attempt.
    console.error(`[Server] leaderboard failed to save: ${e}`)
  }
}

/** Display name for an address, however little we know about it. */
function nameOf(address: string): string {
  return board.names[address] !== undefined ? board.names[address] : 'Stranger'
}

/**
 * Both boards, each sorted and trimmed, as one JSON string.
 *
 * TWO SEPARATE LISTS over the same players, because they rank on different
 * things and the top of one has almost nothing to do with the top of the
 * other — the fastest escapist is rarely the most-killed player.
 */
function topJson(): string {
  const escapes = Object.keys(board.times)
    .map((address) => ({
      address,
      name: nameOf(address),
      bestTime: board.times[address],
      // -1 means "not recorded", which is different from 0 ("finished on the
      // last heart"). A row stored before hearts were tracked draws a blank
      // rather than three empty pips it never earned.
      hearts: board.hearts[address] !== undefined ? board.hearts[address] : -1
    }))
    .filter((r) => typeof r.bestTime === 'number' && r.bestTime > 0)
    .sort((a, b) => a.bestTime - b.bestTime)
    .slice(0, TOP_N)

  const deaths = Object.keys(board.deaths)
    .map((address) => ({ address, name: nameOf(address), deaths: board.deaths[address] }))
    .filter((r) => typeof r.deaths === 'number' && r.deaths > 0)
    .sort((a, b) => b.deaths - a.deaths) // MOST first — this is a wall of shame
    .slice(0, TOP_N)

  return JSON.stringify({ escapes, deaths })
}

function broadcast(): void {
  room.send('board', { json: topJson() })
}

/**
 * Add one death to a wallet's lifetime tally.
 *
 * NO "did it change anything" RETURN, unlike applyScore: a death always
 * changes the board. Times only move when they beat the stored one, deaths
 * only ever go up, and every message that gets here is one death that really
 * happened (the client fires once, at the moment of it — see recordDeath in
 * shared/messages.ts).
 *
 * Extracted so the live path and the deferred replay cannot drift apart. They
 * were the same six lines in two places, which is exactly how a tally ends up
 * counting one way at startup and another way afterwards.
 */
function applyDeath(address: string, name: string): void {
  const previous = board.deaths[address] !== undefined ? board.deaths[address] : 0
  board.deaths[address] = previous + 1
  if (name !== '') board.names[address] = name
}

/**
 * Fold one verified submission into the board. Returns whether it changed
 * anything, so the caller knows whether a write and a broadcast are warranted.
 */
function applyScore(address: string, seconds: number, hearts: number, name: string): boolean {
  const previous = board.times[address]
  let changed = false

  if (name !== '' && board.names[address] !== name) {
    board.names[address] = name
    changed = true
  }
  // KEEP THE FASTER TIME. A slower run — or the same run submitted twice
  // after a reconnect — must never overwrite a record.
  if (previous === undefined || seconds < previous) {
    board.times[address] = seconds
    board.hearts[address] = hearts // belongs to THIS run, not the best-ever
    changed = true
    console.log(`[Server] new record for ${address}: ${seconds}s (was ${previous === undefined ? 'none' : previous})`)
  }
  return changed
}

export function initServer(): void {
  console.log('[Server] Killer House leaderboard server starting')

  // Read first, then replay anything that arrived while reading, then tell
  // everyone already standing there what the board says. A world can be up
  // before this server restarted, so the broadcast is not redundant with the
  // per-client `hello` reply.
  load().then(() => {
    let changed = false
    for (const d of deferred) {
      if (applyScore(d.address, d.seconds, d.hearts, d.name)) changed = true
    }
    if (deferred.length > 0) {
      console.log(`[Server] replayed ${deferred.length} submission(s) received during load`)
      deferred.length = 0
    }
    for (const d of deferredDeaths) {
      applyDeath(d.address, d.name)
      changed = true
    }
    if (deferredDeaths.length > 0) {
      console.log(`[Server] replayed ${deferredDeaths.length} death(s) received during load`)
      deferredDeaths.length = 0
    }
    if (changed) save()
    broadcast()
  })

  room.onMessage('hello', (data, context) => {
    if (context === undefined) return
    if (!loaded) return // load() ends in a broadcast that covers this client

    // Keep the stored spelling current even for a player who has never won —
    // otherwise a rename only shows up on the board after their next record,
    // and until then the board shows a name nobody recognises.
    const address = context.from.toLowerCase()
    const name = cleanName(data.name)
    if (name !== '' && board.times[address] !== undefined && board.names[address] !== name) {
      board.names[address] = name
      save()
      broadcast()
    }

    room.send('board', { json: topJson() }, { to: [context.from] })
  })

  room.onMessage('recordDeath', (data, context) => {
    if (context === undefined) return

    const address = context.from.toLowerCase()
    const name = cleanName(data.name)

    // QUEUED, NOT DROPPED, if Storage has not answered yet — see
    // deferredDeaths. Incrementing into the in-memory board here instead would
    // be worse than losing it: load() overwrites `board` wholesale when it
    // returns, so the increment would vanish AND the client would have been
    // told it landed.
    if (!loaded) {
      deferredDeaths.push({ address, name })
      return
    }

    applyDeath(address, name)
    save()
    broadcast()
  })

  room.onMessage('submitEscape', (data, context) => {
    if (context === undefined) return

    // THE WHOLE POINT: the address comes from the verified sender, never from
    // the payload. There is no field a client could lie in to claim someone
    // else's row.
    const address = context.from.toLowerCase()
    const seconds = Math.round(data.seconds)
    const hearts = Math.round(data.hearts)
    const name = cleanName(data.name)

    // A claim, treated as one. Dropped silently — a client that is lying does
    // not deserve a reply, and a client that is merely buggy will try again.
    if (!(seconds >= MIN_SECONDS && seconds <= MAX_SECONDS)) {
      console.log(`[Server] rejected implausible time ${seconds}s from ${address}`)
      return
    }
    // Clamped rather than rejected: a wrong heart count is cosmetic, and
    // throwing away a genuine record over it would be the worse failure.
    // 0 is legitimate — the portal can be reached on the last heart.
    if (!(hearts >= 0 && hearts <= MAX_HEARTS)) {
      console.log(`[Server] clamped implausible hearts ${hearts} from ${address}`)
    }
    const safeHearts = Math.min(MAX_HEARTS, Math.max(0, hearts))

    // Validated but not yet comparable — hold it for the replay above.
    if (!loaded) {
      deferred.push({ address, seconds, hearts: safeHearts, name })
      return
    }

    if (!applyScore(address, seconds, safeHearts, name)) return
    save()
    broadcast()
  })
}

/** Trimmed, length-capped, and never undefined. '' means "don't store one". */
function cleanName(raw: string): string {
  if (typeof raw !== 'string') return ''
  return raw.trim().slice(0, MAX_NAME_CHARS)
}
