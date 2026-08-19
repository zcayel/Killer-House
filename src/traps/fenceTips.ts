/**
 * OUTER FENCE TIPS — the spiked tops of the perimeter iron fence are lethal.
 *
 * The fence runs in a rectangle around the plot (FENCE_LINES). If the player's
 * feet are in the tip band (FENCE_TIP_Y_MIN..MAX) while hovering over one of
 * the four fence lines — i.e. they jumped or climbed onto it — they're impaled.
 * Walking beside the fence on the ground is always safe.
 *
 * THE BAND IS THE FENCE'S OWN HEIGHT, measured off the models: 1.9 to 3.2, and
 * the tallest thing on any fence line tops out at 3.028. It used to run to 40,
 * on the reasoning that a double jump could otherwise clear it and escape.
 * Escape isn't this trap's problem any more — plotBoundary.ts seals the plot at
 * every height — and a kill volume thirteen times taller than the object it
 * represents kills people who are nowhere near a spike.
 *
 * THE HOUSE IS EXEMPT, and this is not belt-and-braces. HOUSE_RECT reaches
 * x 31.2 while the east fence line is at x 31.1, so the east kill line runs
 * THROUGH the house: a 0.45m x 13.6m strip of interior floor, on three levels
 * (2.64, 7.65, 8.58), was lethal. Standing indoors by the east wall killed you
 * with "Impaled on the iron fence" and nothing on screen explained it. Capping
 * the band at 3.2 fixes two of those floors; only excluding the footprint fixes
 * the one at 2.64.
 *
 * THE GATEWAY IS EXEMPT TOO. It's a doorway, not railings — no spikes, and the
 * spawn point stands in it. Leaving through it is stopped by plotBoundary.ts
 * pushing you back, not by killing you.
 */

import { engine } from '@dcl/sdk/ecs'
import {
  FENCE_LINES,
  FENCE_TIP_MARGIN,
  FENCE_TIP_Y_MIN,
  FENCE_TIP_Y_MAX,
  FENCE_GATE_MIN_X,
  FENCE_GATE_MAX_X,
  HOUSE_RECT
} from '../config'
import { killPlayer, isInvulnerable } from '../gameState'
import { playerPosition } from '../playerTracker'
import { addSafeSystem } from '../safeSystem'

function overFenceLine(x: number, z: number): boolean {
  // INDOORS IS NEVER A FENCE. The house overhangs the east fence line by 10cm,
  // so without this the east kill line cuts a strip out of the interior floor.
  // See the header — this is the half of that fix the height cap can't do.
  if (x > HOUSE_RECT.minX && x < HOUSE_RECT.maxX && z > HOUSE_RECT.minZ && z < HOUSE_RECT.maxZ) return false

  // Only positions within (or just outside) the plot rectangle count
  const nearPlot =
    x > FENCE_LINES.minX - FENCE_TIP_MARGIN &&
    x < FENCE_LINES.maxX + FENCE_TIP_MARGIN &&
    z > FENCE_LINES.minZ - FENCE_TIP_MARGIN &&
    z < FENCE_LINES.maxZ + FENCE_TIP_MARGIN
  if (!nearPlot) return false

  // THE GATEWAY IS NOT FENCE. There are no spikes in the doorway, and the
  // player spawns standing in it — (27, 0.1, 1) is only 0.25m off the south
  // line, inside FENCE_TIP_MARGIN — so without this cut-out, jumping on the
  // spawn point killed you on a fence that isn't there.
  const inGateway = x > FENCE_GATE_MIN_X && x < FENCE_GATE_MAX_X
  const onSouth = Math.abs(z - FENCE_LINES.minZ) < FENCE_TIP_MARGIN && !inGateway

  return (
    Math.abs(x - FENCE_LINES.minX) < FENCE_TIP_MARGIN ||
    Math.abs(x - FENCE_LINES.maxX) < FENCE_TIP_MARGIN ||
    onSouth ||
    Math.abs(z - FENCE_LINES.maxZ) < FENCE_TIP_MARGIN
  )
}

/**
 * Debug-HUD probe: is the player horizontally over a fence line right now
 * (ignoring height)? Paired with the HUD's Y readout this answers, from one
 * mobile screenshot, exactly why a fence standee did or didn't die: over the
 * line but Y outside [FENCE_TIP_Y_MIN..MAX] = the height band misses on that
 * client; not over the line = they're standing on something else (a pillar
 * cap is not a fence tip).
 */
export function overFence(): boolean {
  return overFenceLine(playerPosition.x, playerPosition.z)
}

function fenceTipSystem() {
  if (isInvulnerable()) return
  const p = playerPosition
  if (p.y < FENCE_TIP_Y_MIN || p.y > FENCE_TIP_Y_MAX) return
  if (overFenceLine(p.x, p.z)) {
    killPlayer('Impaled on the iron fence')
  }
}

export function initFenceTips() {
  addSafeSystem(fenceTipSystem, 'fenceTipSystem')
}
