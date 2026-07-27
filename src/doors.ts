/**
 * DOORS — both wooden doors auto-close, and moonlight pours in while open.
 *
 * The doors are builder smart items (Open/Close actions + on-click toggle).
 * Opening needs proximity AND an explicit IA_POINTER press (on request — no
 * more opening just from walking close); doorSystem is the ONLY owner of
 * isOpen/light/closeTimer state — it does NOT wait for the door's own
 * animation-finished callback to
 * echo back before considering itself "open" or "closed". This used to be
 * split: proximity set isOpen=true optimistically, but only the door's OWN
 * 'Play Open Animation'/'Play Close Animation' event confirmed it and turned
 * the light on/off. Decentraland's mobile client has a documented (though
 * unconfirmed-for-this-exact-scene) history of smart-item animation events
 * looping or never firing their completion callback — if that ever happened
 * here, the light would stay on forever AND the door could never be told to
 * open again (the `!r.isOpen` guard below would stay permanently false). The
 * door's own Open/Close smart-item actions are still emitted (they still
 * drive the visible swing + sound) — we just no longer wait on anything
 * coming back from them.
 */

import { engine, Transform, LightSource, InputAction, inputSystem, Entity } from '@dcl/sdk/ecs'
import { Vector3, Color3 } from '@dcl/sdk/math'
import { getActionEvents } from '@dcl/asset-packs/dist/events'
import { playerPosition } from './playerTracker'
import { otherPlayerPositions } from './multiplayer'
import { addSafeSystem, reportFailure } from './safeSystem'

const DOOR_AUTO_CLOSE_SECONDS = 2
// Walk this close to a door AND press IA_POINTER (left click on PC, the
// mobile client's own on-screen interact button) to open it — on request:
// it shouldn't swing open automatically just from walking near it anymore.
// Still proximity-gated rather than a raw 3D-mesh click: tapping the actual
// door model is what didn't reliably register on mobile in the first place
// (see the header comment) — IA_POINTER-while-near is the same reliable
// mechanic the candles already use for exactly that reason, just without
// the hold (a door only needs a press, not a multi-second channel).
const DOOR_OPEN_RADIUS = 3.5

// light sits just INSIDE each doorway (front door opens on the south wall,
// back door on the north wall)
const DOORS = [
  { name: 'Old Wooden Door', lightPos: Vector3.create(28.31, 4.0, 10.3) },
  { name: 'Old Wooden Door_2', lightPos: Vector3.create(26.93, 4.0, 20.0) }
]

const MOONLIGHT = Color3.create(0.6, 0.7, 1.0)

interface DoorRig {
  door: Entity
  doorPos: Vector3
  light: Entity
  closeTimer: number
  isOpen: boolean
}
const rigs: DoorRig[] = []

/** Distance from a door to the nearest player (mine or anyone else's), ignoring height. */
function nearestPlayerFlatDist(pos: Vector3): number {
  let best = Math.hypot(playerPosition.x - pos.x, playerPosition.z - pos.z)
  for (const p of otherPlayerPositions()) {
    best = Math.min(best, Math.hypot(p.x - pos.x, p.z - pos.z))
  }
  return best
}

function doorSystem(dt: number) {
  const pressed = inputSystem.isPressed(InputAction.IA_POINTER)
  for (const r of rigs) {
    const near = nearestPlayerFlatDist(r.doorPos) <= DOOR_OPEN_RADIUS
    // Opening now needs an explicit press near the door, on request — no
    // more swinging open just from walking close. Staying in the doorway
    // still keeps resetting the close timer once it's open; it only starts
    // closing once everyone's stepped away.
    if (near && !r.isOpen && pressed) {
      r.isOpen = true
      LightSource.getMutable(r.light).active = true
      getActionEvents(r.door).emit('Open', {} as any)
    }
    if (near && r.isOpen) {
      r.closeTimer = DOOR_AUTO_CLOSE_SECONDS
    }
    if (r.closeTimer > 0) {
      r.closeTimer -= dt
      if (r.closeTimer <= 0) {
        r.isOpen = false
        LightSource.getMutable(r.light).active = false
        getActionEvents(r.door).emit('Close', {} as any)
      }
    }
  }
}

export function initDoors() {
  for (const cfg of DOORS) {
    const door = engine.getEntityOrNullByName(cfg.name)
    if (door === null) {
      // Silent otherwise: console.error goes nowhere on a device with no
      // scene-console access, and a missing door here means it can NEVER
      // open, for anyone, on that client — this needs to be visible.
      reportFailure('doorsInit', `door not found: ${cfg.name}`)
      continue
    }

    const light = engine.addEntity()
    Transform.create(light, { position: Vector3.clone(cfg.lightPos) })
    LightSource.create(light, {
      type: LightSource.Type.Point({}),
      active: false,
      color: MOONLIGHT,
      intensity: 800,
      range: 8,
      shadow: false
    })

    const rig: DoorRig = { door, doorPos: Vector3.clone(cfg.lightPos), light, closeTimer: 0, isOpen: false }
    rigs.push(rig)
  }

  addSafeSystem(doorSystem, 'doorSystem')
}
