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
import { initPlotBoundary } from './plotBoundary'
import { initSkeletons } from './enemies/skeletons'
import { initDeathEffects } from './effects/deathEffects'
import { initForceField } from './effects/forceField'
import { initSounds } from './sounds'
import { initCombat } from './combat'
import { initGameLoop } from './gameLoop'
import { initCandles } from './candles'
import { initLightning } from './lightning'
import { initDoors } from './doors'
import { initDust } from './dust'
import { initLeaderboard } from './leaderboard'
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

export function main() {
  if (hasRun) {
    console.error('[index] main() was called again on an already-running engine — ignoring the second call to avoid duplicating every entity in the scene.')
    return
  }
  hasRun = true

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
  safeInit(initPlotBoundary, 'initPlotBoundary')
  safeInit(initSkeletons, 'initSkeletons')

  safeInit(initCombat, 'initCombat')
  // Quest progression is parked — the ritual round IS the game now.
  safeInit(initGameLoop, 'initGameLoop')
  safeInit(initCandles, 'initCandles')
  safeInit(initLightning, 'initLightning')
  safeInit(initDoors, 'initDoors')
  safeInit(initDust, 'initDust')
  safeInit(initLeaderboard, 'initLeaderboard')
}
