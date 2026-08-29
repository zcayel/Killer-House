/**
 * CLIENT <-> SERVER MESSAGES. Imported by BOTH sides, which is the whole point
 * of it living in shared/ — registerMessages() builds a wire format from these
 * definitions, so the two ends have to be reading the same file or the schemas
 * silently disagree.
 *
 * THE SCOPE HERE IS DELIBERATELY TINY. Killer House is not becoming a
 * server-authoritative game: the traps, skeletons, candles, doors and the
 * round clock all still run per-client exactly as they did (see the header of
 * multiplayer.ts for why that was chosen, and it has not changed). The server
 * added alongside them owns ONE thing — the leaderboard that has to survive
 * everyone leaving — and these three messages are its entire surface area.
 *
 * A LEADERBOARD IS THE ONE PART OF THIS GAME THAT MUST NOT BE CLIENT-TRUSTED,
 * and this is what fixes it. `submitEscape` carries a time but NOT an address:
 * the server reads the sender from `context.from`, which the platform has
 * already verified cryptographically. A client cannot post a time in someone
 * else's name, because it never gets to say whose name it is.
 */

import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

export const Messages = {
  /**
   * CLIENT -> SERVER, once, as soon as state is synced.
   *
   * Exists so a player who walks in sees the board immediately instead of
   * waiting for somebody to escape and trigger a broadcast. The name is sent
   * so the server can keep its stored spelling current even for a player who
   * never wins anything.
   */
  hello: Schemas.Map({ name: Schemas.String }),

  /**
   * CLIENT -> SERVER on a win. The server decides whether it counts.
   *
   * `name` is here because the server has no way to look up a display name on
   * its own — it only ever sees wallet addresses. `seconds` and `hearts` are
   * claims, and are treated as such: see the clamps in server.ts.
   *
   * THESE THREE DESCRIBE ONE RUN and must stay that way. Sending the best-ever
   * time with this run's hearts would staple together two different escapes and
   * put a number on the board that never happened.
   */
  submitEscape: Schemas.Map({ seconds: Schemas.Int, hearts: Schemas.Int, name: Schemas.String }),

  /**
   * CLIENT -> SERVER, once per death.
   *
   * AN INCREMENT, NOT A TOTAL. The client says "I died", the server adds one to
   * that wallet's tally. Sending a running total instead would let a reconnect
   * or a scene reload re-report deaths the server already counted, and the
   * number would drift upward on its own. One message, one death.
   */
  recordDeath: Schemas.Map({ name: Schemas.String }),

  /**
   * SERVER -> CLIENT. Both boards as one JSON string.
   *
   * A STRING RATHER THAN A TYPED ARRAY because Schemas has no ergonomic
   * variable-length array of records, and the board is small (ten rows, a few
   * hundred bytes) and changes rarely — only when somebody sets a record. The
   * cost of parsing it is nothing next to the cost of modelling it.
   *
   * Shape: { escapes: [{ name, address, bestTime, hearts }],
   *          deaths:  [{ name, address, deaths }] }
   * Each list is already sorted and trimmed by the server, so the client
   * renders what it is given without re-deriving anything. They are separate
   * lists because they rank different people: the fastest escapist and the
   * most-killed player are rarely the same player.
   */
  board: Schemas.Map({ json: Schemas.String })
}

export const room = registerMessages(Messages)
