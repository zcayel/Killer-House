/**
 * PERSISTENT SCORES, CLIENT SIDE — the half of the leaderboard that runs where
 * the player is. The half that remembers lives in server/server.ts.
 *
 * WHAT WAS ACTUALLY BROKEN. Two things fed the board and both were
 * session-scoped by design: `bestWinTimes` in gameLoop.ts is a module-level
 * array that dies with the JS runtime, and `PlayerStats` in multiplayer.ts is
 * synced over Decentraland's serverless room, whose state — as the docs say
 * plainly — is not persisted once all players leave. So the board emptied
 * every time the room went cold. leaderboard.ts was never at fault; it was
 * faithfully drawing data that had already evaporated.
 *
 * THIS FILE NO LONGER TALKS HTTP. It briefly did: an earlier pass concluded
 * Decentraland had no storage of its own and pointed the scene at Supabase
 * over signedFetch. That was wrong. `Storage` (from @dcl/sdk/server, on the
 * auth-server branch) is first-party and free,
 * and the whole external-database detour — the account, the API key, the SQL,
 * the keep-alive cron — is gone. What is left is three messages.
 *
 * THE CONTRACT WITH gameLoop.ts IS UNCHANGED ON PURPOSE. `persistedScores()`
 * still returns the same ScoreEntry[] it always did, so escapeRanking() —
 * which merges this with the live in-room players and your own session best —
 * did not have to be touched when the backend was swapped out from under it.
 * That is the seam working.
 */

import { getPlayer } from '@dcl/sdk/players'
import { room } from './shared/messages'
import { addSafeSystem, reportFailure } from './safeSystem'

export interface DeathEntry {
  name: string
  address: string
  deaths: number
}

export interface ScoreEntry {
  name: string
  /** Lowercased wallet address, as the server stores it. */
  address: string
  bestTime: number
  /** Hearts left on the run that set bestTime. -1 = not recorded. */
  hearts: number
}

/** Matches the server's floor. Checked here too, to not waste a round trip. */
const MIN_PLAUSIBLE_SECONDS = 20

let persisted: ScoreEntry[] = []
let persistedDeathRows: DeathEntry[] = []
let helloSent = false
let sinceStart = 0
/** Fastest time already handed to the Room, so a slower run isn't re-sent. */
let bestSubmitted = 0
/** Has the server ever answered? Drives the watchdog below. */
let boardReceived = false
let watchdogFired = false

/** Give the profile this long to load before sending `hello` without a name. */
const NAME_WAIT_SECONDS = 5

/**
 * How long to wait for the server's first `board` before declaring this broken.
 *
 * THE WHOLE POINT OF THIS WATCHDOG is that a missing leaderboard server is
 * INVISIBLE. The scene loads, the traps work, the round plays, the board even
 * shows your own time (escapeRanking() merges local session state) — and
 * nothing anywhere says the persistence layer never connected. That is exactly
 * how a whole afternoon went into "the score didn't save": the failure mode
 * looks identical to success until you exit and come back.
 *
 * Anything that stops the server reaching us trips this: the multiplayer server
 * failing to spawn, comms never connecting, a scene.json that lost
 * `authoritativeMultiplayer`, or an SDK that resolved off the auth-server
 * branch. 45s is comfortably past a slow cold start.
 */
const BOARD_TIMEOUT_SECONDS = 45

/**
 * The all-time board as the server last sent it: sorted, trimmed, ready to
 * draw. Returns the live array rather than a copy — this sits in a render
 * path and callers only read it.
 */
export function persistedScores(): ScoreEntry[] {
  return persisted
}

/** The all-time most-killed board, worst first, as last sent by the server. */
export function persistedDeaths(): DeathEntry[] {
  return persistedDeathRows
}

/**
 * Tell the server I just died. One call, one death.
 *
 * Fire-and-forget: the Room queues it if the connection isn't up, and a lost
 * death is a tally being one short, not a record being wrong. It is
 * deliberately NOT deduplicated the way submitScore is — every death is a real,
 * separate event, and suppressing repeats would undercount the players who die
 * most, who are exactly the ones this board is about.
 */
export function recordDeath(): void {
  room.send('recordDeath', { name: myName() })
}

/**
 * Offer a finished run to the board. Cheap to call on every win.
 *
 * SENDS UNCONDITIONALLY, and that is the fix for the bug that made this whole
 * migration look like it had failed. This used to be gated behind
 * `isStateSyncronized()`, on the assumption that sending before the connection
 * was up would lose the message. The opposite was true:
 *
 *   - `Room.send()` ALREADY queues when the room isn't ready and flushes the
 *     queue the moment it is, so an early send is safe by construction.
 *   - `isStateSyncronized()` only becomes true after a full CRDT handshake in
 *     which the authoritative server answers RES_CRDT_STATE. Until that lands
 *     it is false — and in a local preview whose multiplayer server failed to
 *     start, it is false FOREVER.
 *
 * So the gate meant `room.send` was never called at all, the Room never got the
 * chance to queue anything, and every escape was silently dropped on the client
 * before it ever reached the network. The board still showed the time because
 * escapeRanking() merges bestWinTimes from local session memory — which is
 * exactly what made it look like the score had saved and then been lost.
 */
export function submitScore(seconds: number, hearts: number): void {
  if (seconds < MIN_PLAUSIBLE_SECONDS) return
  if (bestSubmitted > 0 && seconds >= bestSubmitted) return
  bestSubmitted = seconds

  room.send('submitEscape', { seconds, hearts, name: myName() })
  console.log(`[Client] submitEscape sent: ${seconds}s, ${hearts} hearts (queued if the room isn't up yet)`)
}

function myName(): string {
  const name = getPlayer()?.name
  return name !== undefined && name !== null ? name : ''
}

/**
 * Say hello once, so a player walking in is sent the board immediately rather
 * than waiting for somebody to set a record and trigger a broadcast.
 *
 * The ONLY thing this waits for is the profile name, which loads a beat after
 * the scene does — and it gives up waiting after NAME_WAIT_SECONDS rather than
 * holding out forever, because a guest may never get one. It deliberately does
 * NOT wait on any connection state: the Room queues this if it has to.
 */
function syncSystem(dt: number): void {
  sinceStart += dt

  if (!helloSent) {
    const name = myName()
    if (name !== '' || sinceStart >= NAME_WAIT_SECONDS) {
      helloSent = true
      room.send('hello', { name })
    }
  }

  // Say so, loudly, once. Silence here used to mean "everything is fine" and
  // "the leaderboard is not connected to anything" at the same time.
  if (!boardReceived && !watchdogFired && sinceStart >= BOARD_TIMEOUT_SECONDS) {
    watchdogFired = true
    const message = `no leaderboard board received after ${BOARD_TIMEOUT_SECONDS}s — scores will NOT persist`
    reportFailure('scores', message)
    console.log(`[Client] ${message}. Check that the authoritative server is running (npm run server-logs).`)
  }
}

export function initScores(): void {
  room.onMessage('board', (data) => {
    try {
      const payload = JSON.parse(data.json) as { escapes?: ScoreEntry[]; deaths?: DeathEntry[] }
      if (payload === null || typeof payload !== 'object') return
      const rows = Array.isArray(payload.escapes) ? payload.escapes : []
      const deathRows = Array.isArray(payload.deaths) ? payload.deaths : []

      persistedDeathRows = deathRows
        .filter((r) => r !== null && typeof r === 'object' && typeof r.deaths === 'number' && r.deaths > 0)
        .map((r) => ({
          name: typeof r.name === 'string' && r.name !== '' ? r.name : 'Stranger',
          address: typeof r.address === 'string' ? r.address.toLowerCase() : '',
          deaths: Math.round(r.deaths)
        }))

      // Re-validated rather than trusted wholesale: this lands straight in a
      // render path, and one malformed row would otherwise draw as "undefined"
      // across a plate on a board people look at from across the room.
      persisted = rows
        .filter((r) => r !== null && typeof r === 'object' && typeof r.bestTime === 'number' && r.bestTime > 0)
        .map((r) => ({
          name: typeof r.name === 'string' && r.name !== '' ? r.name : 'Stranger',
          address: typeof r.address === 'string' ? r.address.toLowerCase() : '',
          bestTime: Math.round(r.bestTime),
          hearts: typeof r.hearts === 'number' ? Math.round(r.hearts) : -1
        }))
      boardReceived = true
      console.log(`[Client] leaderboard updated — ${persisted.length} escapes, ${persistedDeathRows.length} death rows`)
    } catch (e) {
      // Keep whatever was last drawn. A bad frame of data is not a reason to
      // blank a board that was correct a second ago.
      console.log(`[Client] could not parse the board: ${e}`)
    }
  })

  addSafeSystem(syncSystem, 'scoresSync')
}
