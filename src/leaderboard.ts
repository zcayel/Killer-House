/**
 * PHYSICAL LEADERBOARD — a 3D sign showing the fastest escapes, built from
 * the same escapeRanking() data the win-screen overlay already renders
 * (gameLoop.ts). Positioned where the Silver Knife prop used to sit
 * (composite entity "Silver Knife", id 517 — world position 19.5, 5, 13.75;
 * that prop has since been deleted, freeing the spot). Sized up from the
 * first version, on request.
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

const BOARD_POSITION = Vector3.create(19.5, 5, 13.75)
const BOARD_WIDTH = 3.2
const BOARD_HEIGHT = 2.4

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
    fontSize: 4.5,
    textAlign: TextAlignMode.TAM_MIDDLE_CENTER,
    width: BOARD_WIDTH,
    height: BOARD_HEIGHT,
    textWrapping: true,
    lineSpacing: 5,
    textColor: Color4.create(0.93, 0.9, 0.85, 1)
  })

  addSafeSystem(refreshSystem, 'leaderboardRefresh')
}
