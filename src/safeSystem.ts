/**
 * CRASH ISOLATION for engine systems.
 *
 * DCL propagates an unhandled throw from ANY system all the way up to the
 * engine's internal update loop, which then aborts EVERY system for that
 * frame — so a single bad system bricks the whole scene (doors stop opening,
 * candles won't light, the timer freezes, nothing responds). We hit this
 * twice: the ghost-state crash, and an in-world sync-only throw that doesn't
 * happen in local preview (preview runs no multiplayer comms).
 *
 * addSafeSystem wraps a system so its failures are contained to itself: the
 * rest of the scene keeps running, and the first error from each system is
 * logged (with its name) so we can see exactly what threw without the whole
 * scene going dark.
 */

import { engine } from '@dcl/sdk/ecs'

const reported = new Set<string>()

/**
 * Every label that has ever thrown (system OR init), plus the first error
 * message each gave. TEMP diagnostic — there is no scene-console access from
 * a mobile device in this project, so this is the only channel we have to
 * find out whether something silently failed there. Read via failedLabels()
 * from ui.tsx's debug HUD.
 */
const failures = new Map<string, string>()

export function failedLabels(): string[] {
  return Array.from(failures.keys())
}

/**
 * For a broken condition that doesn't throw — e.g. an expected named entity
 * came back null — but is just as invisible on a device with no console.
 * Piggybacks on the same failedLabels()/DEBUG_HUD readout as an actual throw.
 */
export function reportFailure(label: string, message: string) {
  if (!failures.has(label)) failures.set(label, message)
}

export function addSafeSystem(fn: (dt: number) => void, label: string, priority?: number) {
  const wrapped = (dt: number) => {
    try {
      fn(dt)
    } catch (err) {
      if (!reported.has(label)) {
        reported.add(label)
        failures.set(label, err instanceof Error ? err.message : String(err))
        console.error(`[safeSystem] system '${label}' threw (this system is now failing every frame; further errors from it are suppressed):`, err)
      }
    }
  }
  if (priority !== undefined) engine.addSystem(wrapped, priority)
  else engine.addSystem(wrapped)
}

/**
 * Same idea, for the ONE-TIME init() calls in index.ts's main(), which had
 * ZERO isolation from each other: `main()` calls every initFoo() back-to-back
 * with nothing catching a throw, so if ANY one of them threw, every init call
 * listed AFTER it in that sequential list would simply never run — no game
 * loop, no candles, no doors, no combat, nothing, while the UI (set up first)
 * looks completely fine. A real way this can happen: `syncEntity(entity,
 * components, enumId)` THROWS if that enum id is already registered on this
 * client (checked via `engine.getEntitiesWith(NetworkEntity)`) — which is
 * exactly what happens if `main()` ever runs a second time on an
 * already-live engine (a hot-reloaded Preview session that wasn't fully
 * restarted) without the old entities being torn down first.
 */
export function safeInit(fn: () => void, label: string) {
  try {
    fn()
  } catch (err) {
    failures.set(label, err instanceof Error ? err.message : String(err))
    console.error(`[safeSystem] init '${label}' threw — every init call after it still ran, but '${label}' itself did NOT complete:`, err)
  }
}
