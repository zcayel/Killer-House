/**
 * The letter/skull/bottle/altar ritual quest this file used to run was
 * abandoned in favor of the candle round in gameLoop.ts — `initQuest()` was
 * never called from index.ts, so that whole system (letter, offerings,
 * altar, win/reset) was 100% dead code, plus it silently gated
 * `spawnBoneDrop` behind a flag (`letterRead`) that could never become true,
 * making bone drops a permanent no-op. Removed rather than kept parked.
 *
 * `knifeCollected` is the one piece still genuinely live: combat.ts,
 * gameLoop.ts (grants every knife at round start) and ui.tsx (hotbar
 * display, behind WEAPONS_ENABLED) all read it.
 */
import { KNIFE_ITEMS } from './config'

export const knifeCollected: boolean[] = KNIFE_ITEMS.map(() => false)
