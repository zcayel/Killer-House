/**
 * ============================================================================
 * GAME CONFIG — adjust these values in Creator Hub / here to match your scene
 * ============================================================================
 * All positions below are PLACEHOLDERS based on the scene's spawnPoint and
 * parcel bounds (scene.json). Open the scene in Creator Hub, walk to where
 * you want each hazard, check the entity's Transform position in the right
 * panel, and paste those numbers in here.
 *
 * Parcels: 0,0 / 1,0 / 0,1 / 1,1 -> a 32m x 32m plot, base at 0,0.
 * Default spawn (from scene.json): around x=27, z=0.5, facing the house.
 * ============================================================================
 */

import { Vector3, Quaternion, Color3 } from '@dcl/sdk/math'

// ---------------------------------------------------------------------------
// SPAWN / RESPAWN
// ---------------------------------------------------------------------------
export const SPAWN_POSITION = Vector3.create(27, 0.1, 1)
export const SPAWN_ROTATION = Quaternion.fromEulerDegrees(0, 180, 0)
export const RESPAWN_DELAY_SECONDS = 10
export const RESPAWN_GRACE_SECONDS = 2 // after respawning, nothing can kill you for this long

// ---------------------------------------------------------------------------
// DEATH EFFECTS — camera shake + blood
// ---------------------------------------------------------------------------
export const DEATH_SHAKE_SECONDS = 0.6 // how long the camera shakes after a hit
export const DEATH_SHAKE_AMPLITUDE = 0.35 // meters of camera jitter at the start of the shake
export const BLOOD_MAX_STAINS = 12 // oldest floor stain is removed beyond this
export const BLOOD_POOL_TEXTURE = 'assets/scene/Textures/blood_pool.png' // floor decal at the death spot
export const BLOOD_OVERLAY_TEXTURE = 'assets/scene/Textures/blood_overlay.png' // screen splatter during the death screen

// ---------------------------------------------------------------------------
// MODEL PATHS (from your uploaded scene)
// ---------------------------------------------------------------------------
// Copy of the butcher knife baked (Blender) with the ORIGIN moved to the
// handle grip — used only for the in-hand display so the palm always lands
// on the handle. The original keeps its origin for the table pickup.
export const MODEL_BUTCHERS_KNIFE_HELD = 'assets/scene/Models/butchersknife/butchersknife_held.glb'
export const MODEL_KITCHEN_KNIFE = 'assets/scene/Models/kitchenknife/kitchenknife.glb'

// NOTE (bug flag, see chat): large_iron_fence / small_iron_fence / iron_fence_door
// are missing their .glb files in this export (composite.json + texture only,
// no mesh). The only fence pack with a real .glb bundled is iron_fence_4, so
// that's what the spike trap uses below. See write-up for how to fix the export.
export const MODEL_FENCE_SPIKE = 'assets/asset-packs/iron_fence_4/HWN20_IronfFence_04.glb'
// Death tombstones — the grave that appears where you fell cycles through
// these three (all from the official DCL Halloween pack), so back-to-back
// deaths don't all look identical.
export const TOMBSTONE_MODELS = [
  'assets/asset-packs/grave_01/HWN20_Grave_01.glb',
  'assets/asset-packs/grave_02/HWN20_Grave_02.glb',
  'assets/asset-packs/grave_03/HWN20_Grave_03.glb'
]

// ---------------------------------------------------------------------------
// WEAPONS — parked behind WEAPONS_ENABLED below. Every knife is granted for
// free at round start (gameLoop.ts) rather than picked up; this list only
// still feeds the hotbar icons/labels when weapons are re-enabled.
// ---------------------------------------------------------------------------
export const KNIFE_ITEMS = [
  { entityName: 'butchersknife', label: 'Butcher', icon: 'assets/ui/knife_butchers.png' },
  { entityName: 'kitchenknife', label: 'Kitchen', icon: 'assets/ui/knife_kitchen.png' },
  { entityName: 'filletknife', label: 'Fillet', icon: 'assets/ui/knife_fillet.png' }
]
// TEMPORARILY DISABLED (2026-07-21, user request: "take away the ability to
// use weapon but we will put it back later"). Flip this back to true to
// restore ALL weapon use in one line — knife slash (key 1 / hotbar tap),
// knife throw (key 2 / hotbar tap), stabbing skeletons, and the knife hotbar
// UI. Nothing was deleted; every code path is intact behind this flag.
export const WEAPONS_ENABLED = false

// Diagnosis is done (mobile freeze root-caused and fixed via mobile-lean
// skeleton mode) — off for now. Flip true again if a new "silently broke on
// mobile with zero visible symptom" mystery needs the FAILED row.
export const DEBUG_HUD = false

// The full-screen night-gloom overlay. On mobile the explorer appears NOT to
// honour pointerFilter:'none' for TOUCH (it does for mouse), so this dark
// layer silently swallows every tap meant for a 3D object underneath — which
// is why doors/candles couldn't be tapped on the phone while this was on.
// RE-ENABLED: doors and candles no longer depend on a 3D tap at all (both
// moved to proximity/hold — see doors.ts and gameLoop.ts's candleChannelSystem),
// so the veil no longer has anything gameplay-critical to swallow. The one
// remaining tap target left underneath it is the portal's "step through" tap
// — which already has a walk-through-to-win fallback for exactly this reason
// — so it staying unreliable under the veil on mobile costs nothing.
export const DARKNESS_VEIL_ENABLED = true

export const PICKUP_MAX_DISTANCE = 5 // how close you must be to grab a knife
export const WIN_RESET_SECONDS = 10 // win screen time before the run resets

// ---------------------------------------------------------------------------
// CANDLES & DARKNESS — the scene runs at night (scene.json fixedTime 79200 =
// 10 PM). The ONLY candles are the ritual stations (CANDLE_POOL below); the
// hand-placed decorative candle props are hidden at startup. The player's
// own "eyes adjusted to the dark" glow is a small constant baseline; real
// light comes from the ritual candles you've lit.
// ---------------------------------------------------------------------------
export const DARK_LIGHT_RANGE = 1.8 // "eyes adjusted" radius with no flame
export const DARK_LIGHT_INTENSITY = 30 // barely enough to see your own hands
// Constant screen-darkness inside the house (never adjusted — the flames are
// the light source). 0.92 ≈ pitch black; the cap exists because the veil dims
// EVERYTHING on screen including the flames — at 0.99 even fire goes invisible.
export const INTERIOR_DARKNESS = 0.7
export const CANDLE_GLOW_INTENSITY = 900 // lit candle flame-light — the wide "fills the room" light
export const CANDLE_GLOW_RANGE = 18 // widened further, on request — bigger pools of light in the dark
// A second, tighter light layered right at the flame — a bright hot core on
// top of the wide room-fill light above, for a punchier glow immediately
// around the fire itself. Short range on purpose: it must stay a small,
// concentrated halo, not add to how far the light reaches into the room
// (that's what CANDLE_GLOW_RANGE is for) — and short range is also what
// keeps it from re-blowing-out the wax the way the single light did before
// it got moved up to flame height (see FLAME_LIGHT_HEIGHT in gameLoop.ts).
export const CANDLE_CORE_GLOW_INTENSITY = 2200 // pulled back below the original 2400 — too sharp/harsh at 3600
export const CANDLE_CORE_GLOW_RANGE = 9 // bigger again, on request — a larger, softer-reading circle

// THE candle model (ritual stations). Two bakes of the same asset, swapped
// at runtime:
//  - UNLIT: flame GEOMETRY deleted in Blender (the faces on the always-
//    emissive AtlasLight material) — wax body + wick only.
//  - LIT: the untouched original, baked flame and all.
// Lighting a candle swaps UNLIT -> LIT (the model's own flame appears) and
// adds a point light on the wick; snuffing swaps back and removes the light.
// (Bake script: scratchpad bake_candle_flameless.py)
export const MODEL_CANDLE_UNLIT = 'assets/asset-packs/candle_03/HWN20_Candle_03_unlit.glb'
export const MODEL_CANDLE_LIT = 'assets/asset-packs/candle_03/HWN20_Candle_03.glb'

// ---------------------------------------------------------------------------
// THE RITUAL ROUND — the core game loop (quest progression is parked).
// Light all ritual candles before the timer dies, without losing all hearts.
// Every death still kills + respawns as before, but ALSO costs one heart.
// Hearts gone or timer out = DEFEATED; all candles lit in time = WIN.
// ---------------------------------------------------------------------------
// EVERY connected player gets their OWN full copy of this cluster (on
// request: personal/private objectives, but everyone can see — and light —
// everybody's). Each player's copy is nudged by a small CANDLE_OFFSET_BUCKETS
// offset (below) so multiple players' candles at the "same" spot render side
// by side instead of overlapping. Every round, each player draws their OWN
// random subset of RITUAL_CANDLES_REQUIRED from their OWN pool — see
// gameLoop.ts/multiplayer.ts. Spread across yard (4), ground floor (7), and
// upstairs (3) so no single room finishes it.
// Every ground-floor entry below was checked against WALL_SPIKE_UNITS'
// strike points and the dart's flight line (DART_LAUNCH_POINT/TARGET_POINT):
// each keeps a flat/3D margin comfortably over WALL_SPIKE_TRIGGER_RADIUS
// (2.0m) and DART_HIT_RADIUS (0.9m) — a 3.5s stationary channel there can't
// be an unavoidable death. (Two entries deliberately keep some tension —
// see their comments — but stay outside the actual lethal/trigger radius.)
// The small per-player offsets stay comfortably inside those same margins.
//
// `guaranteed: true` entries are always included in every round's random
// draw (on request: two permanent candle spots, now at the two soccer ball
// props) — assignRitualCandles() in gameLoop.ts seeds these first, then
// fills the rest of the round's subset randomly from everything else.
// No collider check runs against these at runtime — an earlier version tried
// exactly that and had to be removed (see the comment on assignRitualCandles
// in gameLoop.ts: the house's visible meshes carry zero collision, so a probe
// can only ever hit the coarse invisible proxy, not judge a real spot
// reliably).
//
// Verified properly once, on request: imported the house model (HLtemplate,
// composite entity 513/"Template") into Blender and ray-cast every entry
// below against its own real "_collider" mesh — the same offline-geometry
// trick that measured the swinging blade's swing. Parity (odd/even hit
// count = inside/outside) turned out unreliable on this specific mesh (two
// spots flagged inconsistently across different ray directions — a sign the
// collision mesh isn't fully watertight, not that they're actually
// embedded), so nearest-surface distance was used instead: every entry
// checked out at 0.79m+ clear of the nearest wall/floor surface in every
// direction tested, comfortably no-collider. This was a one-time check
// against the CURRENT house geometry — if the house model itself changes,
// it'd need re-running, not something this code re-verifies at runtime.
export interface CandleSpot {
  pos: Vector3
  guaranteed?: boolean
}
// Small per-owner visual offsets so different players' candles at the same
// cluster point don't render on top of each other. Picked at random once
// per session (myOffsetBucketIndex in multiplayer.ts) — originally hashed
// from each player's wallet address instead, but that guaranteed a
// collision whenever the SAME account connected twice (e.g. testing with
// one account on PC and mobile at once), stacking two full candle clusters
// on top of each other. A random per-session pick has no such guaranteed
// collision — two players could still randomly land on the same bucket (a
// small, purely cosmetic overlap at that one spot), but it no longer
// depends on identity at all. Kept well inside WALL_SPIKE_TRIGGER_RADIUS/
// DART_HIT_RADIUS margins (see above) so an offset can't accidentally walk
// a candle into a lethal zone.
export const CANDLE_OFFSET_BUCKETS: Vector3[] = [
  Vector3.create(0, 0, 0),
  Vector3.create(0.35, 0, 0.35),
  Vector3.create(-0.35, 0, 0.35),
  Vector3.create(0.35, 0, -0.35),
  Vector3.create(-0.35, 0, -0.35),
  Vector3.create(0, 0, 0.5),
  Vector3.create(0, 0, -0.5),
  Vector3.create(0.5, 0, 0),
  Vector3.create(-0.5, 0, 0),
  Vector3.create(0.25, 0, -0.6)
]
export const CANDLE_POOL: CandleSpot[] = [
  // yard
  { pos: Vector3.create(10, 0, 4) }, // front yard, skeleton country
  { pos: Vector3.create(5, 0, 26.5) }, // back-west garden, deep in skeleton territory
  { pos: Vector3.create(23, 0, 6) }, // near the spawn side
  { pos: Vector3.create(7, 0, 16) }, // mid yard, west path
  // ground floor
  { pos: Vector3.create(18.5, 4.04, 19.0), guaranteed: true }, // at the soccer ball prop (was on the old table) — always assigned, on request
  { pos: Vector3.create(14.6, 2.7, 21.3) }, // west room (the nearby west-wall spike unit was removed, see WALL_SPIKE_UNITS)
  { pos: Vector3.create(26.0, 2.68, 9.2) }, // front-door area, pulled well clear of the east-wall spike units (z 11/13/15)
  { pos: Vector3.create(25.8, 2.68, 20.9) }, // by the back door
  // Just outside the spike wall's lane — crossing the lane is lethal, but the
  // channel spot itself sits past the spikes' reach (station-to-strike-point
  // stays > WALL_SPIKE_TRIGGER_RADIUS, or the 3.5s channel is a guaranteed death).
  { pos: Vector3.create(26.8, 2.58, 14) },
  { pos: Vector3.create(18.5, 2.58, 16.2) }, // beside the carpet — one careless step fires the dart
  // At the second soccer ball prop (was beside the butcher's knife display)
  // — always assigned, on request. ~2.2m flat from the 3rd east-wall
  // spike's strike point (29.2, 3.5, 15) — just outside
  // WALL_SPIKE_TRIGGER_RADIUS (2.0m) but with a tight margin (~0.2m); worth
  // playtesting this specific spot since a 3.5s stationary channel that
  // close could turn into an unavoidable death if the real geometry is even
  // slightly different from these coordinates.
  { pos: Vector3.create(27.59, 2.73, 16.45), guaranteed: true },
  // upstairs
  { pos: Vector3.create(16.9, 8.5, 17.3) }, // near the altar spot
  { pos: Vector3.create(20.9, 8.5, 20.0) }, // far corner
  { pos: Vector3.create(19, 8.4, 17.5) } // survive the climb
]
export const RITUAL_CANDLES_REQUIRED = 7 // "approximately 6-8" — tune via playtesting
export const RITUAL_CANDLES_ROUND1 = 5 // first round easier
export const RITUAL_CANDLE_SCALE = 1.8 // a big candle reads as a station, not set dressing

// ---------------------------------------------------------------------------
// INTERIOR DUST — small motes drifting slowly through the house, catching
// the candle/chandelier glow for atmosphere. Anchored near the same
// ground-floor/upstairs spots CANDLE_POOL already vetted as reachable
// interior space (offset off the exact candle positions), rather than new
// unverified coordinates.
// ---------------------------------------------------------------------------
export const DUST_MOTE_POSITIONS: Vector3[] = [
  Vector3.create(19.8, 4.3, 18.6),
  Vector3.create(14.9, 3.1, 20.8),
  Vector3.create(25.7, 3.0, 9.6),
  Vector3.create(25.5, 3.0, 20.4),
  Vector3.create(27.1, 2.9, 13.5),
  Vector3.create(18.2, 2.9, 15.8),
  Vector3.create(22.5, 3.6, 15.5), // mid-room, head height
  Vector3.create(17.5, 8.9, 17.8),
  Vector3.create(20.6, 8.9, 19.5),
  Vector3.create(19.3, 8.8, 18.0)
]
export const DUST_MOTE_SCALE = 0.018 // shrunk further, on request
export const DUST_DRIFT_RADIUS = 0.6 // meters of wander around each anchor point
export const DUST_DRIFT_SPEED = 0.35 // radians/second — slow

// ---------------------------------------------------------------------------
// BACK-YARD GRASS — Decentraland's official wind-animated grass patch asset
// (already bundled in this project's asset packs, just never placed). The
// wind sway is baked into the asset's own material/shader — nothing in this
// scene's code drives it. Scattered across SKELETON_PATROL_BOUNDS (the same
// back-yard box already used for skeleton patrol — fence/corner-safe, on
// request), placed once at init with no per-frame system, so it costs
// nothing at runtime beyond the GPU's normal rendering of GRASS_COUNT
// instances.
// ---------------------------------------------------------------------------
export const MODEL_GRASS = 'assets/asset-packs/grass_-_long_2/grass_long.glb'
export const GRASS_COUNT = 50
export const GRASS_SCALE_MIN = 0.8
export const GRASS_SCALE_MAX = 1.4

// THE PORTAL — appears the instant a player's candle count is complete.
// Clicking it wins immediately; left alone, it wins for them automatically
// once the timeout runs out (a courtesy, not a requirement).
// Fixed to one spot in the backyard now (on request — used to spawn right
// on top of whoever finished, which didn't tell anyone where to actually
// go). Sits inside SKELETON_PATROL_BOUNDS (x:4-27, z:23-29) — the same
// spacious, collision-clear zone already vetted for skeleton patrol/spawn
// — offset well clear of SKELETON_SPAWNS (15, 0, 26) so the portal and a
// standing skeleton never occupy the same spot.
export const PORTAL_POSITION = Vector3.create(9, 0, 26)
// Neither clicking NOR walking through counts until the portal has been up
// this long — on request, exactly 5 seconds before anyone can actually
// enter it (previously walk-through had only a 1.2s grace and a click could
// win the instant it spawned).
export const PORTAL_ENTRY_DELAY_SECONDS = 5
export const PORTAL_WIN_TIMEOUT_SECONDS = 30
export const PORTAL_RADIUS = 0.6
export const PORTAL_HEIGHT_OFFSET = 1.2 // above the ground
export const PORTAL_COLOR = Color3.create(0.55, 0.25, 0.95) // mystical violet — reads distinct from warm candle flame
export const PORTAL_GLOW_INTENSITY = 4000
export const PORTAL_GLOW_RANGE = 10
export const ROUND_SECONDS = 180 // 3 minutes to finish the ritual
export const ROUND_HEARTS = 3
export const CANDLE_CHANNEL_SECONDS = 3.5 // how long lighting one takes — stand your ground
// Tightened from 3 (on request: must be genuinely close, not lighting from a
// distance). This gates BOTH picking up a channel (candleChannelSystem in
// gameLoop.ts) and staying in it (checked against +0.4 there, a small leash
// so minor movement/jitter mid-channel doesn't cancel it outright).
export const CHANNEL_MAX_DISTANCE = 2.2
// Defeat screen time before the next attempt starts. Kept LONGER than
// RESPAWN_DELAY_SECONDS so a third-death defeat fully swallows the dying
// player's respawn cycle — otherwise the "YOU DIED" screen flashes back for
// the leftover seconds after the round has already reset.
export const DEFEAT_RESET_SECONDS = 11

// Constant darkness veil per zone: the house interior is near-black, the
// yard keeps a lighter permanent gloom so the garden stays navigable.
export const YARD_DARKNESS = 0.35

// The chandelier's riding flame now reuses CANDLE_GLOW_*/CANDLE_CORE_GLOW_*
// directly (see candles.ts) — same attributes as a table candle, on request.
// Dedicated CHANDELIER_GLOW_* constants used to exist here with different
// numbers; removed so the two can't drift out of sync again.

// Every emissive-material prop (letter, altar ember, spike telegraph) gets a
// matching real LightSource — same "flare glow" idea as the candles: an
// emissive material only blooms on its own surface, it doesn't light the room.
export const EMISSIVE_GLOW_RANGE = 5
export const EMISSIVE_GLOW_INTENSITY = 350

// ---------------------------------------------------------------------------
// TRAP 1 — WALL SPIKES (fence model, hidden inside the wall, thrusts out)
// Units on all four interior walls of the ground floor (wall planes read
// from the scene composite: east x~30.3, west x~14, south z~9.1, north
// z~21.2). Each unit hides inside its wall and stabs out toward the room
// when the player is predicted to walk past. Doorways are left clear.
// Interior ground floor is at y ~ 2.58, so y 3.5 = torso height.
// `rotation` points the fence pickets out of that unit's wall - tune in
// preview if any come out sideways.
// ---------------------------------------------------------------------------
export const WALL_SPIKE_UNITS: { hidden: Vector3; extended: Vector3; rotation: Vector3 }[] = [
  // East wall (NFT wall, right after the front door), stabbing west
  { hidden: Vector3.create(30.9, 3.5, 11), extended: Vector3.create(29.2, 3.5, 11), rotation: Vector3.create(0, 0, 90) },
  { hidden: Vector3.create(30.9, 3.5, 13), extended: Vector3.create(29.2, 3.5, 13), rotation: Vector3.create(0, 0, 90) },
  { hidden: Vector3.create(30.9, 3.5, 15), extended: Vector3.create(29.2, 3.5, 15), rotation: Vector3.create(0, 0, 90) }
  // The West wall unit (near the skull table, stabbing east) was removed on
  // request — it sat only ~3.8m from the swinging blade's current position
  // (18.6, 3.2, 16.2), too close to both be live at once.
]
export const WALL_SPIKE_SCALE = 0.8
// Trigger radius <= kill reach: if the spikes fire, you're already inside
// lethal range — no more "it went off but missed me" activations.
export const WALL_SPIKE_TRIGGER_RADIUS = 2.0 // arm when the player is (or is predicted) this close to the strike point
export const WALL_SPIKE_LOOKAHEAD_SECONDS = 0.5 // how far ahead player movement is predicted
export const WALL_SPIKE_WARNING_SECONDS = 0.22 // tips peek out + glow before the full thrust
export const WALL_SPIKE_OUT_SECONDS = 2.0 // how long they stay fully extended
export const WALL_SPIKE_KILL_RADIUS = 1.6 // spike shaft thickness; the player's own body radius (hits.ts) is added on top
export const WALL_SPIKE_KILL_HEIGHT = 2.0 // vertical tolerance around spike height
export const WALL_SPIKE_COOLDOWN_SECONDS = 2.5 // per-unit rest after retracting

// ---------------------------------------------------------------------------
// SKELETON — one walking skeleton guarding the yard (official DCL Halloween
// pack model), one per player (each client spawns its own — see the header
// comment in enemies/skeletons.ts). It wanders the garden; when the player is
// OUTSIDE the house but INSIDE the outer fence, it chases and a touch kills.
// Hover it and press 1 (butcher knife slot) to stab it — two stabs put it
// down; it gets back up at its spawn point after a while.
// ---------------------------------------------------------------------------
// KayKit Skeleton Minion (CC0) — rigged + animated (walk/run/attack/death),
// origin at the feet, ~2.17m tall. Clip names are baked into the GLB.
export const MODEL_SKELETON = 'assets/asset-packs/skeleton_minion/Skeleton_Minion.glb'
export const SKELETON_SCALE = 0.9
export const SKELETON_ANIM = {
  walk: 'Walking_D_Skeletons',
  run: 'Running_A',
  idle: 'Idle_Combat',
  attack: 'Unarmed_Melee_Attack_Punch_A',
  hit: 'Hit_A',
  death: 'Death_A'
}
export const SKELETON_SPAWNS: Vector3[] = [
  Vector3.create(15, 0, 26) // back yard, open ground clear of the house/fence/pillars
]
export const SKELETON_MODEL_Y_OFFSET = 0 // KayKit model origin is at the feet
export const SKELETON_YAW_OFFSET_DEGREES = 0 // set to 180 if they walk backwards
export const SKELETON_WANDER_SPEED = 0.6
export const SKELETON_CHASE_SPEED = 1.9 // faster, on request (was 1.4)
export const SKELETON_TURN_SPEED = 7
export const SKELETON_KILL_RADIUS = 1.2 // touching distance = death
export const SKELETON_ATTACK_REST_SECONDS = 2.5 // pause after a successful kill
export const SKELETON_HITS_TO_KILL = 2 // butcher-knife stabs needed
export const SKELETON_STAB_MAX_DISTANCE = 3.5 // how close you must be to stab
export const SKELETON_STAB_KNOCKBACK = 1.4 // meters shoved back per stab
export const SKELETON_RESPAWN_SECONDS = 15 // downed skeleton rises again after this, at a random yard spot
// The yard: inside the outer iron fence, outside the house footprint.
export const YARD_BOUNDS = { minX: 1.8, maxX: 30.2, minZ: 1.8, maxZ: 30.2 }
export const HOUSE_RECT = { minX: 13.2, maxX: 31.2, minZ: 8.4, maxZ: 22.0 } // exterior footprint
// Wander/patrol is restricted to the back yard only (on request) — entirely
// above the house's maxZ (22.0), so it can never overlap the house footprint
// and doesn't need its own insideHouse rejection check. Pulled in from
// YARD_BOUNDS' outer edges (fence line, corners) so a random wander target
// doesn't land right against the fence or a pillar — chasing a player is
// NOT restricted to this box, only idle wandering is.
export const SKELETON_PATROL_BOUNDS = { minX: 4, maxX: 27, minZ: 23, maxZ: 29 }
// Above this the player is on the porch/upstairs, not in the yard. Loosened
// from 1.5 as a safety margin against any device-to-device variance in
// reported player height (uneven yard terrain, a step, a curb) — upstairs
// itself sits at y≈8.4, so there's still a huge gap below it.
export const YARD_MAX_Y = 3.0

// ---------------------------------------------------------------------------
// OUTER FENCE TIPS — landing on top of the perimeter iron fence is lethal.
// The four kill lines follow the fence rectangle around the plot; you only
// die if your feet are up at tip height (jumping/climbing onto it), never
// from walking beside it on the ground.
// ---------------------------------------------------------------------------
export const FENCE_LINES = { minX: 0.9, maxX: 31.1, minZ: 0.6, maxZ: 31.1 } // fence planes (from the yard pillars)
export const FENCE_TIP_MARGIN = 0.35 // how close (horizontally) to a fence line counts as "on it"
export const FENCE_TIP_Y_MIN = 1.9 // feet height where the tips start to hurt (clear of single AND double jumps beside it)
export const FENCE_TIP_Y_MAX = 2.9 // above this you've cleared the tips

// ---------------------------------------------------------------------------
// TRAP 4 — PRESSURE-PLATE PORTRAIT DART (reuses the "carpet" entity if found)
// ---------------------------------------------------------------------------
export const PRESSURE_PLATE_ENTITY_NAME = 'carpet' // your carpet entity, really at (19.25, 2.58, 17.75)
export const PRESSURE_PLATE_FALLBACK_POSITION = Vector3.create(19.25, 2.58, 17.75)
export const DART_LAUNCH_POINT = Vector3.create(14.6, 3.7, 17.75) // fires from the west wall (wallshelf side), chest height
export const DART_TARGET_POINT = Vector3.create(24, 3.7, 17.75) // flies east across the carpet
export const DART_WARNING_SECONDS = 0.4 // "portrait rattle" telegraph
export const DART_SPEED = 14 // meters/second
export const DART_HIT_RADIUS = 0.9
export const PRESSURE_PLATE_COOLDOWN_SECONDS = 4

// ---------------------------------------------------------------------------
// TRAP 6 — CHANDELIER ELEVATOR CRUSH
// Uses YOUR existing chandelier elevator (the "Vertical Red Pad" smart item
// with the chandelift model, riding y 3.18 <-> 13.18 on a 7s loop). No new
// chandelier is spawned. If the descending chandelier's bottom hits a player
// standing under it, they die. Riding on top stays safe.
// ---------------------------------------------------------------------------
export const CHANDELIER_ENTITY_NAME = 'Vertical Red Pad' // the elevator entity's name in Creator Hub
export const CHANDELIER_BOTTOM_OFFSET = -0.5 // bottom tip of the model relative to its pivot - tune so it matches the visible bottom
export const CHANDELIER_KILL_RADIUS = 1.3 // horizontal radius that counts as "under it"

// ---------------------------------------------------------------------------
// FALL DEATH — physics-based, no coordinates needed.
// Any continuous drop taller than FALL_KILL_DISTANCE that also reaches
// FALL_KILL_MIN_SPEED kills on landing. Works from any ledge in the scene.
//
// Tuning: if falling off the 2nd floor does NOT kill, lower
// FALL_KILL_MIN_SPEED (try 5.5). If walking/running down the stairs DOES
// kill, raise it (try 7.5). Normal jumps only reach ~4.4 m/s so they're
// safe either way.
// ---------------------------------------------------------------------------
export const FALL_KILL_DISTANCE = 4.5 // meters of continuous descent required - well above double-jump apex, so double jumps are safe
export const FALL_KILL_MIN_SPEED = 9 // peak downward m/s required (the ~6m 2nd-floor plunge exceeds this; jumps and stairs don't)

// ---------------------------------------------------------------------------
// TRAP 8 — SWINGING BLADE ("pblade")
// A player-placed pendulum prop (composite entity 592, name "pblade.glb")
// that swings continuously via its own baked Animator clip ("ArmatureAction",
// loop:true) — never hidden or triggered, always live, so unlike every
// other trap here there's no telegraph to add: the ongoing visible swing IS
// the warning.
//
// TWO detection paths, split by platform (same reasoning enemies/skeletons.ts
// already documents for its own raycast feelers):
//
// DESKTOP: a real raycast against the model's OWN baked-in physics collider
// (on request — "I already put colliders in it, just use it"), via
// raycastSystem.registerRaycast() — the IMMEDIATE/synchronous variant, not
// the continuous background-callback variant skeletons.ts uses. That
// distinction matters: this project's documented mobile freeze came from
// continuous raycast callbacks running OUTSIDE addSafeSystem's protection
// (see safeSystem.ts) — registerRaycast() is instead called once per frame
// from directly inside swingingBladeSystem, which IS wrapped, so a throw
// can't silently kill the whole scene the way it could there. This
// correctly follows the blade wherever it's actually swinging RIGHT NOW,
// with no stale-config risk (see below for why that's not hypothetical).
//
// MOBILE: kept OFF, matching the skeleton feelers' own precedent — real
// physics raycasts are exactly the risk category that caused this project's
// one confirmed mobile freeze, and there's no way to verify from here
// whether the immediate variant is actually safe there. Falls back to
// BLADE_SWING_KEYFRAMES: a direct measurement of the swing pulled from the
// source .blend via Blender's MCP tools (Armature action "ArmatureAction",
// 150 frames @ 24fps = 6.25s per loop = BLADE_CYCLE_SECONDS), 25 evenly-
// spaced samples of the blade's true swept extent through the cycle,
// collapsed to a flat radius from BLADE_POSITION (not an oriented box —
// an earlier oriented version killed players nowhere near the blade, and
// with the real desktop path now available this fallback only needs to be
// "roughly right," not precise) scaled by BLADE_SCALE.
//
// BLADE_POSITION/BLADE_ROTATION/BLADE_SCALE are the blade's placed
// Transform, copied from the scene composite — CONFIRMED to drift: between
// building the first version of this trap and this fix, the position moved
// by over 2m and the scale changed from 1.0 to ~0.76 (presumably from
// repositioning/resizing in Creator Hub), which is almost certainly why the
// mobile fallback was hitting players on the 2nd floor — it was centered on
// where the blade USED to be. The desktop raycast path doesn't have this
// problem at all (it asks the real collider, wherever it currently is), but
// the mobile fallback numbers below still need to be kept in sync by hand
// if the blade is moved/resized again.
// ---------------------------------------------------------------------------
export const BLADE_ENTITY_NAME = 'pblade.glb'
export const BLADE_POSITION = Vector3.create(18.596229553222656, 3.2014260292053223, 16.191137313842773)
export const BLADE_ROTATION = Quaternion.create(0, 0.07845909893512726, 0, 0.9969173073768616)
export const BLADE_SCALE = 0.7610105276107788
export const BLADE_CYCLE_SECONDS = 6.25
export const BLADE_KILL_MARGIN = 0.5 // extra buffer on the mobile fallback's radius/height band for the player's own body radius
// Desktop raycast reach/gating.
export const BLADE_TOUCH_DISTANCE = 1.3 // meters — how close a physics hit needs to be to count as "touching"
export const BLADE_OUTER_GATE_RADIUS = 6 // meters from BLADE_POSITION — raycasts only run at all when roughly this close, so it costs nothing everywhere else in the house
export const BLADE_RAYCAST_DIRECTIONS: Vector3[] = [
  Vector3.create(1, 0, 0),
  Vector3.create(-1, 0, 0),
  Vector3.create(0, 0, 1),
  Vector3.create(0, 0, -1),
  Vector3.create(0.707, 0, 0.707),
  Vector3.create(0.707, 0, -0.707),
  Vector3.create(-0.707, 0, 0.707),
  Vector3.create(-0.707, 0, -0.707)
]

export interface BladeKeyframe {
  t: number // 0..1 through the cycle
  rightMin: number
  rightMax: number
  upMin: number
  upMax: number
}
export const BLADE_SWING_KEYFRAMES: BladeKeyframe[] = [
  { t: 0.0, rightMin: -5.494, rightMax: 0.088, upMin: 4.194, upMax: 6.929 },
  { t: 0.0417, rightMin: -5.489, rightMax: 0.091, upMin: 3.969, upMax: 6.702 },
  { t: 0.0833, rightMin: -5.381, rightMax: 0.105, upMin: 3.223, upMax: 5.897 },
  { t: 0.125, rightMin: -5.109, rightMax: 0.12, upMin: 2.326, upMax: 5.582 },
  { t: 0.1667, rightMin: -4.539, rightMax: 0.135, upMin: 1.294, upMax: 5.583 },
  { t: 0.2083, rightMin: -3.45, rightMax: 0.143, upMin: 0.52, upMax: 5.58 },
  { t: 0.25, rightMin: -1.934, rightMax: 0.778, upMin: 0.033, upMax: 5.569 },
  { t: 0.2917, rightMin: 0.003, rightMax: 2.866, upMin: 0.21, upMax: 5.589 },
  { t: 0.3333, rightMin: -0.0, rightMax: 4.305, upMin: 0.95, upMax: 5.611 },
  { t: 0.375, rightMin: 0.004, rightMax: 5.109, upMin: 2.112, upMax: 5.619 },
  { t: 0.4167, rightMin: 0.013, rightMax: 5.518, upMin: 3.376, upMax: 6.073 },
  { t: 0.4583, rightMin: 0.018, rightMax: 5.599, upMin: 4.044, upMax: 6.779 },
  { t: 0.5, rightMin: 0.018, rightMax: 5.599, upMin: 4.058, upMax: 6.793 },
  { t: 0.5417, rightMin: 0.014, rightMax: 5.54, upMin: 3.485, upMax: 6.191 },
  { t: 0.5833, rightMin: 0.006, rightMax: 5.311, upMin: 2.541, upMax: 5.62 },
  { t: 0.625, rightMin: 0.0, rightMax: 4.612, upMin: 1.255, upMax: 5.615 },
  { t: 0.6667, rightMin: 0.001, rightMax: 3.44, upMin: 0.458, upMax: 5.599 },
  { t: 0.7083, rightMin: -0.796, rightMax: 1.922, upMin: 0.016, upMax: 5.573 },
  { t: 0.75, rightMin: -2.685, rightMax: 0.144, upMin: 0.188, upMax: 5.575 },
  { t: 0.7917, rightMin: -3.941, rightMax: 0.141, upMin: 0.765, upMax: 5.582 },
  { t: 0.8333, rightMin: -4.756, rightMax: 0.13, upMin: 1.603, upMax: 5.583 },
  { t: 0.875, rightMin: -5.206, rightMax: 0.116, upMin: 2.547, upMax: 5.581 },
  { t: 0.9167, rightMin: -5.404, rightMax: 0.102, upMin: 3.35, upMax: 6.04 },
  { t: 0.9583, rightMin: -5.49, rightMax: 0.091, upMin: 4.0, upMax: 6.734 },
  { t: 1.0, rightMin: -5.494, rightMax: 0.088, upMin: 4.194, upMax: 6.929 }
]
