/**
 * PHYSICAL LEADERBOARD — a 3D sign showing the fastest escapes, built from
 * the same escapeRanking() data the win-screen overlay already renders
 * (gameLoop.ts).
 *
 * MOVED, on request, to the "Ambient Sound - footsteps" emitter's spot
 * (composite position 16.32, 8.82, 11.66) — upstairs, over the landing the
 * chandelier lift arrives on. It previously sat at the deleted Silver Knife
 * prop's old position (19.5, 5, 13.75). The emitter itself is a separate
 * entity and is untouched; only its coordinates were borrowed.
 *
 * Doubled in both width and overall size at the same time, so the text scales
 * with the board rather than staying small on a bigger panel.
 *
 * Orientation note: I don't know which way that wall/shelf actually faces,
 * so this is built with identity rotation — if the text reads backwards or
 * faces into a wall in-world, rotate the "leaderboardBoard"/"leaderboardText"
 * entities 180° (or whatever's needed) in Creator Hub, or tell me the facing
 * direction and I'll set it in code instead.
 *
 * The text only gets rewritten when the rendered string actually changes
 * (ranking only moves on a win), not every frame.
 */

import { engine, Transform, TextShape, MeshRenderer, Material, MaterialTransparencyMode, Font, TextAlignMode, Entity } from '@dcl/sdk/ecs'
import { Vector3, Color4 } from '@dcl/sdk/math'
import { escapeRanking, formatTime } from './gameLoop'
import { addSafeSystem } from './safeSystem'

const BOARD_POSITION = Vector3.create(16.32, 8.82, 11.66)
// x2 bigger overall, and then x2 wider again on top of that — so the panel is
// four times its old width and twice its old height. fontSize below is scaled
// by the same "x2 bigger" factor so the rows grow with the board.
const BOARD_SIZE_SCALE = 2
const BOARD_WIDTH = 3.2 * BOARD_SIZE_SCALE * 2
const BOARD_HEIGHT = 2.4 * BOARD_SIZE_SCALE

function boardText(): string {
  const ranking = escapeRanking().slice(0, 5)
  if (ranking.length === 0) return 'FASTEST ESCAPES\n\nNo escapes yet.\nBe the first.'
  const rows = ranking.map((r, i) => `${i + 1}. ${r.me ? `${r.name} (you)` : r.name}   ${formatTime(r.bestTime)}`)
  return ['FASTEST ESCAPES', '', ...rows].join('\n')
}

let textEntity: Entity
let lastText = ''

function refreshSystem(_dt: number) {
  const next = boardText()
  if (next === lastText) return
  lastText = next
  TextShape.getMutable(textEntity).text = next
}

export function initLeaderboard() {
  // Dark backing panel so the text reads regardless of what's behind it.
  const backing = engine.addEntity()
  Transform.create(backing, { position: Vector3.clone(BOARD_POSITION), scale: Vector3.create(BOARD_WIDTH, BOARD_HEIGHT, 1) })
  MeshRenderer.setPlane(backing)
  Material.setPbrMaterial(backing, {
    albedoColor: Color4.create(0.04, 0.03, 0.02, 0.92),
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    specularIntensity: 0,
    metallic: 0,
    roughness: 1
  })

  textEntity = engine.addEntity()
  Transform.create(textEntity, {
    position: Vector3.create(BOARD_POSITION.x, BOARD_POSITION.y, BOARD_POSITION.z + 0.02)
  })
  lastText = boardText()
  TextShape.create(textEntity, {
    text: lastText,
    font: Font.F_SANS_SERIF,
    fontSize: 4.5 * BOARD_SIZE_SCALE,
    textAlign: TextAlignMode.TAM_MIDDLE_CENTER,
    width: BOARD_WIDTH,
    height: BOARD_HEIGHT,
    textWrapping: true,
    lineSpacing: 5 * BOARD_SIZE_SCALE,
    textColor: Color4.create(0.93, 0.9, 0.85, 1)
  })

  addSafeSystem(refreshSystem, 'leaderboardRefresh')
}
