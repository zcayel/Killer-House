/**
 * THE BARRIER, MADE VISIBLE — the flare where a player runs into the sealed
 * edge of the plot.
 *
 * plotBoundary.ts already stopped people leaving before their candles were lit:
 * it teleports them back inside and pushes a toast saying why. That works, but
 * it is invisible. From the player's side something shoves them backwards for
 * no reason they can see, and a shove with no cause is the single most common
 * way a scene reads as broken. The toast explains it in words, at the top of
 * the screen, which is not where anyone is looking while walking into a wall.
 *
 * So the wall gets shown, exactly where and when it is touched: a hex lattice
 * flares at the point of contact, expands and fades in half a second, with a
 * light flash to match. The player learns the boundary's SHAPE by hitting it,
 * which no amount of toast copy can teach.
 *
 * THE PANEL LIES IN THE WALL, and is not billboarded. That distinction is the
 * whole effect. A billboarded sprite always faces the camera and would read as
 * a flash in front of the player's face; a quad lying flat in the boundary
 * plane reads as a SURFACE they just struck, and if they walk along the fence
 * and hit it again they see it is the same flat wall all the way round.
 *
 * ONE ENTITY, BUILT ONCE, RE-POSED PER HIT. Same rule as the lightning bolts —
 * a hazard that spawns and destroys entities on a player-controlled trigger is
 * a way to accumulate orphaned lights on somebody's client.
 */

import {
  engine,
  Transform,
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
  LightSource,
  VisibilityComponent,
  Entity
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import {
  FORCE_FIELD_ENABLED,
  FORCE_FIELD_TEXTURE,
  FORCE_FIELD_COLOR,
  FORCE_FIELD_ALBEDO,
  FORCE_FIELD_SECONDS,
  FORCE_FIELD_SIZE,
  FORCE_FIELD_START_SCALE,
  FORCE_FIELD_EMISSIVE,
  FORCE_FIELD_LIGHT_INTENSITY,
  FORCE_FIELD_LIGHT_RANGE,
  FORCE_FIELD_COOLDOWN,
  FORCE_FIELD_SOUND_VOLUME
} from '../config'
import { playSoundAt, SOUND_FORCE_FIELD } from '../sounds'
import { addSafeSystem } from '../safeSystem'

let panel: Entity
let flash: Entity
let timer = 0
let cooldown = 0
let built = false

/**
 * Flare the barrier at a contact point.
 *
 * `axis` is which pair of walls was crossed — 'x' for the east/west runs, 'z'
 * for north/south — and it decides how the quad is turned so it lies IN the
 * wall rather than across it. MeshRenderer.setPlane builds its quad in the XY
 * plane, which already lies in the north/south walls; the east/west ones need a
 * quarter turn about Y.
 */
export function forceFieldHit(point: Vector3, axis: 'x' | 'z') {
  if (!FORCE_FIELD_ENABLED || !built) return
  // Retriggering every frame while someone leans on the boundary would stack
  // flare on flare and never let one play through.
  if (cooldown > 0) return
  cooldown = FORCE_FIELD_COOLDOWN
  timer = FORCE_FIELD_SECONDS

  Transform.createOrReplace(panel, {
    position: Vector3.create(point.x, point.y, point.z),
    rotation: axis === 'x' ? Quaternion.fromEulerDegrees(0, 90, 0) : Quaternion.Identity(),
    scale: Vector3.create(FORCE_FIELD_SIZE, FORCE_FIELD_SIZE, 1)
  })
  Transform.createOrReplace(flash, { position: Vector3.create(point.x, point.y, point.z) })
  VisibilityComponent.createOrReplace(panel, { visible: true })
  LightSource.getMutable(flash).active = true

  // Positional, at the point of contact, so the hit comes from the piece of
  // boundary you actually walked into rather than from everywhere at once.
  // Fires on the same cooldown as the flare (see forceFieldHit's guard), so
  // running along the barrier can't machine-gun it.
  playSoundAt(SOUND_FORCE_FIELD, point, FORCE_FIELD_SOUND_VOLUME)
}

function forceFieldSystem(dt: number) {
  if (cooldown > 0) cooldown -= dt
  if (timer <= 0) return

  timer -= dt
  if (timer <= 0) {
    VisibilityComponent.createOrReplace(panel, { visible: false })
    LightSource.getMutable(flash).active = false
    return
  }

  // 0 at the instant of contact -> 1 as it dies.
  const t = 1 - timer / FORCE_FIELD_SECONDS
  // Expands fast and then eases off, like a ripple losing energy. Linear growth
  // reads as a shape being scaled rather than as something spreading.
  const spread = 1 - (1 - t) * (1 - t)
  const size = FORCE_FIELD_SIZE * (FORCE_FIELD_START_SCALE + (1 - FORCE_FIELD_START_SCALE) * spread)
  // Fades faster than it grows, so the last frames are a wide faint ring rather
  // than a big bright square blinking out.
  const fade = (1 - t) * (1 - t)

  const tr = Transform.getMutable(panel)
  tr.scale = Vector3.create(size, size, 1)

  Material.setPbrMaterial(panel, {
    texture: Material.Texture.Common({ src: FORCE_FIELD_TEXTURE }),
    alphaTexture: Material.Texture.Common({ src: FORCE_FIELD_TEXTURE }),
    emissiveTexture: Material.Texture.Common({ src: FORCE_FIELD_TEXTURE }),
    // THE DARK COMES FROM HERE. Under MTM_ALPHA_BLEND the albedo is what gets
    // blended over the background, so a near-black one makes the lattice
    // subtract from the scene instead of adding to it — a barrier-shaped
    // shadow. Emission cannot do this at any colour; see FORCE_FIELD_ALBEDO.
    //
    // Its alpha is also the flare's dissolve, which is why the fade lives on
    // the albedo rather than only on emissiveIntensity: fading the glow alone
    // would leave a black lattice sitting there at full strength.
    albedoColor: Color4.create(FORCE_FIELD_ALBEDO.r, FORCE_FIELD_ALBEDO.g, FORCE_FIELD_ALBEDO.b, fade),
    emissiveColor: FORCE_FIELD_COLOR,
    emissiveIntensity: FORCE_FIELD_EMISSIVE * fade,
    alphaTest: 0,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    specularIntensity: 0,
    metallic: 0,
    roughness: 1,
    castShadows: false
  })

  const l = LightSource.getMutable(flash)
  l.intensity = FORCE_FIELD_LIGHT_INTENSITY * fade
}

export function initForceField() {
  if (!FORCE_FIELD_ENABLED) return

  panel = engine.addEntity()
  // Parked underground until the first hit poses it — never at the origin,
  // which is inside the plot and would show a stray quad on frame one.
  Transform.create(panel, { position: Vector3.create(0, -50, 0) })
  MeshRenderer.setPlane(panel)
  Material.setPbrMaterial(panel, {
    texture: Material.Texture.Common({ src: FORCE_FIELD_TEXTURE }),
    alphaTexture: Material.Texture.Common({ src: FORCE_FIELD_TEXTURE }),
    emissiveTexture: Material.Texture.Common({ src: FORCE_FIELD_TEXTURE }),
    albedoColor: Color4.create(FORCE_FIELD_ALBEDO.r, FORCE_FIELD_ALBEDO.g, FORCE_FIELD_ALBEDO.b, 1),
    emissiveColor: FORCE_FIELD_COLOR,
    emissiveIntensity: FORCE_FIELD_EMISSIVE,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND,
    specularIntensity: 0,
    metallic: 0,
    roughness: 1,
    castShadows: false
  })
  VisibilityComponent.create(panel, { visible: false })

  flash = engine.addEntity()
  Transform.create(flash, { position: Vector3.create(0, -50, 0) })
  LightSource.create(flash, {
    type: LightSource.Type.Point({}),
    active: false,
    color: FORCE_FIELD_COLOR,
    intensity: FORCE_FIELD_LIGHT_INTENSITY,
    range: FORCE_FIELD_LIGHT_RANGE,
    // Never. This fires at the fence line where the yard props are, and a
    // shadow-casting light switching on for half a second re-renders every
    // shadow around it for no gain the player will consciously notice.
    shadow: false
  })

  built = true
  addSafeSystem(forceFieldSystem, 'forceFieldSystem')
}
