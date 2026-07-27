/**
 * OUTER FENCE TIPS — the spiked tops of the perimeter iron fence are lethal.
 *
 * The fence runs in a rectangle around the plot (FENCE_LINES). If the
 * player's feet are up at tip height (FENCE_TIP_Y_MIN..MAX) while hovering
 * over one of the four fence lines — i.e. they jumped or climbed onto it —
 * they're impaled. Walking beside the fence on the ground is always safe,
 * and so is being up in the house (the house is nowhere near the fence
 * lines).
 */

import { engine } from '@dcl/sdk/ecs'
import { FENCE_LINES, FENCE_TIP_MARGIN, FENCE_TIP_Y_MIN, FENCE_TIP_Y_MAX } from '../config'
import { killPlayer, isInvulnerable } from '../gameState'
import { playerPosition } from '../playerTracker'
import { addSafeSystem } from '../safeSystem'

function overFenceLine(x: number, z: number): boolean {
  // Only positions within (or just outside) the plot rectangle count
  const nearPlot =
    x > FENCE_LINES.minX - FENCE_TIP_MARGIN &&
    x < FENCE_LINES.maxX + FENCE_TIP_MARGIN &&
    z > FENCE_LINES.minZ - FENCE_TIP_MARGIN &&
    z < FENCE_LINES.maxZ + FENCE_TIP_MARGIN
  if (!nearPlot) return false

  return (
    Math.abs(x - FENCE_LINES.minX) < FENCE_TIP_MARGIN ||
    Math.abs(x - FENCE_LINES.maxX) < FENCE_TIP_MARGIN ||
    Math.abs(z - FENCE_LINES.minZ) < FENCE_TIP_MARGIN ||
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
