import { isServer } from '@dcl/sdk/network'
import { setupUi } from './ui'
import { initGameState } from './gameState'
import { initNotifications } from './notifications'
import { initMultiplayer } from './multiplayer'
import { initPlayerTracker } from './playerTracker'
import { initWallSpikes } from './traps/wallSpikes'
import { initChandelierCrush } from './traps/chandelierCrush'
import { initSwingTraps } from './traps/swingTraps'
import { initFallDeath } from './traps/fallDeath'
import { initFenceTips } from './traps/fenceTips'
import { initDeathCam } from './effects/deathCam'
import { initVictoryCinematic } from './effects/victoryCinematic'
import { initPlotBoundary } from './plotBoundary'
import { initSkeletons } from './enemies/skeletons'
import { initDeathEffects } from './effects/deathEffects'
import { initQuake } from './effects/quake'
import { initCameraShake } from './effects/cameraShake'
import { initForceField } from './effects/forceField'
import { initSounds } from './sounds'
import { initCombat } from './combat'
import { initGameLoop } from './gameLoop'
import { initCandles } from './candles'
import { initLightning } from './lightning'
import { initDoors } from './doors'
import { initDust } from './dust'
import { initOldTable } from './decor/oldTable'
import { initLeaderboard } from './leaderboard'
import { initScores } from './scores'
import { safeInit } from './safeSystem'

// Guards against main() ever running twice on the same live engine. Live
// testing found SIX skeletons on one mobile device where exactly 3 are
// configured (SKELETON_SPAWNS in config.ts) — with no syncEntity uniqueness
// check left in that code anymore (skeletons are per-client, see the note at
// the top of enemies/skeletons.ts), a second, un-guarded main() call would
// silently double every entity this scene creates, not just skeletons, since
// none of them have their own duplicate-detection. This one flag protects
// everything main() creates, in one place, regardless of why main() might
// ever be invoked twice on a client (e.g. a scene re-entry that doesn't fully
// reset the JS runtime state — a known category of issue on some clients).
let hasRun = false

export async function main() {
  if (hasRun) {
    console.error('[index] main() was called again on an already-running engine — ignoring the second call to avoid duplicating every entity in the scene.')
    return
  }
  hasRun = true

  // THE SERVER RUNS THIS SAME FILE, HEADLESSLY, so the branch has to come
  // before everything — before setupUi(), before a single safeInit. Nothing
  // below this point makes sense without a player attached to it: it would
  // spawn a second full set of traps, skeletons and candles into the world
  // with nobody to see them, which is the "six skeletons, three configured"
  // failure again by a different route.
  //
  // The server owns ONE thing, the persistent leaderboard (server/server.ts).
  // Gameplay is untouched and still runs entirely per-client — see the header
  // of multiplayer.ts for why, which this change does not revisit.
  //
  // Imported dynamically so a client never pulls in @dcl/sdk/server at all.
  if (isServer()) {
    const { initServer } = await import('./server/server')
    initServer()
    return
  }

  setupUi()

  // Every init runs in its own try/catch (safeInit) — one throwing must not
  // stop every init call listed after it from ever running (see the comment
  // on safeInit in safeSystem.ts). Systems themselves are separately
  // protected by addSafeSystem inside each of these.
  safeInit(initGameState, 'initGameState')
  safeInit(initNotifications, 'initNotifications')
  safeInit(initMultiplayer, 'initMultiplayer')
  safeInit(initPlayerTracker, 'initPlayerTracker')
  safeInit(initDeathEffects, 'initDeathEffects')
  // Before initPlotBoundary — the boundary calls forceFieldHit(), which no-ops
  // until this has built its entities.
  safeInit(initForceField, 'initForceField')
  safeInit(initSounds, 'initSounds')

  safeInit(initWallSpikes, 'initWallSpikes')
  safeInit(initChandelierCrush, 'initChandelierCrush')
  safeInit(initSwingTraps, 'initSwingTraps')
  safeInit(initFallDeath, 'initFallDeath')
  safeInit(initFenceTips, 'initFenceTips')
  safeInit(initDeathCam, 'initDeathCam')
  // Before initGameLoop, which is what calls into it on a win.
  safeInit(initVictoryCinematic, 'initVictoryCinematic')
  safeInit(initPlotBoundary, 'initPlotBoundary')
  safeInit(initSkeletons, 'initSkeletons')

  safeInit(initCombat, 'initCombat')
  // Quest progression is parked — the ritual round IS the game now.
  safeInit(initGameLoop, 'initGameLoop')
  safeInit(initCandles, 'initCandles')
  safeInit(initLightning, 'initLightning')
  safeInit(initDoors, 'initDoors')
  safeInit(initDust, 'initDust')
  safeInit(initOldTable, 'initOldTable')
  // Before initLeaderboard: this fires the first read of the persisted board,
  // so the plates have real data to paint as soon as they are adopted rather
  // than showing "Be the first" to a scene that has had a hundred escapes.
  safeInit(initScores, 'initScores')
  safeInit(initLeaderboard, 'initLeaderboard')
  // LAST, deliberately. initQuake snapshots the scenery it is allowed to move,
  // and anything spawned after this point is excluded from that list — which is
  // exactly what keeps the synced tombstones out of it.
  safeInit(initQuake, 'initQuake')
  safeInit(initCameraShake, 'initCameraShake')
}
