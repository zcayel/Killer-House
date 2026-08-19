/**
 * SEALED PLOT — you cannot leave the grounds until the ritual is done.
 *
 * The gate stays shut for the whole run: cross the fence line with candles
 * still unlit and you're pushed back inside with a line telling you why. Once
 * candlesLit reaches the round's requirement the boundary opens and stops
 * being checked at all.
 *
 * WHY A PUSH-BACK AND NOT A KILL. The fence tips already kill anyone who goes
 * OVER the fence (traps/fenceTips.ts) — that's a hazard the player chose. This
 * is the opposite case: walking out through the gate at ground level isn't a
 * mistake worth a death, it's just not allowed yet, and killing for it would
 * cost a heart and teach nothing. So the boundary is a wall, not a trap.
 *
 * It acts at EVERY height now (PLOT_SEAL_MAX_Y is above the roof). It used to
 * stop at 1.6m so it couldn't fight the fence-tip trap over someone standing
 * on the railings — but that ceiling was exactly what a running jump cleared.
 * The two no longer overlap by construction: the tips own the fence LINE, this
 * owns everything past the boundary RECTANGLE, and a player pushed back inside
 * is by definition no longer on the line.
 */

import { Vector3 } from '@dcl/sdk/math'
import { movePlayerTo } from '~system/RestrictedActions'
import { FENCE_LINES, PLOT_SEAL_MARGIN, PLOT_SEAL_PUSH_IN, PLOT_SEAL_MAX_Y, PLOT_SEAL_TOAST_COOLDOWN } from './config'
import { candlesLit, getCandlesRequired } from './gameLoop'
import { playerPosition } from './playerTracker'
import { gameStarted } from './gameState'
import { pushToast } from './notifications'
import { forceFieldHit } from './effects/forceField'
import { addSafeSystem } from './safeSystem'

let toastCooldown = 0

/** Is the ritual finished — i.e. is the player allowed off the grounds? */
export function plotIsOpen(): boolean {
  return candlesLit >= getCandlesRequired()
}

function plotBoundarySystem(dt: number) {
  if (toastCooldown > 0) toastCooldown -= dt

  // ONLY the pre-start gate. This used to bail on isInvulnerable(), which
  // sounds prudent and was the actual bug behind "my avatar dies but still
  // gets out": jumping the fence kills you via fenceTips, dying makes you
  // invulnerable, and the seal then stood down for the whole death — so the
  // corpse sailed on over the railings and out of the scene.
  //
  // Dropping that guard is safe because of WHEN this fires: only once the
  // player is already OUTSIDE the boundary, and no scripted teleport in this
  // scene ever puts them there. Respawn goes to SPAWN_POSITION and the camera
  // preview stays indoors — both inside the rectangle, so both return at the
  // bounds check below without this ever touching movePlayerTo.
  if (!gameStarted) return
  if (plotIsOpen()) return

  const p = playerPosition
  if (p.y > PLOT_SEAL_MAX_Y) return // up on the fence — fenceTips.ts owns that case

  const minX = FENCE_LINES.minX + PLOT_SEAL_MARGIN
  const maxX = FENCE_LINES.maxX - PLOT_SEAL_MARGIN
  const minZ = FENCE_LINES.minZ + PLOT_SEAL_MARGIN
  const maxZ = FENCE_LINES.maxZ - PLOT_SEAL_MARGIN
  if (p.x >= minX && p.x <= maxX && p.z >= minZ && p.z <= maxZ) return

  // Put them back just inside whichever edge they crossed, keeping the other
  // axis where it was so the push reads as bumping a wall rather than being
  // yanked to a corner.
  const x = Math.min(Math.max(p.x, minX + PLOT_SEAL_PUSH_IN), maxX - PLOT_SEAL_PUSH_IN)
  const z = Math.min(Math.max(p.z, minZ + PLOT_SEAL_PUSH_IN), maxZ - PLOT_SEAL_PUSH_IN)

  // SHOW THE WALL THEY JUST HIT. Without this the player is shoved backwards by
  // nothing they can see, which reads as the scene malfunctioning rather than
  // as a barrier — the toast explains it in words at the top of the screen,
  // which is not where anyone is looking while walking into something.
  //
  // The contact point is on the boundary itself, NOT where the player ended up:
  // pinning it to the crossed edge and leaving the other axis alone puts the
  // flare exactly where they touched. Lifted to chest height so it flares in
  // front of the face rather than around the ankles.
  //
  // Which axis they crossed decides how the panel is turned, so it lies in the
  // wall. Outside on both (a corner) is genuinely ambiguous; X wins, and either
  // choice looks correct because the two walls meet there anyway.
  const outX = p.x < minX || p.x > maxX
  const hitX = p.x < minX ? minX : maxX
  const hitZ = p.z < minZ ? minZ : maxZ
  forceFieldHit(
    Vector3.create(outX ? hitX : p.x, p.y + 1.2, outX ? p.z : hitZ),
    outX ? 'x' : 'z'
  )

  movePlayerTo({
    newRelativePosition: Vector3.create(x, p.y, z),
    // Keep them looking into the grounds, not back out at the gate.
    cameraTarget: Vector3.create((minX + maxX) / 2, p.y + 1.6, (minZ + maxZ) / 2)
  }).catch((err) => {
    console.error('plot boundary movePlayerTo failed:', err)
  })

  if (toastCooldown <= 0) {
    const left = Math.max(0, getCandlesRequired() - candlesLit)
    pushToast(
      left === 1
        ? 'An evil force prevents you from going out — 1 candle left'
        : `An evil force prevents you from going out — ${left} candles left`
    )
    toastCooldown = PLOT_SEAL_TOAST_COOLDOWN
  }
}

export function initPlotBoundary() {
  addSafeSystem(plotBoundarySystem, 'plotBoundarySystem')
}
