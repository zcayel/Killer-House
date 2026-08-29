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
// Which way the player is turned to face on every respawn and round reset
// (gameState.ts's respawnPlayer and gameLoop.ts's resetRound both build their
// movePlayerTo cameraTarget from this — see those call sites).
//
// WAS 180°, which is a half-turn AWAY from the house: Vector3.Forward() is
// +Z, the house sits at z 8.4-22.0, and the spawn is at z=1, so a yawed-180
// look direction aimed the camera at (27, 0.1, -4) — off the plot, at empty
// yard, with the front door directly behind the player. Only the very first
// spawn looked right, because that one comes from scene.json's own
// cameraTarget rather than from here. Every death and every new round after
// it turned the player around, which is its own answer to the Week 2 note
// that players couldn't work out where to go next.
//
// 8° is the flat bearing from SPAWN_POSITION to that same scene.json
// cameraTarget (28, 3, 8) — atan2(28-27, 8-1) — so the first spawn and every
// respawn now agree on where "facing the house" is.
export const SPAWN_ROTATION = Quaternion.fromEulerDegrees(0, 8, 0)
// DEATH REPLAY — records the last seconds of your life and plays them back.
//
// A rolling buffer of position and facing is kept while you are alive; on death
// it is frozen and a ghost walks that exact path with the camera trailing it.
//
// WHAT IT CANNOT DO: the traps are not rewound. SDK7 offers no way to scrub a
// GLB animation to an arbitrary time, so the scene around the ghost is live
// rather than five seconds old. Your movement is a true recording; everything
// else is the present. See effects/deathCam.ts.
export const DEATH_CAM_ENABLED = true
// Off: the replay and the avatar clone appear ONLY when Death Replay is
// pressed, and both are gone the moment it finishes. Dying puts the shot on
// the shelf; it does not take the camera off you.
export const DEATH_CAM_AUTOPLAY = false
// How much of your life to keep. 5s at 20Hz is 100 samples — small enough to
// hold and long enough to show the approach that got you killed, not just the
// last step.
export const DEATH_REPLAY_SECONDS = 5
export const DEATH_REPLAY_SAMPLE_HZ = 20
// Hold on the final frame after the path runs out, so the moment of impact is
// not gone the instant it arrives.
export const DEATH_REPLAY_TAIL_SECONDS = 1.4
// Where the trailing camera sits relative to the ghost.
export const DEATH_CAM_DISTANCE = 4.2  // metres behind
/**
 * Where on the body the camera aims, and how high above that line it sits at
 * rest. Replaces the old flat DEATH_CAM_HEIGHT: once the camera could be
 * orbited and pitched, a fixed world-space height stopped meaning anything —
 * the shot is now a distance and two angles around a point on the avatar.
 * 15 degrees at 4.2m puts the eye ~2.1m up, which is the framing it had before.
 */
export const DEATH_CAM_TARGET_HEIGHT = 1.0
export const DEATH_CAM_PITCH = 15
export const DEATH_CAM_PITCH_MIN = -25 // below this you are looking up through the floor
export const DEATH_CAM_PITCH_MAX = 72  // above this it is a top-down map view

/**
 * CAMERA CONTROL DURING THE REPLAY.
 *
 * PBVirtualCamera itself carries exactly two fields (defaultTransition,
 * lookAtEntity) and has no free-look mode, so the pose is ours to compute every
 * frame. These are the keyboard axes for that: A/D swing around the ghost, W/S
 * push in and pull out. Mouse look is layered on top of them — see
 * DEATH_CAM_MOUSE_SENSITIVITY below.
 *
 * The keys work because InputModifier's disableAll stops LOCOMOTION only —
 * scene input actions still arrive while the body is frozen (see
 * previewSkipPressed in gameLoop.ts). The same keys that would walk you drive
 * the camera instead.
 */
/**
 * MOUSE LOOK. Degrees of camera swing per pixel the pointer moves.
 *
 * PBPrimaryPointerInfo.screenDelta reports pointer movement since the last
 * frame, which is a genuine look axis — the earlier claim in this file that
 * SDK7 exposes no such thing was simply wrong.
 *
 * MOBILE GETS NOTHING FROM IT. PointerType in SDK 7.24.4 enumerates exactly
 * POT_NONE and POT_MOUSE, and the component's own documentation says "Touch,
 * Pad, and Wand support, as well as dragging, will be added later." A finger
 * drag does not arrive here. That is why the on-screen pads exist and are not
 * a desktop afterthought — on a phone they are the only control there is.
 */
export const DEATH_CAM_MOUSE_SENSITIVITY = 0.2

/**
 * SMOOTHING. The raw record shakes, and it is not the sample rate.
 *
 * Two separate sources. The recorded yaw is the player's own camera facing,
 * which jitters every frame under the mouse; the camera position is derived
 * from it, so that noise is amplified straight into the shot. And linear
 * interpolation between 20Hz samples is only C0 continuous — position is
 * unbroken but VELOCITY snaps at every sample, twenty visible kinks a second.
 *
 * So: a moving average over the frozen record kills the sensor noise,
 * Catmull-Rom between samples restores C1 continuity, and the camera is damped
 * toward its target rather than snapped to it. RESPONSE is the damping rate —
 * higher follows the ghost more tightly, lower glides more.
 */
export const DEATH_CAM_SMOOTH_TAPS = 2 // samples either side in the moving average
export const DEATH_CAM_RESPONSE = 9

export const RESPAWN_DELAY_SECONDS = 10
/**
 * How long the death screen HOLDS OFF after you die.
 *
 * MEASURED FROM THE HEADSTONE (on request: the death UI comes up 0.2s
 * after the tombstone). Non-lightning deaths raise their stone on the frame you
 * die (becomeTombstone), so the two are the same clock and 0.5 is the gap.
 *
 * It was 1.5, chosen to clear the 0.9s electrocution flash — but lightning no
 * longer shares this figure (ELECTROCUTION_SCREEN_AT below runs its own paced
 * sequence), so the only thing 1.5 was still doing here was making every other
 * death sit on a blank screen. Walked down 1.5 -> 0.5 -> 0.3 -> 0.2 by feel;
 * 0.2 matches ELECTROCUTION_SCREEN_DELAY so the stone-to-screen beat is the
 * same however you died. The 0.33s death shake now runs PAST this — deliberate,
 * the screen arriving mid-shake reads as part of the impact rather than as a
 * separate event.
 */
export const DEATH_SCREEN_DELAY_SECONDS = 0.2
export const RESPAWN_GRACE_SECONDS = 2 // after respawning, nothing can kill you for this long

// ---------------------------------------------------------------------------
// DEATH EFFECTS — ground quake + blood
// ---------------------------------------------------------------------------

/**
 * GROUND QUAKE — the tremor when thunder lands. See effects/quake.ts.
 *
 * AMPLITUDE IS METRES OF SCENERY MOVEMENT, and it wants to stay small. Sliding
 * the world is what sells the shake, but the world includes the floor the
 * player is standing on: a few centimetres is a convincing jolt, while a
 * visible shove looks like the house came off its foundations.
 */
export const QUAKE_SECONDS = 0.7
export const QUAKE_AMPLITUDE = 0.055

export const BLOOD_MAX_STAINS = 12 // oldest floor stain is removed beyond this
// THREE SPLAT DESIGNS, cycled in order — on request 2026-08-20.
//
// One decal repeated reads as a sticker; with BLOOD_MAX_STAINS at 12 you can
// see a dozen identical marks at once. [2] and [3] are the shipped splat
// mirrored, rotated off-axis and re-proportioned, which changes the SILHOUETTE
// — the spawn code already applies a random yaw, so a plain rotation would have
// been invisible.
export const BLOOD_POOL_TEXTURE = 'assets/scene/Textures/blood_pool.png' // floor decal at the death spot
export const BLOOD_POOL_TEXTURES = [
  BLOOD_POOL_TEXTURE,
  'assets/scene/Textures/blood_pool_2.png',
  'assets/scene/Textures/blood_pool_3.png'
]
// (BLOOD_STAIN_GROUND_SEARCH_DISTANCE lived here — it fed a straight-down
// raycast meant to drop a stain onto the floor beneath a mid-air death. The
// raycast never actually worked; stains are snapped to FLOOR_LEVELS_Y now,
// declared further down beside HOUSE_RECT. See floorBeneath() in
// effects/deathEffects.ts for what was wrong with it.)
// ELECTROCUTION — the cartoon X-ray flash when lightning takes you.
//
// A blue-white star burst with the skeleton lit up inside it, drawn at the spot
// you were standing. Blue-white rather than the traditional yellow so it reads
// as OUR lightning: it is the same palette as the strike flash.
//
// The burst texture is drawn procedurally (a 17-point irregular star polygon
// with a hot white core falling to a saturated rim) so it carries no licence.
export const ELECTROCUTION_TEXTURE = 'assets/scene/Textures/electrocution_burst.png'
/**
 * The X-rayed skeleton, as a FLAT SPRITE rather than the scene's skeleton .glb.
 *
 * On request: the 3D model is a walking enemy built to be seen from any angle,
 * and a 0.9s flash does not need that — from the wrong side it read as a lump
 * rather than as the joke. A billboarded cutout always presents the same
 * legible dancing pose, costs one plane instead of a rigged mesh, and matches
 * the flat cartoon burst it sits inside.
 *
 * Drawn procedurally (capsules and discs into a coverage buffer, hand-rolled
 * PNG encode) so it carries no licence.
 */
export const ELECTROCUTION_SKELETON_TEXTURE = 'assets/scene/Textures/electrocution_skeleton.png'
export const ELECTROCUTION_SKELETON_HEIGHT = 2.3 // metres tall, roughly avatar scale
export const ELECTROCUTION_SECONDS = 0.9   // whole effect, burst and skeleton
export const ELECTROCUTION_BURST_SIZE = 4.2 // metres across at full spread
export const ELECTROCUTION_CAUSE = 'Struck by lightning' // must match lightning.ts

/**
 * THE LIGHTNING DEATH, beat by beat (on request), all measured from the STRIKE:
 *
 *   0.0   strike — burst + skeleton sprite appear instantly
 *   +0.3  headstone drops        (ELECTROCUTION_TOMBSTONE_DELAY)
 *   +0.2  death screen           (ELECTROCUTION_SCREEN_DELAY)
 *
 * These delays used to be stacked ON TOP of ELECTROCUTION_SECONDS, so nothing
 * happened until the 0.9s sprite had fully finished and the whole chain ran to
 * 2.9s. They are now offsets from the strike itself, which is why STONE_AT is
 * no longer derived from ELECTROCUTION_SECONDS.
 *
 * CONSEQUENCE, on purpose: the sprite is still on screen (0.9s) when the stone
 * lands at 0.3 and when the screen comes in at 0.5. The X-ray now plays UNDER
 * the rest of the sequence rather than being waited out — the beats overlap.
 *
 * Every other death still uses DEATH_SCREEN_DELAY_SECONDS and drops its
 * headstone immediately.
 */
export const ELECTROCUTION_TOMBSTONE_DELAY = 0.3
export const ELECTROCUTION_SCREEN_DELAY = 0.2
/** Strike, then stone, then screen. Derived so the beats cannot drift apart. */
export const ELECTROCUTION_STONE_AT = ELECTROCUTION_TOMBSTONE_DELAY
export const ELECTROCUTION_SCREEN_AT = ELECTROCUTION_STONE_AT + ELECTROCUTION_SCREEN_DELAY

export const BLOOD_OVERLAY_TEXTURE = 'assets/scene/Textures/blood_overlay.png' // screen splatter during the death screen

/**
 * THE TITLE on the welcome screen — "KILLER HOUSE" in blood, with it running
 * off the letters.
 *
 * An IMAGE, because react-ecs can only draw text in 'serif', 'sans-serif' or
 * 'monospace' (see uiTheme.ts) and there is no custom-font path — a horror
 * title has to be baked. title-source/title_build.py renders it headless in
 * Blender: Chiller for the letterforms, drips generated to hang off the real
 * glyph outlines. Re-run that script to change the wording or the drips.
 *
 * The aspect ratio is baked into the file and ui.tsx sizes the element from it,
 * so KILLER_HOUSE_TITLE_ASPECT must be updated together with the PNG — the
 * script prints the number it used at the end of every bake.
 */
export const KILLER_HOUSE_TITLE_TEXTURE = 'assets/scene/Textures/title_killer_house.png'
export const KILLER_HOUSE_TITLE_ASPECT = 1024 / 270
// (assets/ui/candle.png is NOT used by the HUD counter. It's a thin
// yellow-flamed taper; the scene's actual candle is a squat cream pillar on a
// flared foot, so candleCounter() in ui.tsx draws the glyph instead of
// shipping art that contradicts the prop the player is looking for. The file
// is still there if a matching render ever replaces it.)

// ---------------------------------------------------------------------------
// MODEL PATHS (from your uploaded scene)
// ---------------------------------------------------------------------------
// Copy of the butcher knife baked (Blender) with the ORIGIN moved to the
// handle grip — used only for the in-hand display so the palm always lands
// on the handle. The original keeps its origin for the table pickup.
export const MODEL_BUTCHERS_KNIFE_HELD = 'assets/scene/Models/butchersknife/butchersknife_held.glb'
// MODEL_KITCHEN_KNIFE removed with the thrown-knife mechanic (2026-08-19).
// The .glb is still on disk and still placed in the scene as a prop; nothing
// in code loads it any more.

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
/**
 * How long a headstone stands before it fades, in seconds. The hover card
 * counts this down in real time, so the player is never surprised by one
 * vanishing.
 *
 * They used to last until the ROUND reset, which is between a few seconds and
 * ten minutes away depending on when you died — no honest countdown can be
 * shown for a deadline like that, and "it disappears at some point" is the kind
 * of vagueness that makes a scene feel unreliable. A fixed lifetime is the
 * thing that makes the timer possible at all.
 *
 * 5s on request. This is deliberately SHORTER than RESPAWN_DELAY_SECONDS (10),
 * so the stone marks the spot during the death beat and is gone before you are
 * back on your feet — a marker for the moment, not a monument you walk back to.
 * It used to be 120s, chosen so you could return and read it; that is no longer
 * the intent. The countdown on the stone still works, it just runs out fast.
 * The round reset still clears any that outlive it.
 */
export const TOMBSTONE_LIFETIME_SECONDS = 5

// ---------------------------------------------------------------------------
// WEAPONS — parked behind WEAPONS_ENABLED below. Every knife is granted for
// free at round start (gameLoop.ts) rather than picked up; this list only
// still feeds the hotbar icons/labels when weapons are re-enabled.
// ---------------------------------------------------------------------------
export const KNIFE_ITEMS = [
  { entityName: 'butchersknife', label: 'Butcher', icon: 'assets/ui/knife_butchers.png' },
  { entityName: 'filletknife', label: 'Fillet', icon: 'assets/ui/knife_fillet.png' }
]
// TEMPORARILY DISABLED (2026-07-21, user request: "take away the ability to
// use weapon but we will put it back later"). Flip this back to true to
// restore ALL weapon use in one line — knife slash (key 1 / hotbar tap),
// stabbing skeletons, and the knife hotbar
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

// PICKUP_MAX_DISTANCE removed with the thrown-knife mechanic (2026-08-19) —
// it existed only for the pick-the-landed-knife-back-up prompt.
export const WIN_RESET_SECONDS = 10 // win screen time before the run resets

// ---------------------------------------------------------------------------
// CANDLES & DARKNESS — the scene runs at night (scene.json fixedTime 79200 =
// 10 PM). The ONLY candles are the ritual stations (CANDLE_POOL below); the
// hand-placed decorative candle props are hidden at startup. The player's
// own "eyes adjusted to the dark" glow is a small constant baseline; real
// light comes from the ritual candles you've lit.
// ---------------------------------------------------------------------------
// The player's own carried "eyes adjusted" light. Widened and brightened from
// 1.8m/30 — at those numbers it genuinely was "enough to see your own hands"
// and nothing else, which is most of why the upper floor read as unnavigable.
export const DARK_LIGHT_RANGE = 6.5
export const DARK_LIGHT_INTENSITY = 260
// Constant screen-darkness inside the house (never adjusted — the flames are
// the light source). 0.92 ≈ pitch black; the cap exists because the veil dims
// EVERYTHING on screen including the flames — at 0.99 even fire goes invisible.
//
// LOWERED 0.7 -> 0.45 on request. Worth knowing what this number can and
// can't do: the veil is a flat UI rectangle drawn OVER the 3D scene (see
// ui.tsx), so it dims the candles, the spike telegraphs and the portal by
// exactly as much as it dims the walls — no light source can ever punch back
// through it. Raising DARK_LIGHT_* above only helps in the same proportion.
// Real readability in the dark wants the veil replaced by a vignette (clear
// in the middle, black at the edges) so the darkness stops being uniform;
// this is the honest interim knob until then.
export const INTERIOR_DARKNESS = 0.45
// Do lit candles cast real shadows? On request. Applies to each candle's
// wide room-fill light only (addFlame in gameLoop.ts), never the tight core
// halo — see the note there. Shadow-casting point lights are the most
// expensive lighting in this scene and up to RITUAL_CANDLES_REQUIRED can be
// burning at once, so this is the first switch to try if mobile framerate
// regresses.
export const CANDLE_SHADOWS_ENABLED = true

// FLICKER RATE for every lit candle's room-fill light (flameFlickerSystem in
// gameLoop.ts). Expressed as radians/second, derived from a period so the
// numbers stay meaningful: rate = 2*PI / period.
//
// 0.3s per cycle, on request — down from 0.5s, and 1.14s before that, which
// read as a slow breath rather than a flame. The jitter is a second, smaller
// wave on top; its period is deliberately NOT a whole fraction of the main one,
// so the two never line up into a visible beat. It moves with the main rate
// (0.34x of it) so that relationship survives any change to the period —
// pinning the jitter at a fixed 0.17s while the main wave sped up would have
// walked them toward a 2:1 ratio and made the flicker pulse regularly.
//
// Do not push far below 0.3s: the light is re-driven once per frame, so a
// period approaching a few frames stops being a flicker and becomes a strobe,
// and on a phone running at 30fps it would alias into flat, arbitrary noise.
//
// (A separate animated flame quad briefly lived here, layered over the
// model's baked flame because neither candle .glb carries an animation track.
// Removed on request — the light flicker is the whole effect now.)
const CANDLE_FLICKER_PERIOD = 0.3
export const CANDLE_FLICKER_RATE = (Math.PI * 2) / CANDLE_FLICKER_PERIOD
export const CANDLE_FLICKER_JITTER_RATE = (Math.PI * 2) / (CANDLE_FLICKER_PERIOD * 0.34)
// How far the light drops at the bottom of a flicker: 0 = dead steady, 1 =
// guttering out completely. 0.45 means a lit candle swings between full
// CANDLE_GLOW_INTENSITY and about 55% of it.
//
// This is the knob that makes the flicker VISIBLE at all. The system used to
// animate only the light's range and left intensity alone, so nothing on
// screen actually changed brightness — raise this if you want the house to
// pulse harder, lower it toward 0.2 if it starts to feel strobey.
export const CANDLE_FLICKER_DEPTH = 0.45

// ---------------------------------------------------------------------------
// CANDLE SMOKE — a thin wisp rising off every lit candle.
//
// Uses the SDK's NATIVE ParticleSystem component, not a pool of billboarded
// planes. The well-known Decentraland smoke sample
// (github.com/decentraland-scenes/Smoke) predates that component and hand-rolls
// the whole thing: an entity pool, a per-puff Transform written every frame, a
// Billboard on each plane and a system to recycle them. That is the right
// answer on SDK6 and the wrong one here — it would put N_candles x N_puffs
// entities and a per-frame transform write into a scene that already has a
// documented history of stalling on the mobile client. ParticleSystem is one
// component per candle and the simulation runs in the engine.
//
// The sprite is generated, not drawn — see smoke-source/make_smoke.py for why
// it is noise-modulated rather than a plain radial gradient.
//
// DELIBERATELY FAINT. This sits on top of the one light source the player
// navigates a dark house by; smoke thick enough to be obviously "smoke" would
// dim and blur exactly the thing they are looking for. It should read at a
// glance as the candle being alive, and never as fog in the room.
// ---------------------------------------------------------------------------
export const CANDLE_SMOKE_ENABLED = true
export const CANDLE_SMOKE_TEXTURE = 'assets/scene/Textures/smoke_puff.png'
// Height above the candle's own origin where the wisp starts — just above the
// flame tip (FLAME_LIGHT_HEIGHT in gameLoop.ts sits at the flame itself), so
// the smoke leaves the fire rather than the wax.
export const CANDLE_SMOKE_HEIGHT = 0.55
export const CANDLE_SMOKE_RATE = 5 // particles/second per candle
export const CANDLE_SMOKE_MAX = 14 // hard cap on live particles per candle
export const CANDLE_SMOKE_LIFETIME = 2.6 // seconds — how far up a wisp gets before it's gone
export const CANDLE_SMOKE_RISE = 0.32 // m/s of constant upward drift
export const CANDLE_SMOKE_CONE_ANGLE = 11 // degrees of spread; a candle wisp is nearly vertical
export const CANDLE_SMOKE_CONE_RADIUS = 0.015 // emitter mouth, roughly the wick
export const CANDLE_SMOKE_SIZE_START = 0.035
export const CANDLE_SMOKE_SIZE_END = 0.26 // puffs expand as they disperse
export const CANDLE_SMOKE_ALPHA = 0.16 // opacity at birth; fades to nothing
export const CANDLE_GLOW_INTENSITY = 900 // lit candle flame-light — the wide "fills the room" light
export const CANDLE_GLOW_RANGE = 34 // widened further again, on request — a friend testing it couldn't spot a lit candle from a distance
// Build-up glow WHILE holding to light a candle — on request (playtest
// feedback: players couldn't tell whether holding was registering). Grows
// from 0 to CHANNEL_GLOW_MAX_INTENSITY as channelProgress advances, so the
// candle itself visibly answers "is this working" instead of only the HUD
// bar. Short range on purpose — a close, personal glow, not room lighting.
export const CHANNEL_GLOW_MAX_INTENSITY = 700
export const CHANNEL_GLOW_RANGE = 4
// A second, tighter light layered right at the flame — a bright hot core on
// top of the wide room-fill light above, for a punchier glow immediately
// around the fire itself. Short range on purpose: it must stay a small,
// concentrated halo, not add to how far the light reaches into the room
// (that's what CANDLE_GLOW_RANGE is for) — and short range is also what
// keeps it from re-blowing-out the wax the way the single light did before
// it got moved up to flame height (see FLAME_LIGHT_HEIGHT in gameLoop.ts).
export const CANDLE_CORE_GLOW_INTENSITY = 2200 // pulled back below the original 2400 — too sharp/harsh at 3600
export const CANDLE_CORE_GLOW_RANGE = 12 // bigger again, on request — a larger, softer-reading circle

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
// gameLoop.ts/multiplayer.ts. Spread across yard (4), ground floor (8), and
// upstairs (3) so no single room finishes it.
// Every ground-floor entry below was checked against WALL_SPIKE_UNITS'
// strike points: each keeps a flat/3D margin comfortably over
// WALL_SPIKE_TRIGGER_RADIUS (2.0m), so a 3.5s stationary channel there can't
// be an unavoidable death. (These clearances were originally measured against
// the thrown-knife trap's flight line too; that trap has since been removed,
// which only ever widened them.) (Two entries deliberately keep some tension —
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
// depends on identity at all. Kept well inside the WALL_SPIKE_TRIGGER_RADIUS
// margins (see above) so an offset can't accidentally walk a candle into a
// lethal zone.
// SHRUNK from a ±0.5-0.6m spread to ±0.22m. The old spread was the single
// biggest cause of candles spawning inside walls: measured against the new
// house's collider, several spots that are comfortably clear at bucket 0 went
// NEGATIVE (i.e. intersecting geometry) at their worst bucket — the front
// door spot lost 0.25m of clearance, the back door 0.18m, the spike-lane spot
// 0.28m. A nudge that can shove an objective into a wall is worse than no
// nudge at all.
//
// They can be this small now because candles are PRIVATE (see the header in
// gameLoop.ts): nobody sees anyone else's, so there is no visual overlap left
// to break up. All the offset still buys is that two players working the same
// cluster point don't stand in exactly the same spot.
export const CANDLE_OFFSET_BUCKETS: Vector3[] = [
  Vector3.create(0, 0, 0),
  Vector3.create(0.15, 0, 0.15),
  Vector3.create(-0.15, 0, 0.15),
  Vector3.create(0.15, 0, -0.15),
  Vector3.create(-0.15, 0, -0.15),
  Vector3.create(0, 0, 0.2),
  Vector3.create(0, 0, -0.2),
  Vector3.create(0.2, 0, 0),
  Vector3.create(-0.2, 0, 0),
  Vector3.create(0.1, 0, -0.22)
]
export const CANDLE_POOL: CandleSpot[] = [
  // yard
  { pos: Vector3.create(10, 0, 4) }, // front yard, skeleton country
  { pos: Vector3.create(5, 0, 26.5) }, // back-west garden, deep in skeleton territory
  // Nudged 0.10m: at two owner offsets the wax was 0.34m from a gravestone,
  // just under CANDLE_MIN_CLEARANCE.
  { pos: Vector3.create(23.08, 0, 6.06) }, // near the spawn side
  { pos: Vector3.create(7, 0, 16) }, // mid yard, west path
  // ground floor
  // Moved 0.40m north. It was 0.04m off the skull prop — not inside it, but
  // close enough that the wax visibly touched at some owner offsets. Still
  // reads as "at the ball". (The move also widened its clearance of the old
  // thrown-knife line, which no longer exists.)
  { pos: Vector3.create(18.5, 4.04, 19.4), guaranteed: true }, // at the soccer ball prop (was on the old table) — always assigned, on request
  // Moved 0.20m off the west wall — was 0.22m at its worst offset.
  { pos: Vector3.create(14.44, 2.7, 21.42) }, // west room (the nearby west-wall spike unit was removed, see WALL_SPIKE_UNITS)
  { pos: Vector3.create(26.0, 2.66, 10.55) }, // front-door area — moved 1.35m in off the wall (was 0.20m INSIDE it at its worst offset)
  { pos: Vector3.create(25.8, 2.65, 19.85) }, // by the back door — moved 1.05m clear (was 0.16m inside the wall)
  // Just outside the spike wall's lane — crossing the lane is lethal, but the
  // channel spot itself sits past the spikes' reach (station-to-strike-point
  // stays > WALL_SPIKE_TRIGGER_RADIUS, or the 3.5s channel is a guaranteed death).
  // Moved 0.30m. At 0.12m this was practically touching the chandelier lift,
  // which is the one prop in the house that MOVES — a candle that close to it
  // would have been swept through on every descent. The move also widens the
  // spike margin this spot was flagged for, 2.20m -> 2.42m.
  { pos: Vector3.create(26.59, 2.66, 13.16) },
  // ON THE AXE CARPET (carpet_3, added in the editor at (20.5, 2.75, 12.0)).
  //
  // The axe corridor had no candle at all — the one part of the ground floor
  // the round could never send you to. Both blades hang from x 20.369 and each
  // sweeps a thin lane: z 10.39-11.45 and z 12.95-14.02, x 13.60-23.55, from
  // y 3.25 up. That leaves a 1.5m safe strip between them, and the carpet
  // (x 17.65-23.35, z 10.09-13.91) lies across all three.
  //
  // z 12.22 is the middle of that strip and NOT in either lane, on request.
  // Measured against the baked lethal boxes with hits.ts's own avatar (r 0.40,
  // h 1.90): 0.69m of air between the player's skin and the nearest lethal box
  // at the base spot, and still 0.47m at the worst CANDLE_OFFSET_BUCKETS nudge.
  // So a full CANDLE_CHANNEL_SECONDS stand here is survivable — but both axes
  // pass within a metre of you while you do it, which is the point of putting
  // it here rather than off to one side.
  //
  // y 2.77 stands it on the rug (floor 2.70, carpet top 2.766) instead of
  // sinking the wax into it.
  { pos: Vector3.create(19.5, 2.77, 12.22) },
  { pos: Vector3.create(18.5, 2.65, 16.2) }, // on the carpet — the pressure plate that
  // used to fire a knife from the wall here was removed on request, so this is
  // now just an exposed spot in the middle of the room.
  // At the second soccer ball prop (was beside the butcher's knife display)
  // — always assigned, on request. ~2.2m flat from the 3rd east-wall
  // spike's strike point (29.2, 3.5, 15) — just outside
  // WALL_SPIKE_TRIGGER_RADIUS (2.0m) but with a tight margin (~0.2m); worth
  // playtesting this specific spot since a 3.5s stationary channel that
  // close could turn into an unavoidable death if the real geometry is even
  // slightly different from these coordinates.
  { pos: Vector3.create(27.44, 2.65, 16.45), guaranteed: true },
  // upstairs
  // THIS IS THE ONE THAT WAS SPAWNING INSIDE A COLLIDER. At several owner
  // offsets the wax sat 0.16m INSIDE Soccer Ball_3 — which is why it looked
  // fine for some players and buried for others. Moved 0.60m.
  { pos: Vector3.create(17.06, 8.5, 17.88) }, // near the altar spot
  { pos: Vector3.create(22.55, 8.45, 19.7) }, // far corner — moved 1.68m clear of the wall
  { pos: Vector3.create(19, 8.4, 17.5) } // survive the climb
]
// HOVER AFFORDANCE — the client's own hover outline, the same one the doors
// wear. Registering PointerEvents on the candle body (whose GLTF carries a
// CL_POINTER collider) is the whole mechanism; the explorer draws the
// highlight itself, on the real model silhouette. Nothing is drawn by this
// scene, so it can't drift from how every other interactive prop looks.
//
// Answers two Week 2 findings at once: which candles are available, and that
// the interaction is a HOLD rather than a tap (the hover text says so).
// Only ever registered on a candle that is drawn AND unlit — see
// syncStationVisuals in gameLoop.ts.
export const CANDLE_HOVER_MAX_DISTANCE = 6 // metres the hover cursor reaches

export const RITUAL_CANDLES_REQUIRED = 7 // "approximately 6-8" — tune via playtesting
export const RITUAL_CANDLES_ROUND1 = 5 // first round easier
export const RITUAL_CANDLE_SCALE = 1.8 // a big candle reads as a station, not set dressing

/**
 * THE CLEARANCE RULE — how much empty space every candle station must have
 * around it, in metres, measured from the wax outward.
 *
 * EXCEPT UNDERNEATH. The floor a candle stands on is expected contact, not a
 * collision, so geometry entirely below the candle's base does not count. Only
 * what is beside it and above it does.
 *
 * The candle is a capsule, not a point: HWN20_Candle_03 at RITUAL_CANDLE_SCALE
 * is 0.45 x 0.72 x 0.39, i.e. a body of radius ~0.23 standing 0.72 tall.
 * Clearance is measured from that surface, so 0 means touching and anything
 * negative means the wax is inside something.
 *
 * IT IS CHECKED AT EVERY OWNER OFFSET, not just at the authored position.
 * CANDLE_OFFSET_BUCKETS nudges each player's copy by up to 0.22m so two players
 * working the same spot are not standing inside each other — which means a spot
 * that is fine at (0,0) and buried at (-0.2, 0) is still a broken spot for
 * whoever draws that bucket. That is exactly how the one at the altar ended up
 * inside a soccer ball for some players and not others.
 *
 * ENFORCED AT AUTHORING TIME, NOT AT RUNTIME, and deliberately so. A scene has
 * no cheap way to ask "what is near this point" — the options are raycasts
 * (unreliable, and this scene has already been burned by them; see the deleted
 * skeleton feelers) or shipping a collision model of the whole house. And a
 * runtime nudge would be worse than the bug: candles would silently drift to
 * different places on different clients, so a player's own candle would not be
 * where the camera preview showed it. The positions below are checked against
 * the real collider triangles offline instead, and the numbers are the answer.
 *
 * Re-run the check after moving any candle, any prop, or the house:
 *   python candle_clearance.py 0.35   (see the scene's scratchpad tooling)
 */
export const CANDLE_MIN_CLEARANCE = 0.35

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

// THE PORTAL — appears the instant a player's candle count is complete.
// Clicking it wins immediately; left alone, it wins for them automatically
// once the timeout runs out (a courtesy, not a requirement).
// Fixed to one spot in the backyard now (on request — used to spawn right
// on top of whoever finished, which didn't tell anyone where to actually
// go). Sits inside SKELETON_PATROL_BOUNDS (x:4-27, z:23-29) — the same
// spacious, collision-clear zone already vetted for skeleton patrol/spawn
// — and clear of both SKELETON_SPAWNS (nearest is the west-row grave spawn at
// (7.25, 0, 20.3), 5.96m away) so the portal and a standing skeleton never
// occupy the same spot.
export const PORTAL_POSITION = Vector3.create(9, 0, 26)
// Neither clicking NOR walking through counts until the portal has been up
// this long — on request, exactly 5 seconds before anyone can actually
// enter it (previously walk-through had only a 1.2s grace and a click could
// win the instant it spawned).
export const PORTAL_ENTRY_DELAY_SECONDS = 5
// (PORTAL_WIN_TIMEOUT_SECONDS lived here — the portal used to win the round on
// its own this many seconds after opening. Removed on request: reaching the
// portal is the last objective now, not a formality. See the long note in
// gameLoop.ts where the auto-win used to be.)
/**
 * THE PORTAL'S ONE SIZE KNOB. Doubled on request (0.6 -> 1.2) — 100% bigger.
 *
 * Everything about the portal hangs off its root Transform, which is scaled by
 * PORTAL_RADIUS * 2 (gameLoop.ts): the vortex disc, the click hitbox and the
 * glow are all children, so they inherit it and this is the only number that
 * has to move. The disc now reads about 6.2m across (2 * RADIUS * DISC_SCALE).
 *
 * It also widens the WALK-THROUGH win, which is checked at PORTAL_RADIUS + 1 —
 * deliberate: a portal you can see from across the yard that only counts if you
 * stand on one exact tile is worse than one whose trigger matches its mouth.
 */
export const PORTAL_RADIUS = 1.2
/**
 * Above the ground. Doubled WITH the radius, on purpose: the disc is centred on
 * this point, so leaving it at 1.2 while the portal grew would have buried the
 * bottom 1.9m of it in the lawn. Scaled together, it sits on the ground exactly
 * as it did before, just bigger.
 */
export const PORTAL_HEIGHT_OFFSET = 2.4
// THE PORTAL IS A SWIRLING VORTEX, not a glowing ball.
//
// It used to be an emissive sphere, which read as "a light" rather than "a way
// out" — nothing about it said you could step INTO it. The vortex is a flat
// disc that always faces the player, spinning continuously.
//
// The texture is drawn procedurally (a 5-arm logarithmic spiral, dark rim ->
// violet -> indigo -> blue -> white core) so it carries no licence.
export const PORTAL_VORTEX_TEXTURE = 'assets/scene/Textures/portal_vortex.png'
// Degrees per second. Negative so it winds INWARD the way the arms point —
// spun the other way it reads as something being flung out of the portal.
export const PORTAL_SPIN_SPEED = -55
// The disc is drawn wider than PORTAL_RADIUS because the texture fades out at
// its own edge; matching them exactly gives a hard circular cut.
export const PORTAL_DISC_SCALE = 2.6

export const PORTAL_COLOR = Color3.create(0.55, 0.25, 0.95) // mystical violet — reads distinct from warm candle flame
export const PORTAL_GLOW_INTENSITY = 4000
export const PORTAL_GLOW_RANGE = 10

// ---------------------------------------------------------------------------
// THE OLD TABLE
// ---------------------------------------------------------------------------
//
// Read by decor/oldTable.ts, which re-asserts the placed entity's model after
// it was reported invisible in world. Every number here is COPIED OUT of
// main.crdt entity 583 - the file the runtime loads - so a code-spawned
// fallback lands exactly where Creator Hub put it. See the header of
// decor/oldTable.ts for what was ruled out before this existed.
export const OLD_TABLE_MODEL = 'assets/scene/Models/oldtable/oldtable.glb'
export const OLD_TABLE_POSITION = Vector3.create(18, 3.213, 18.181)
// CL_NONE. The visible table top is not a collider; the model's own
// `oldtable_collider` node is what you bump into.
export const OLD_TABLE_VISIBLE_COLLISION_MASK = 0
// CL_POINTER | CL_PHYSICS, as placed. Named rather than defaulted because the
// SDK default for this field is CL_PHYSICS alone, which would quietly drop the
// pointer layer the scene was authored with.
export const OLD_TABLE_INVISIBLE_COLLISION_MASK = 3

// ---------------------------------------------------------------------------
// THE VICTORY CINEMATIC - the one shot you can only get by stepping through.
// ---------------------------------------------------------------------------
//
// WHAT IT IS. The instant the portal takes you (gameLoop.ts's win(), which is
// only ever reached from the portal), the camera cuts to a scripted shot of
// YOUR avatar stood on a heap of skulls in front of the leaderboard, throwing
// celebration emotes, while the camera arcs out and up and the board rises
// behind you. Then the win screen fades in over the still-running frame.
//
// WHY IT LIVES WHERE IT LIVES. The board is the only object in the scene that
// says your name, so the reward for escaping is being SEEN in front of it. The
// stage is parked on the board's own centre line, out in the open yard, and the
// camera never leaves the wedge in front of it - see VICTORY_SHOT below.
//
// IT IS LOCAL, LIKE THE DEATH RECAP. The pile is built on this client only, so
// other players in the room do not see it (they see your avatar teleport to the
// board and celebrate, which is true and reads fine). Syncing it would mean one
// pile per player fighting for the same spot, which is a worse artefact than
// the one it fixes. Same call deathCam.ts makes for its replay headstone.
export const VICTORY_CINEMATIC_ENABLED = true

/**
 * WHERE THE HERO STANDS, in world metres.
 *
 * Measured, not guessed. leadboard.glb is placed at (4.75, 1.0, 7.156) yawed
 * -89.7 degrees (main.crdt, the file the runtime actually loads - NOT
 * main.composite, which has disagreed with it by eleven metres before now).
 * Its art face looks down local -Z, and that yaw turns local -Z into world +X,
 * so the board faces +X and "in front of it" means a LARGER x. The face's own
 * centre works out at z ~7.49, which is what this z is rounded to.
 *
 * 6.45m out from the board plane. Clear of everything placed nearby: the
 * grave_31 at (7.917, 0, 7.751) is 3.3m away and the yard candle at (10, 0, 4)
 * is 3.7m - both outside VICTORY_PILE_RADIUS with room to spare, both still in
 * frame, which is a graveyard doing its job rather than a collision.
 */
export const VICTORY_STAGE_POSITION = Vector3.create(11.2, 0, 6.86)

/**
 * THE PILE. A cone of skulls, not a stack - height falls off with radius as
 * H * (1 - (r/R)^VICTORY_PILE_FALLOFF), which is the shape a heap of round
 * things actually settles into. Skulls are scattered over that surface and sunk
 * slightly into it so no one of them reads as balanced on a point.
 */
/**
 * 1.5m, and it started at 2.2. THE FIRST HEAP WAS NOT A HEAP.
 *
 * Spread over a 4.4m circle, 54 skulls covered 39% of the cone's surface: a
 * block-out render of the real models showed skulls SCATTERED ON THE GROUND
 * around someone standing among them, which is not what was asked for and not
 * what the shot needs. Pulling the radius in to 1.5 (and the count up to 62)
 * takes coverage to 85% - dense enough to read as a single mass at wide-shot
 * distance, loose enough that individual skulls still catch the light rather
 * than merging into a lump. tools/verify_victory_shot.py prints the coverage.
 *
 * The height did not move with it, so the same 1.6m of heap now rises over a
 * 1.5m radius instead of 2.2: a proper mound rather than a low spread.
 */
export const VICTORY_PILE_RADIUS = 1.5
export const VICTORY_PILE_HEIGHT = 1.6
export const VICTORY_PILE_FALLOFF = 1.6
/**
 * Skull count. 62 of them, at 196-456 triangles each, is 17.4k - a ninth of
 * this 16-parcel scene's triangle allowance, standing for about fifteen
 * seconds. Raise it for a denser heap; it does not make the heap taller, only
 * fuller, because the summit height is set by VICTORY_PILE_HEIGHT alone.
 */
export const VICTORY_PILE_SKULLS = 62
/**
 * How the skulls are spread from the summit out to the rim: a skull's radius is
 * drawn as R * random^SPREAD.
 *
 * 0.5 is the textbook answer (uniform over the DISC) and it is wrong here. It
 * left two skulls within three-quarters of a metre of the summit, which is the
 * exact patch of ground the hero is standing on and the one the camera is
 * pointed at - a bald crown with a fringe of skulls around the bottom. 1.0
 * (uniform along the radius) overcorrects into a spike.
 *
 * 0.72 puts ten skulls around the feet and still keeps twice as many at the
 * base as at the top, so it reads as a heap that was piled rather than one that
 * was arranged. tools/verify_victory_shot.py prints the distribution and fails
 * if the summit ever goes bare again.
 */
export const VICTORY_PILE_SPREAD = 0.72
/**
 * Two models, mixed. BonesSkull_01 is the bigger and CHEAPER of the two (196
 * triangles to 456), so it carries the bulk and the finer one is sprinkled
 * through it - a heap of one repeated mesh reads as wallpaper from three metres
 * away. Listed twice to weight the draw toward it.
 */
export const VICTORY_SKULL_MODELS = [
  'assets/asset-packs/skull/BonesSkull_01/BonesSkull_01.glb',
  'assets/asset-packs/skull/BonesSkull_01/BonesSkull_01.glb',
  'assets/asset-packs/skull_01/HWN20_Skull_01.glb'
]
/**
 * How far a skull's face may be turned off "pointing away from the summit",
 * in degrees either side.
 *
 * WITHOUT THIS THE HEAP IS A PILE OF ROCKS. A skull's face is on one side of
 * it, and with the yaw drawn uniformly from the whole circle most of them
 * present the back of the cranium - a smooth dome - to any given camera. A
 * block-out render of the real models made that unmistakable: recognisably a
 * heap, not recognisably a heap of SKULLS.
 *
 * Turning them to face outward from the centre fixes it from every angle at
 * once, and is what actually happens when round things are tipped onto a pile:
 * they roll until they are looking away from it. 65 degrees of slop keeps that
 * from reading as an arrangement.
 */
export const VICTORY_SKULL_FACE_JITTER = 65
export const VICTORY_SKULL_SCALE_MIN = 0.85
export const VICTORY_SKULL_SCALE_MAX = 1.3
/** How far each skull is pushed into the cone surface, as a fraction of its own height. */
export const VICTORY_SKULL_SINK = 0.28
/**
 * No skull inside this radius of the summit. The avatar's feet occupy roughly
 * 0.35m and a skull's face poking up through them is the one way this shot can
 * look broken rather than triumphant.
 */
export const VICTORY_PILE_CLEAR_RADIUS = 0.24

/**
 * Where the avatar's FEET go - above VICTORY_PILE_HEIGHT by about a skull's
 * crown, so the summit skulls come up to the ankles and the hero is standing IN
 * the top of the heap rather than hovering over it. As tuned, the tallest skull
 * on the pile crowns at exactly this height and the ones around it sit a few
 * centimetres under the boot.
 *
 * The invisible collider under the pile has its top at exactly this height, so
 * the avatar lands on it instead of dropping through to the yard.
 */
export const VICTORY_STAND_HEIGHT = 1.82
/**
 * Radius of the invisible cap the avatar actually stands on, world metres.
 *
 * An absolute measurement rather than a fraction of VICTORY_PILE_RADIUS, which
 * is what it was: tied to the radius, tightening the heap from 2.2m to 1.5m
 * silently shrank the standing surface to a third of a metre and left the
 * avatar teetering on a post. This is roughly the width of a pair of feet plus
 * a margin, and it does not care how big the heap around it is.
 */
export const VICTORY_STAND_RADIUS = 0.6

// ── THE SET DRESSING ────────────────────────────────────────────────────────
//
// The heap is not the only thing in frame, so the rest of the frame is staged
// too: the yard's own headstones are struck for the duration and two are set
// out flanking the pile, nearer the board. On request.
//
// STRUCK AND REBUILT, NOT MOVED. The graves in the yard are placed entities
// that belong to main.crdt, and writing their Transforms would mean owning the
// job of putting all of them back exactly — including on every path that ends
// the cinematic early, and including a round that crashed halfway through. A
// VisibilityComponent is one boolean per entity, restored the same way, and a
// mis-restore leaves a grave visible rather than a grave in the wrong place.
// The two flanking stones are ours, built and deleted with the pile.

/**
 * Headstones within this of the stage centre are hidden while the shot runs.
 *
 * 6m takes the three that are actually in frame — the grave_31 at (7.92, 7.75)
 * 3.4m away, the grave_15 at (13.50, 4.00) at 3.7m, and the grave_31 at
 * (7.92, 3.00) at 5.1m. The next one out is 6.3m and reads as the graveyard
 * carrying on behind the shot, which is wanted.
 *
 * Matched on the MODEL PATH containing "grave", not on a list of entity names:
 * the names are hand-typed in Creator Hub and a renamed stone would silently
 * stay standing in the middle of the composition.
 */
export const VICTORY_SET_CLEAR_RADIUS = 6
/**
 * Substrings a placed model's src is tested against; any match is struck.
 *
 * THE HOUSE IS ON THIS LIST AND IT IS NOT COSMETIC. KHN.glb's world bounding
 * box is x 14.39..34.72, z 4.38..26.82 — and the shot's camera runs from
 * x 13.97 to x 18.50 along z ~5.9..7.8. Every keyframe past the opening is
 * INSIDE the house footprint, so for most of the arc the camera was sat in the
 * ground-floor room looking west at the hero THROUGH an exterior wall. Striking
 * it is what makes the composition possible at all, not a tidy-up.
 *
 * Matched on the model PATH rather than a list of entity names, because the
 * names are hand-typed in Creator Hub: the house entity is still called
 * "KILLERHOUSE_.glb" even though it loads KHN.glb, which is exactly the kind of
 * drift a name list does not survive.
 *
 * The house is struck regardless of VICTORY_SET_CLEAR_RADIUS — a 20m building
 * whose origin is 12m away is not something a radius test can reason about.
 */
export const VICTORY_SET_CLEAR_MATCH = ['grave']
/** Struck wherever they are, no distance test. See above. */
export const VICTORY_SET_CLEAR_ALWAYS = ['KHN.glb', 'KILLERHOUSE_']

/**
 * The two stones that flank the hero, as offsets from VICTORY_STAGE_POSITION.
 *
 * -X is TOWARD THE BOARD, +/-Z is the board's own width axis, so these sit
 * 1.4m nearer the plate than the pile and 2.6m out either side of it — clear
 * of the 1.5m heap by 1.1m, and close enough to the board to read as part of
 * it rather than as two stones that happen to be standing there.
 *
 * WORLD AXES, NOT THE BOARD'S. leadboard.glb is yawed -89.7 degrees, so its
 * true width axis is (0.0052, 0, 1.0) rather than dead +Z. Over 2.6m that is a
 * 1.4cm error, which is a tenth of the stone's own width — not worth carrying
 * a rotation through this file for. It does mean these move with the stage but
 * not with the BOARD; re-derive if the plate is ever spun in Creator Hub.
 */
export const VICTORY_GRAVE_OFFSETS = [
  Vector3.create(-1.4, 0, 2.6),
  Vector3.create(-1.4, 0, -2.6)
]
/**
 * Same model and scale as the yard's own grave_31s, deliberately: two stones
 * that do not match the ones still standing behind them would read as props
 * rather than as the graveyard rearranging itself.
 */
export const VICTORY_GRAVE_MODEL = 'assets/asset-packs/grave_31/HWN20_Grave_31.glb'
export const VICTORY_GRAVE_SCALE = 1.5
/**
 * Turned to face the camera, which is the same way the yard's grave_31s are
 * already turned (89.99 degrees, main.crdt) — the board's own normal comes out
 * at 90.3, and the third of a degree between them is not visible. A yaw of
 * theta sends a model's local +Z to (sin theta, cos theta), so 90 sends it to
 * +X: straight out of the board, straight at the lens.
 */
export const VICTORY_GRAVE_YAW = 90.3

/**
 * WHICH WAY THE HERO LOOKS, as a point along the camera's own path.
 *
 * The avatar is turned ONCE, at the cut, because turning it again means another
 * movePlayerTo and that would cut the celebration emote off mid-swing. So the
 * single aim has to serve the whole shot, and the question is which moment of
 * the arc to point at.
 *
 * NOT the end of the arc, which is the intuitive answer and the wrong one. The
 * win screen goes up at VICTORY_CINEMATIC_HOLD_SECONDS (6.5) of
 * VICTORY_CINEMATIC_SECONDS (8.5), so the part anyone actually watches is
 * t 0..0.765 — over which the camera swings from -34 to -7 degrees. Aiming at
 * the final +2 would leave the hero facing 36 degrees off the lens for the
 * opening, which is the closest and most readable shot in the whole move.
 *
 * 0.40 sits on the mean bearing of the VISIBLE arc (-19.7 degrees) and is the
 * value that minimises the worst-case error across it: never more than 14
 * degrees off the lens at either end, which reads as looking at the camera
 * rather than past it. Re-derive if the shot or the hold ever change.
 */
export const VICTORY_AVATAR_FACE_T = 0.4

/**
 * THE SHOT, as keyframes. `t` is normalised time across
 * VICTORY_CINEMATIC_SECONDS; everything between is smoothstepped.
 *
 *   phi    degrees around the hero, measured from the axis pointing straight
 *          out of the board (+X). Negative starts the camera on the -Z side, so
 *          the whole move swings back through the middle and ends with the
 *          board dead centre behind the avatar.
 *   dist   metres from the hero's column.
 *   camY   camera height, world metres.
 *   aimY   height on that column the camera looks at.
 *   fov    vertical field of view, degrees.
 *
 * These are not eyeballed, and they were not left where they first landed.
 * Projecting leadboard.glb's four face corners, the pile's base ring and a
 * 1.85m avatar through each keyframe (16:9, vertical fov) gives, in normalised
 * screen coordinates where the visible frame is -1..1:
 *
 *   t=0.00  avatar 39% of frame height, feet at -0.25 with the heap filling
 *           everything below them; board a wall down the right-hand side
 *   t=0.30  avatar 34%, board leaning in from the right
 *   t=0.66  avatar 28%, board x -0.31..+0.57
 *   t=1.00  avatar 24% centred, feet -0.45 head +0.03; board x -0.42..+0.35,
 *           y -0.62..+0.95 - the whole 11.8m of it in frame; the heap runs to
 *           -1.28, so its flanks reach the bottom edge and continue past it
 *
 * THE FIRST VERSION OF THIS ARC WAS TIGHTER AND WORSE. It ended at dist 7.3
 * from a camera 3.55m up looking at 4.35, which put the hero's feet at -0.70 -
 * jammed into the bottom of the frame with the heap almost entirely cropped
 * away underneath. The board was in shot and the thing the player was standing
 * on was not, which is the wrong half of the picture to lose. Dropping the
 * camera and its aim by ~0.9m lifts hero and heap into the middle and still
 * clears the board's top edge, at the cost of two points of avatar height.
 *
 * If you move VICTORY_STAGE_POSITION, re-derive these rather than nudging them:
 * the board is 9.75m wide and 11.8m tall as placed, the whole hero-plus-heap is
 * 3.5m, and any shot containing all of the former can only ever give about a
 * quarter of the frame to the latter. tools/verify_victory_shot.py does the
 * arithmetic and fails on a crop.
 */
export const VICTORY_SHOT: { t: number; phi: number; dist: number; camY: number; aimY: number; fov: number }[] = [
  { t: 0.0, phi: -34, dist: 4.0, camY: 0.9, aimY: 2.4, fov: 52 },
  { t: 0.3, phi: -22, dist: 5.0, camY: 1.55, aimY: 2.85, fov: 54 },
  { t: 0.66, phi: -10, dist: 6.3, camY: 2.15, aimY: 3.2, fov: 55 },
  { t: 1.0, phi: 3, dist: 7.4, camY: 2.65, aimY: 3.6, fov: 56 }
]

/** How long the camera takes to travel the whole of VICTORY_SHOT. It then holds the final frame until the round resets. */
export const VICTORY_CINEMATIC_SECONDS = 8.5
/**
 * How long the full win screen is held back for.
 *
 * SHORTER THAN THE MOVE, deliberately: the overlay arrives while the camera is
 * still travelling, so the shot is never a thing you sit and wait out. The
 * win-screen countdown (WIN_RESET_SECONDS) is frozen for this window and only
 * starts once the overlay is up - otherwise the round would reset out from
 * under the cinematic, which is the same trap the death replay already avoids
 * by holding phaseCountdown while it plays.
 */
export const VICTORY_CINEMATIC_HOLD_SECONDS = 6.5

/**
 * The emotes, cycled. Predefined explorer emotes, so they need no asset and no
 * download - and scene.json already carries ALLOW_TO_TRIGGER_AVATAR_EMOTE for
 * the knife slash. A fresh one fires every VICTORY_EMOTE_INTERVAL seconds and
 * the same one never lands twice running, so a second escape does not look like
 * a replay of the first.
 */
export const VICTORY_EMOTES = ['fistpump', 'handsair', 'dab', 'disco', 'money', 'clap']
export const VICTORY_EMOTE_INTERVAL = 3.2
/** Beat between the cut and the first emote - the avatar should be seen landing before it starts dancing. */
export const VICTORY_FIRST_EMOTE_DELAY = 0.45


// LAST CANDLE — once only ONE of the player's own candles is left unlit, the
// camera briefly cuts to show it. The beam/light/chime "beacon" that used to
// also mark it in-world was removed, on request, once the camera preview made
// it redundant; a HUD compass pointing at it was removed later too, so this
// preview is now the ONLY thing that tells a player where their last candle
// is. Player input is frozen and
// they're invulnerable for the preview window (see gameState.ts's
// cameraLockInvulnerable), so nothing can hit them while they can't see or
// move themselves.
// 3s base + 3s added for the slow turn (on request) = 6s total on screen.
export const LAST_CANDLE_PREVIEW_SECONDS = 6
// How far around the candle the camera turns over that whole window — a
// slow reveal rather than a static shot, on request.
export const LAST_CANDLE_PREVIEW_TURN_DEGREES = 240
// The distance-based "skip it if already close" rule was removed, on
// request — flat 3D distance treated a candle directly overhead/underfoot
// on a different floor as "close" even though a ceiling/floor sits between
// them, which was exactly wrong for the 2nd-floor candles. The last candle
// now always triggers the camera cut, full stop.

// If a full minute passes with no candle lit at all (player's stuck/lost),
// the camera also cuts — to whichever of the player's own remaining candles
// is nearest, not necessarily the last one. Same cut, same invulnerability/
// input-freeze window, just a different trigger condition.
export const LAST_CANDLE_STUCK_SECONDS = 60
export const LAST_CANDLE_PREVIEW_BACK = 3.2 // how far behind the candle the preview camera sits
export const LAST_CANDLE_PREVIEW_UP = 2.4 // how high above the candle the preview camera sits
export const LAST_CANDLE_PREVIEW_TRANSITION_SECONDS = 0.6 // smooth pan in/out instead of an instant cut, on request
// A wall/prop can sit between the candle and where the default offset would
// put the camera, so the shot gets pulled in short of whatever it hits — this
// is the closest that's still allowed to count as a usable shot before that
// candidate is abandoned for the next one (see findClearCameraPose). Raised
// from 1.0 — the fallback shot was reading as too close.
export const LAST_CANDLE_PREVIEW_MIN_DIST = 1.8

export const ROUND_SECONDS = 600 // 10 minutes to finish the ritual
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
  { hidden: Vector3.create(30.9, 3.5, 15), extended: Vector3.create(29.2, 3.5, 15), rotation: Vector3.create(0, 0, 90) },
  // The West wall unit (near the skull table, stabbing east) was removed on
  // request — it sat only ~3.8m from the swinging blade's current position
  // (18.6, 3.2, 16.2), too close to both be live at once.
  //
  // Ground floor, the wall at z~20.6 dividing two ground-floor rooms. Replaces
  // 4_6/4_7 — those were adopted Creator Hub fences that ended up lying flat in
  // the yard (see wallSpikes' history). Same failure class every adopted fence
  // risks: rotating a prop to LOOK right in Creator Hub does not make its bar
  // axis point the direction the trap needs. Spawned instead, so position and
  // rotation are chosen and verified together, the same as the units above.
  // Real wall face measured by horizontal ray-cast against KILLERHOUSE_.glb
  // (tools/probe_floor.py-style cast); real floor confirmed on both sides.
  // Verified (tools/verify_spikes.py logic): 24 kills, 0 unfair, each.
  { hidden: Vector3.create(16.5, 3.5, 19.8), extended: Vector3.create(16.5, 3.5, 21.5), rotation: Vector3.create(0, 90, 90) },
  { hidden: Vector3.create(20.5, 3.5, 19.8), extended: Vector3.create(20.5, 3.5, 21.5), rotation: Vector3.create(0, 90, 90) },
  //
  // The second entrance (Old Wooden Door_2, 26.93, 2.59, 21.20) unit was
  // REMOVED on request (2026-08-18): it killed players walking through that
  // doorway, with nothing visibly extended.
  //
  // Why it was killing, and the measuring gap that hid it — worth keeping,
  // because the same trap is easy to re-lay:
  //   - The unit was VERTICAL. Its rotation (0, 90, 90) mapped the model's
  //     4m length onto world Y, so the panel stood y 0.99-4.35 and its
  //     pickets ran along +Z. That vertical span never moved with travel,
  //     so the panel's lethal band always straddled the ground floor (2.65).
  //   - Its lethal X band was 25.80-26.30 (panel 25.96-26.09 plus
  //     WALL_SPIKE_TOUCH_MARGIN and the player radius). The doorway opening
  //     is x 26.3-26.8 — so the doorway's west jamb sat exactly ON the
  //     lethal edge.
  //   - The kill test fires at ANY travel > 0.1, and the telegraph peek is
  //     0.18. At travel 0.11-0.18 the lethal band covered z 20.50-23.60,
  //     which contains the doorway at z 21.20. So it killed during the
  //     0.22s telegraph, before the thrust the player could see.
  //   - tools/verify_spikes.py only ever evaluated the FULLY EXTENDED pose
  //     (`at = e`), where this unit's band had moved on to z 22.1-25.0 —
  //     clear of the door. That is why it reported 47 kills / 0 unfair for a
  //     unit that was killing people at the doorway: the pose that did the
  //     killing was never tested. If a mid-travel pose test is ever added to
  //     that tool, this unit is the regression case.
  //
  // THERE ARE NO UPPER-FLOOR UNITS, on request (2026-08-18).
  //
  // Two lived here and both are gone. The original "upper floor, east side"
  // unit (hidden 24.6, 9.6, 21.05) was replaced by one at Iron Fence 1's own
  // placed pose (16.446, 5.75, 20.931), and that one has now been deleted
  // too. Everything left in this list is ground floor or below.
  //
  // If an upper-floor spike is ever wanted again: the landing up there is
  // narrow (real floor at y~8.6 exists only in a ~0.3m strip around z 21.5
  // before dropping away), which is what made both attempts awkward. Measure
  // the strip with tools/probe_floor.py FIRST, then place the unit, rather
  // than reading a decorative prop's transform out of main.composite and
  // hoping the floor beside it is real.
]
export const WALL_SPIKE_SCALE = 0.8
// Trigger radius <= kill reach: if the spikes fire, you're already inside
// lethal range — no more "it went off but missed me" activations.
export const WALL_SPIKE_TRIGGER_RADIUS = 2.0 // arm when the player is (or is predicted) this close to the strike point
export const WALL_SPIKE_LOOKAHEAD_SECONDS = 0.5 // how far ahead player movement is predicted
export const WALL_SPIKE_WARNING_SECONDS = 0.22 // tips peek out + glow before the full thrust
export const WALL_SPIKE_OUT_SECONDS = 2.0 // how long they stay fully extended
// THE LETHAL VOLUME IS THE MODEL, MEASURED — see WALL_SPIKE_MODEL_BOXES below,
// which is now the single source for it. WALL_SPIKE_PANEL_MIN/MAX used to live
// here as a second, separately-measured copy of the same envelope; it had
// already drifted 5cm from the model on z, and it described one box round the
// whole panel when the panel's top is an arch. Removed rather than kept in
// sync by hand.
//
// WHAT THE MEASURED APPROACH REPLACED, and why it matters: the original test
// was a capsule of WALL_SPIKE_KILL_RADIUS 1.6 (+0.4 body = 2.0m) around the
// thrust axis, with a vertical band of extended.y +/- WALL_SPIKE_KILL_HEIGHT
// 2.0. Measured against the actual panel, that was wrong in three directions
// at once:
//   - LATERALLY ~30x too wide. The panel is a 0.19m sheet; the capsule was
//     4m across. You could stand two metres to the side of a paper-thin
//     fence and die.
//   - 2m OF LETHAL AIR BELOW IT. The model hangs entirely ABOVE its own
//     origin (+0.01 to +3.20), but the band was centred ON the origin, so
//     y 1.5-3.49 killed with nothing drawn there at all.
//   - WRONG LENGTH. The capsule ran hidden->tip and stopped, while the panel
//     reaches 2.4m further into the room, and the capsule's far cap sat 3.4m
//     inside the wall where nothing is visible.
// Between them, the volume that killed you and the spikes you could see
// barely overlapped — which is the "died while jumping above visible spikes"
// report from the Week 2 playtest.
export const WALL_SPIKE_COOLDOWN_SECONDS = 2.5 // per-unit rest after retracting

// ---------------------------------------------------------------------------
// WALL SPIKES AUTHORED IN CREATOR HUB
//
// Name a fence entity you placed in the scene and the trap adopts it: same
// telegraph, same thrust, same lethal check, same cooldown as the units above.
// You keep positioning, rotating and sizing them in Creator Hub.
//
// TWO RULES WHEN PLACING ONE:
//   1. Put it where it should REST, i.e. tucked out of sight inside the wall.
//      That pose is the hidden pose; the trap thrusts it out from there and
//      pulls it back to it.
//   2. Aim it. The thrust direction is read off the entity's own rotation —
//      the fence model's pickets run along its local +Y, so whichever way the
//      spikes point is the way it stabs. Nothing here is axis-locked, so a
//      fence turned at any angle works.
//
// On adopt, each one is detached from its Creator Hub group (its transform is
// baked to world first, so it does not move) and its collider is stripped, for
// the same reason the spawned units carry CL_NONE — a fence with collision
// parked inside a wall is an invisible obstruction in the room next to it.
// ---------------------------------------------------------------------------
export const WALL_SPIKE_PLACED_NAMES: string[] = [
  // Only these two still exist as placed entities. 4_6, 4_7, 4_8, 4_9 and 4_10
  // were deleted from the scene — 4_6/4_7 were flat slabs in the yard, 4_8/4_9
  // thrust into open air with no floor behind them, and 4_10 (which did work)
  // went with them. All three working spots are recreated as spawned units in
  // WALL_SPIKE_UNITS above instead, where position and rotation are chosen and
  // verified together rather than depending on a fence rotated by eye.
  //
  // Ground floor, flanking the z=15.08 doorway. Both carry a non-uniform
  // (1.2, 1, 1) scale, which transformedBoxes() handles correctly: it scales
  // each box corner in MODEL space and only then rotates, so the panel gets
  // wider without the hit boxes shearing.
  'Iron Fence 4_5', //  (18.79, 1.07, 15.08)  euler (0, 0, -3.2)
  'Iron Fence 4_11' // (24.41, 1.07, 15.08)  euler (0, 0, -3.2) — the other door
]

// Metres the pickets travel. 1.7 is exactly the throw of the three spawned
// units (hidden x 30.9 -> extended 29.2), so an adopted spike moves like them.
export const WALL_SPIKE_PLACED_TRAVEL = 1.7
// HWN20_IronfFence_04.glb's own bounds at scale 1, unrotated, straight out of
// the GLB's POSITION accessors. Local +X is the panel's length, +Y is the
// pickets, +Z is the sheet thickness. wallSpikes.ts rotates and scales this box
// per adopted unit to get that unit's lethal volume, so the volume that kills
// you is the volume you can see however the fence has been turned.
export const WALL_SPIKE_MODEL_MIN = Vector3.create(-0.013, -0.348, -0.117)
export const WALL_SPIKE_MODEL_MAX = Vector3.create(4.004, 3.028, 0.117)

/**
 * THE LETHAL VOLUME, AS BOXES — "no bigger than the spike itself".
 *
 * One box round the whole panel is wrong at the top. The panel's top edge is
 * an ARCH: it is full width only up to y 2.475, then tapers to a finial at
 * y 3.05. Since y is the picket/reach axis, a single box claims the full
 * 3.03m of reach across the panel's entire height, and the last ~0.55m of
 * that is air at almost every height — lethal space with nothing drawn in it.
 *
 * These eight boxes were measured by voxelising HWN20_IronfFence_04.glb at
 * 25mm and taking each slice's real extent; they contain 100% of the model's
 * solid cells while cutting the dead air. wallSpikes.ts rotates and scales
 * them per unit, so this works at any angle or size.
 *
 * (The panel is a low-poly alpha-textured slab rather than separate pickets,
 * so its silhouette really is ~82% solid — which is why this is eight boxes
 * and not eighty. The remaining win came from the arch, not from gaps.)
 */
export const WALL_SPIKE_MODEL_BOXES= [

  // MEASURED OFF THE VISIBLE MESH ONLY — regenerate with
  //   python tools/bake_spike_boxes.py --cell 0.20 --max-boxes 18
  //
  // These used to be measured over the whole .glb, which includes a node called
  // HWN20_IronfFence_04_collider: a SOLID 3.97 x 3.04 x 0.23m box proxy. A
  // physics collider is meant to be cheap and generous; a KILL volume is a
  // promise about what the player can see, and they must not be the same shape.
  // Taking the slab made the lethal volume the full panel rectangle — 0.23m
  // thick instead of the fence's real 0.16m, and solid across an object whose
  // visible geometry fills 49% of its own face.
  //
  // Rasterised at 0.20m, which is PLAYER scale rather than picket scale: gaps
  // narrower than that are bridged by the player's own 0.4m body radius anyway,
  // so filling them costs nothing, while the arch at the top and the open
  // margins are correctly excluded. 0.80 m3 against the old slab's 3.15 m3.
  //
  // 31 boxes, not 18 — the first bake capped the box budget and left 17 real
  // picket cells and 3831 surface points UNCOVERED. That is a MISSED kill, not
  // a phantom one: verify_spikes.py only ever checked for false positives, so
  // the hole shipped silently until a player walked through it. Regenerate
  // with --max-boxes raised until 'uncovered occupied cells' reads 0.
  { min: Vector3.create(3.587, -0.148, -0.052), max: Vector3.create(3.987, 2.252, 0.109) },
  { min: Vector3.create(0.387, 1.052, -0.052), max: Vector3.create(0.987, 2.652, 0.109) },
  { min: Vector3.create(1.187, 1.452, -0.052), max: Vector3.create(2.787, 1.852, 0.109) },
  { min: Vector3.create(3.187, -0.348, -0.052), max: Vector3.create(3.387, 2.452, 0.109) },
  { min: Vector3.create(0.987, -0.348, 0.027), max: Vector3.create(1.787, 0.252, 0.085) },
  { min: Vector3.create(1.987, -0.148, -0.012), max: Vector3.create(2.187, 1.452, 0.061) },
  { min: Vector3.create(2.587, -0.148, -0.006), max: Vector3.create(2.787, 1.452, 0.070) },
  { min: Vector3.create(0.387, -0.348, 0.028), max: Vector3.create(0.587, 1.052, 0.085) },
  { min: Vector3.create(0.787, 0.252, 0.030), max: Vector3.create(1.387, 0.652, 0.085) },
  { min: Vector3.create(1.587, 0.252, 0.019), max: Vector3.create(1.787, 1.452, 0.082) },
  { min: Vector3.create(1.187, 2.052, -0.007), max: Vector3.create(1.787, 2.452, 0.091) },
  { min: Vector3.create(1.987, 1.852, -0.045), max: Vector3.create(2.187, 2.852, 0.053) },
  { min: Vector3.create(1.187, 0.652, 0.028), max: Vector3.create(1.387, 1.452, 0.085) },
  { min: Vector3.create(2.987, 0.852, -0.052), max: Vector3.create(3.187, 1.652, 0.109) },
  { min: Vector3.create(0.387, 2.652, -0.007), max: Vector3.create(0.787, 3.052, 0.091) },
  { min: Vector3.create(0.187, 0.452, 0.030), max: Vector3.create(0.387, 1.052, 0.085) },
  { min: Vector3.create(2.387, 0.852, -0.007), max: Vector3.create(2.587, 1.452, 0.056) },
  { min: Vector3.create(2.387, 1.852, -0.039), max: Vector3.create(2.587, 2.452, 0.060) },
  { min: Vector3.create(3.387, -0.348, 0.048), max: Vector3.create(3.587, 0.052, 0.106) },
  { min: Vector3.create(0.787, 0.652, 0.030), max: Vector3.create(0.987, 1.052, 0.085) },
  { min: Vector3.create(-0.013, 1.652, -0.052), max: Vector3.create(0.387, 1.852, 0.109) },
  { min: Vector3.create(1.187, 2.452, 0.020), max: Vector3.create(1.587, 2.652, 0.055) },
  { min: Vector3.create(0.787, 0.052, 0.030), max: Vector3.create(0.987, 0.252, 0.085) },
  { min: Vector3.create(2.787, 1.452, -0.052), max: Vector3.create(2.987, 1.652, 0.109) },
  { min: Vector3.create(3.387, 1.452, -0.052), max: Vector3.create(3.587, 1.652, 0.109) },
  { min: Vector3.create(3.987, 1.452, -0.052), max: Vector3.create(4.187, 1.652, 0.109) },
  { min: Vector3.create(0.987, 1.652, -0.052), max: Vector3.create(1.187, 1.852, 0.109) },
  { min: Vector3.create(1.187, 1.852, 0.019), max: Vector3.create(1.387, 2.052, 0.076) },
  { min: Vector3.create(1.587, 1.852, -0.007), max: Vector3.create(1.787, 2.052, 0.091) },
  { min: Vector3.create(1.787, 2.252, -0.046), max: Vector3.create(1.987, 2.452, 0.052) },
  { min: Vector3.create(3.587, 2.252, -0.016), max: Vector3.create(3.787, 2.452, 0.019) },
]

/**
 * How close the panel has to get before it counts as touching you, in metres
 * from the player's centre.
 *
 * hits.ts defaults this to PLAYER_BODY_RADIUS (0.4), which is sized for solid
 * props. The spike panel is a 0.234m sheet, and 0.4m a side turns it into a
 * 1.034m lethal slab — 4.4x its own thickness, so you die standing a clear
 * 0.4m to the side of it with nothing near you. Reported as spikes killing
 * without touching the avatar.
 *
 * 0.22 is about the avatar's half-width at the shoulder, which puts the kill
 * at the moment the panel reaches the body rather than the moment it reaches
 * a generous bubble around it.
 */
export const WALL_SPIKE_TOUCH_MARGIN = 0.22

// ---------------------------------------------------------------------------
// TRAP — SWINGING PLANKS AND BLADES (fplank.glb x4, pblade2.glb x2)
//
// These are authored in Creator Hub with their swing baked into the GLB, and
// they shipped with Animator playing:true — swinging forever, hitting nobody
// in particular. On request they now behave like the wall spikes instead: the
// clip is stopped at load and only played when the player's PREDICTED position
// says they are about to walk into the swing.
//
// THE KILL VOLUME FOLLOWS THE SWING, and it is the model: both clips were
// sampled offline and fitted with oriented boxes, which traps/swingTrapShapes.ts
// holds — all 52 keyframes of it, which is why it lives in its own module and
// not here. Only the tuning knobs are below. Same "measured, not estimated"
// rule the wall spikes and the old blade follow.
//
// Note fplank.glb ships TWO clips: one drives the visible plank and the other
// drives fplank_collider, and BOTH travel the same 5.07m — which is what makes
// the dropped plank walkable as a bridge. pblade2.glb has no collider node
// whatsoever, so it is hazard-only.
// ---------------------------------------------------------------------------
export const SWING_TRAP_LOOKAHEAD_SECONDS = 0.8
// Grow the swept footprint by this much when testing whether to fire. Arming
// is deliberately generous where the kill is exact, same split as the spikes:
// better to swing at someone who then veers off than to miss someone who
// walks in mid-clip.
export const SWING_TRAP_TRIGGER_MARGIN = 1.4
// Rest between the clip ending and the trap being able to fire again, so
// standing in the swing lane isn't an unbroken chain of deaths.
export const SWING_TRAP_COOLDOWN_SECONDS = 2.0
// Skin on top of the box, over and above the player's own body radius.
//
// Nearly zero because nothing here needs slack any more: the shape is the
// model's, the test is exact (orientedBoxHitsPlayer measures a real distance
// rather than a horizontal range and a vertical band separately), and the fast
// part of a swing is sub-stepped so a plank cannot cross the player between two
// frames. What is left is float noise, not tolerance.
// SHOW THE LETHAL BOXES IN-WORLD, as real child entities of the trap itself.
//
// Flip true and every box the kill test uses is drawn, parented to the prop.
// Because they are CHILDREN, the engine's own transform hierarchy moves them
// — there is no code path that can leave them behind when the prop is moved,
// which is exactly the bug that made the axe kill at its previous position
// (the boxes were built from a transform snapshotted at startup).
//
// It is a debug view, not a shipping feature: it spawns one entity per box
// per unit (41 x 6 for the current bake) and updates their local transforms
// every frame. Leave it false unless you are checking alignment.
// SHOW EVERY KILL VOLUME IN THE SCENE.
//
// One switch for all of them — blades, planks, wall spikes, chandelier,
// lightning, skeleton, fence tips — drawn by debug/killVolumes.ts, colour-coded
// per hazard. Fall damage has no volume (it is a descent-height rule) so it is
// the one killer with nothing to draw.
//
// This exists because a kill volume you cannot see is one you cannot check.
// The swing-trap boxes were the MIRROR IMAGE of the blade for days and every
// offline gate passed, because they all measured the bake against the same
// glTF the bake came from. Drawing the two candidates in-world settled it in a
// single preview. When a hazard "kills without touching", turn this on first.
//
// Costs an entity per box per hazard, updated every frame. Ship it false.
export const SHOW_KILL_VOLUMES = false

// Swing traps specifically. Kept separate so the blades can be inspected on
// their own without the rest of the scene lit up.
export const SWING_TRAP_SHOW_HITBOXES = false
export const SWING_TRAP_TOUCH_MARGIN = 0.05

// The lethal-box shrink MOVED to SwingTrapModel.extentShrink in
// traps/swingTrapShapes.ts on 2026-08-19, because one global number cannot
// serve both parts: the axe is a pure hazard (0.90, on request) while the
// plank is a bridge the player stands on (0.95) and over-trimming it is how
// you fall through the floor.
//
// WHY A SHRINK EXISTS AT ALL: tools/bake_hit_shapes.py fits boxes with a
// ONE-SIDED criterion. It reports "surface points outside all boxes" — mesh
// the boxes fail to COVER, i.e. missed kills — and never measures box volume
// sitting outside the MESH, which is the phantom-kill direction. So overhang
// was never optimised. The shrink is the blunt correction; the real fix for
// the axe was raising the baker's slice ceiling (see --slices there).

// THE PLANK STAYS DOWN ONCE IT LANDS.
//
// It is the way up to the second floor, and the clip only holds it down for
// 4.5s before lifting again — not long enough to find it, commit, and climb
// 6m of ramp. On landing the animation is frozen (speed 0, so the visual and
// the hit boxes stay in step) for this long, then released.
//
// 10 on request (2026-08-18), down from 30. Still well over the clip's own
// 4.5s, so the "find it, commit, climb" reason above is intact; 30 just left
// the board lying down for most of a round.
// 6 on request 2026-08-20 (10 -> 8 -> 6). Still above the clip's own 4.5s, so
// the board is genuinely held rather than just finishing its animation, but the
// window to spot it, commit and climb is now tight — if the upper floor starts
// feeling unreachable, this is the number.
// Pause between a plank arming and the board actually dropping.
//
// 0.3 on request 2026-08-20 (0.5 first, then tightened). With the trigger
// sitting exactly on the landing patch and the drop taking ~0.6s, there was no
// reaction window at all — you stepped on the spot and it was already on you.
// This is the window, and it is deliberately short: enough to register the
// whoosh and move, not enough to stroll out.
//
// Only the planks have it: a blade telegraphs itself by being a visible thing
// swinging at you, a falling board does not.
export const SWING_TRAP_PLANK_TRIGGER_DELAY = 0.3

export const SWING_TRAP_PLANK_HOLD_SECONDS = 6

// It lands twice: the hit, then the board settling back down. Second one is
// quieter, which is what makes it read as one event rather than two.
// 35% higher on request 2026-08-20. NOTE: DCL clamps an AudioSource at 1.0,
// so raising this alone does nothing — the impact was already at the ceiling.
// The bounce and the swing are lowered to match instead, which makes the
// landing 35% louder RELATIVE to the rest of the trap, which is the audible
// result that was asked for.
// DUST BURST when the plank slams into the floor.
//
// A board that heavy landing on a dusty floor should throw something up; without
// it the landing reads as the board simply teleporting to the ground. Puffs are
// spawned ALONG the fallen board rather than in one spot, because the whole
// length hits at once.
//
// The texture is drawn procedurally (a sum of offset Gaussian blobs inside a
// radial falloff) so it carries no licence — see tools notes in the repo.
export const PLANK_DUST_TEXTURE = 'assets/scene/Textures/dust_puff.png'
export const PLANK_DUST_PUFFS = 7      // spread along the board's length
export const PLANK_DUST_SECONDS = 0.55 // fast: it is a slam, not a fog
export const PLANK_DUST_SIZE = 1.5     // metres across at full spread
export const PLANK_DUST_RISE = 0.9     // how far a puff drifts up before it goes

export const SWING_TRAP_PLANK_IMPACT_VOLUME = 1.0
export const SWING_TRAP_PLANK_BOUNCE_VOLUME = 0.33
export const SWING_TRAP_PLANK_BOUNCE_DELAY = 0.19 // seconds after the first
// Whoosh as a unit starts moving, at the pivot.
export const SWING_TRAP_SWING_VOLUME = 0.59
// The axes 30% above the plank whoosh, on request 2026-08-20. Separate knob
// because they are separate sounds now (SOUND_AXE_SWING) and a 9m blade should
// carry further than a board tipping over.
export const SWING_TRAP_AXE_VOLUME = 0.77

// WHERE THE AXES ARE — IN CODE, NOT IN CREATOR HUB.
//
// The four planks are still adopted from the editor: they are drawbridges cut
// into the house geometry and their placement is part of the level. The two
// pblade2 axes are SPAWNED FROM HERE instead, because placing them in the
// editor was the direct cause of the phantom kills, three separate ways:
//
//   1. TWO FILES DISAGREED. Creator Hub writes assets/scene/main.composite;
//      the runtime loads main.crdt. On 2026-08-19 those held different
//      positions for pblade2.glb_2 — (15.75, 11.75, 8.00) in the editor,
//      (22.86, 11.75, 19.25) in the game, eleven metres apart. Every
//      verification tool read the composite, so the axe was being checked in a
//      room it had never actually been in. That is why it kept passing.
//   2. THE GIZMO IS NOT THE AXE. pblade2.glb hangs 5.2-6.2m in -z and 2.1-4.8m
//      in -y from its own origin, so the handle you drag in the editor is about
//      5.7m from the blade you are aiming. "I put it back in its last position"
//      and "the blade is where it was" are not the same statement for this
//      model.
//   3. FULL SCALE CANNOT FIT INDOORS. The shrunk sweep is 6.70m tall and the
//      biggest gap between two floor levels in this house is 5.01m (2.64 up to
//      7.65). At scale 1 the arc reaches through both upper slabs and kills
//      people on a storey that cannot see it. Measured on the shipped
//      placements: 8.8% and 16.1% of each arc was inside solid geometry —
//      swinging through walls, which is a phantom kill by definition.
//
// Points 1 and 2 are FIXED by this list existing — one source of truth, in
// git, and no gizmo to misread. Point 3 is a deliberate trade: the authored
// positions below are kept at the level's request even though their arcs do
// pass through walls, and the exact cost is recorded on each entry and in
// ACCEPTED_BURIED in tools/place_axes.py so it stays a decision rather than
// drifting back into a surprise.
//
// CHANGING THESE: edit the numbers here, then run
//     python tools/place_axes.py --check-code
//     python tools/verify_hits.py
// Do not move the axes in Creator Hub. Any entity named pblade2.glb* left in
// the scene is deleted at load (see spawnPlacedAxes in traps/swingTraps.ts) so
// an editor copy cannot come back as a second, unverified axe.

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
// AT THE GRAVES, on request — they should look like they came out of one.
//
// Both were solved for rather than eyeballed: search rings around each
// gravestone for the nearest point where the skeleton's capsule (r 0.45,
// h 1.95) clears every placed model by 0.5m, staying inside YARD_BOUNDS and
// outside HOUSE_RECT/HOUSE_WING_RECTS so a spawn can't land in the building.
//
// That matters here more than anywhere else in this file. This scene's very
// first spawn point was (15, 0, 26), which is INSIDE the back-yard grave row
// (those headstones sit at z 25.75, x 14.5-23.5) — the skeleton spawned
// standing in a gravestone and spent its first seconds shoving against it.
// The obvious-looking picks for THIS change were no better: 1.45m east of the
// west row is 0.32m inside the stones, and the gap south of the north row is
// 0.35m inside KILLERHOUSE_.glb. The stones are much wider than they look.
// The following died with the stab prompt on 2026-08-19 (there is now no way
// to damage a skeleton, so nothing sets hits, knocks one down or respawns it)
// and with the patrol circuit in the 2026-08-19 rewrite:
//   SKELETON_HITS_TO_KILL, SKELETON_STAB_MAX_DISTANCE,
//   SKELETON_STAB_KNOCKBACK, SKELETON_RESPAWN_SECONDS,
//   SKELETON_PATROL_ROUTE, SKELETON_PATROL_BOUNDS

export const SKELETON_SPAWNS: Vector3[] = [
  // THE BACK-YARD GRAVE ROW, on request — a skeleton should climb out of a
  // grave, not appear in open lawn. x values are the four `Grave 04*`
  // headstones read straight out of main.composite (13.25 / 17.00 / 20.00 /
  // 23.50, all at z 28.00).
  //
  // z 29.4 is NORTH of (behind) the headstones, and that side is not
  // decorative — it is the only clear side. The first attempt put these 1.2m
  // SOUTH at z 26.8 and every one of them landed on a blocked cell: the
  // gravestones themselves are dilated into the grid, and x 17 / x 20 sat
  // inside HOUSE_WING_RECTS' north wing (x 15-21.5, z 22.5-27.5) as well.
  // A skeleton whose grave is blocked can never leave it — the every-frame
  // "never stand inside something" rule teleports it home, and home is
  // blocked, so it stands there animating forever. That is exactly the
  // "walks in place" report. Verified free against the baked grid before
  // shipping; re-verify if the graves or the wing ever move.
  Vector3.create(13.25, 0, 29.4),
  Vector3.create(17.0, 0, 29.4),
  Vector3.create(20.0, 0, 29.4),
  Vector3.create(23.5, 0, 29.4)
]

// How often a hunting skeleton recomputes its route, and how far the target
// may drift before it recomputes early. A* over this grid expands at most
// ~1500 nodes of 2907, so this is cheap; the cadence exists to spread the
// cost, not because the search is expensive.
export const SKELETON_REPATH_SECONDS = 0.6
export const SKELETON_REPATH_DISTANCE = 2.0
// Node budget per search. The whole grid is 2907 cells, so this cannot be hit
// by an ordinary route — it is a backstop against a pathological frame.
export const SKELETON_PATH_MAX_NODES = 4000
// How close counts as reaching a waypoint.
export const SKELETON_WAYPOINT_ARRIVE = 0.45


/**
 * How many skeletons are live, by round. Round 1 is the 5-candle introduction
 * and stays a one-skeleton yard; from round 2 (7 candles) there are two.
 *
 * ALL of them are built at init and the extras are just hidden and skipped —
 * spawning entities on a round boundary means creating and destroying a GLTF, a
 * looping AudioSource and a pointer registration every few minutes, which is
 * the kind of churn this scene has already been bitten by. Toggling costs
 * nothing and cannot leak.
 *
 * Adding an entry to SKELETON_SPAWNS is all it takes to raise the ceiling; the
 * count below decides how many of them wake up.
 */
export const SKELETON_COUNT_ROUND1 = 1
export const SKELETON_COUNT_LATER = 2
export const SKELETON_MODEL_Y_OFFSET = 0 // KayKit model origin is at the feet
export const SKELETON_YAW_OFFSET_DEGREES = 0 // set to 180 if they walk backwards
export const SKELETON_WANDER_SPEED = 0.6
/**
 * Chase speed, m/s. Raised again on request (1.4 -> 1.9 -> 2.4).
 *
 * The window this has to sit inside: a Decentraland avatar walks at roughly
 * 2 m/s and runs at roughly 6. Below ~2 the skeleton cannot catch anyone who is
 * paying attention even at a stroll; anywhere near 6 and it is inescapable and
 * the yard stops being playable. At 2.4 it outpaces a walk, closes on anyone
 * who stops to light a candle, and is still comfortably outrun by a sprint —
 * so getting caught reads as a mistake rather than as bad luck.
 */
export const SKELETON_CHASE_SPEED = 2.4
export const SKELETON_TURN_SPEED = 7
// Touching distance = death. Derived the same way every other hazard here is:
// the object's own half-extent plus PLAYER_BODY_RADIUS (0.4), because this test
// compares the player's CENTRE to the skeleton's and so has to carry the
// player's body itself.
//
// Skeleton_Minion.glb is 1.938 x 2.166 x 0.912 at scale 0.9 — but that X figure
// is the BIND POSE, arms straight out, and a skinned mesh's accessor bounds
// always report the bind pose rather than the frame being drawn. A skeleton
// walking at you is about as wide as its torso: 0.912 x 0.9 / 2 = 0.41. So
// 0.41 + 0.4 = 0.81, rounded to 0.9 to leave the attack animation's reach.
//
// WAS 1.2, which is what you get by treating the T-pose arm span as the body —
// roughly 50% past where anything is actually touching you, and one more way to
// die without being able to see why.
// MEASURED AGAIN 2026-08-18, and 0.9 was still too wide at the back.
//
// The bind-pose torso reasoning above is sound but static. Skinning
// Skeleton_Minion.glb through its actual chase clip (Running_A) and sweeping
// the player capsule around it at 72 azimuths gives the radius at which the
// mesh really first touches you, and it is strongly directional:
//     forward (+Z, the way it faces)  1.205    +/-90 (side)  0.95
//     +/-45 off forward               1.02     rear (-Z)     0.658
//     worst azimuth (265 deg)         0.656
// Mobile plays Walking_D instead (ensureAnim returns early there), worst 0.683,
// so sizing to Running_A's 0.656 covers both platforms.
//
// A SINGLE radius cannot be both fair and generous when the real reach varies
// 0.656-1.205 by angle: any value above 0.656 kills someone standing behind it
// with nothing touching them. Taking the worst case and applying the requested
// 95% trim gives 0.656 * 0.95 = 0.62.
//
// THIS IS A REAL NERF — the catch radius drops ~31%, and being caught from
// behind now requires the skeleton to be genuinely on top of you. That is the
// deliberate trade: "no deaths without contact" costs some grabs. If it ends up
// feeling toothless, the honest fix is a DIRECTIONAL test (compare against the
// reach for the skeleton's facing angle) rather than widening this back to a
// number that kills through thin air.
// THE SPAWN AREA IS THE ONE SAFE PLACE, on request. Everywhere else on the
// grounds the skeleton hunts you, at any distance and any height; step back
// into the gateway you spawned in and it breaks off.
//
// Centred on SPAWN_POSITION (27, 0.1, 1) — the gap in the south fence between
// the pillars at x 24.31 and x 30.60. 4.5m covers the gateway and a little of
// the path in without reaching the graves or the front door, so it is a
// refuge you have to deliberately retreat to, not somewhere you can fight
// from. Respawn invulnerability already covers the instant of dying; this
// covers standing there afterwards deciding what to do.
//
// Set to 0 to remove the refuge entirely and let it hunt the whole plot.
export const SKELETON_SAFE_ZONE_CENTRE = Vector3.create(27, 0, 1)
export const SKELETON_SAFE_ZONE_RADIUS = 4.5

export const SKELETON_KILL_RADIUS = 0.62
// Model height at SKELETON_SCALE 0.9, measured off the same skinning pass.
// Used to give the kill an actual vertical extent — see the kill check.
export const SKELETON_BODY_HEIGHT = 1.95
// The avatar capsule's height, feet to top of head. hits.ts keeps its own
// private copy of this for the tests that live there; this one exists for kill
// checks written outside it (the skeleton's, which uses no hits.ts helper).
// Keep the two in step.
export const PLAYER_CAPSULE_HEIGHT = 1.9
export const SKELETON_ATTACK_REST_SECONDS = 2.5 // pause after a successful kill
// The yard: inside the outer iron fence, outside the house footprint.
// minX follows FENCE_LINES.minX (see the note there — the west pillars moved
// east to x 4.25). At the old 1.8 the skeletons' wander/chase area extended
// 2.5m PAST the west fence, so one could walk out of the plot entirely.
export const YARD_BOUNDS = { minX: 5.0, maxX: 30.2, minZ: 1.8, maxZ: 30.2 }
/**
 * The house's MAIN BODY, measured off dh_new.glb's own collider mesh rather
 * than estimated — the collider triangles that sit in the walking band (world
 * y 0.2-2.4), projected onto x/z.
 *
 * WAS { 13.2, 31.2, 8.4, 22.0 } AND WRONG IN EVERY DIRECTION. The real building
 * reaches x 35 and z 27, so the old rectangle fell 3.8m short on the east side
 * and 5m short on the north. Everything that asks "am I in the house?" was
 * answering no while standing inside it: the skeleton walked into the walls,
 * lightning could strike ground that is actually indoors, and the shelter test
 * in playerInStrike would not have counted a player sheltering in the east
 * third of the building.
 *
 * IT IS ONLY THE MAIN BODY. The house is not a rectangle — two wings run north
 * and south of it (HOUSE_WING_RECTS below). A single box around the whole thing
 * would swallow big pieces of open yard on either side of those wings, which is
 * worse than being slightly small: it would make real, walkable ground
 * unreachable to the skeleton and unstrikeable by the storm.
 */
export const HOUSE_RECT = { minX: 14.0, maxX: 35.0, minZ: 8.0, maxZ: 23.0 }
/**
 * The two wings, same measurement pass. Kept separate from HOUSE_RECT because
 * most callers only need a cheap "roughly indoors" test, while anything doing
 * PATHING has to know about these — the south wing is what the skeleton's
 * patrol route was walking straight through.
 *
 * Padded ~0.5m past the collider for a body radius.
 */
export const HOUSE_WING_RECTS = [
  { minX: 15.0, maxX: 21.5, minZ: 3.5, maxZ: 8.5 }, // south wing
  { minX: 15.0, maxX: 21.5, minZ: 22.5, maxZ: 27.5 } // north wing, behind the graves
]

// ---------------------------------------------------------------------------
// LIGHTNING STRIKES — the storm actually hits the ground now, and it kills.
//
// FAIRNESS IS THE WHOLE DESIGN HERE. A bolt that kills the instant it appears
// is the definition of the unfair death the Week 2 feedback says to avoid, so
// the sequence is deliberately telegraphed and always in this order:
//   1. A strike point is chosen OUTSIDE the house and a burning ring is drawn
//      on the ground there, at exactly LIGHTNING_KILL_RADIUS.
//   2. The sky double-flashes.
//   3. THUNDER_AT seconds later (0.9s — see lightning.ts) the bolt lands.
// The ring is on screen for that whole window, it is the true size of the
// lethal area, and 0.9s is comfortably enough to walk out of it. A player who
// dies to this was shown exactly where and given time to move — which is what
// makes it learnable rather than random.
//
// INDOORS IS ALWAYS SAFE. Strike points never land inside HOUSE_RECT, and the
// kill additionally requires the player to be outside it, so standing just
// inside a wall next to a strike can't catch you through the wall. One rule:
// the storm owns the yard, the house owns the traps.
// ---------------------------------------------------------------------------
export const LIGHTNING_STRIKE_ENABLED = true
export const LIGHTNING_KILL_RADIUS = 2.6 // metres from the strike point — same as the warning ring
export const LIGHTNING_HOUSE_MARGIN = 2.0 // keep strike points this far off the house footprint
// THE BOLT IS A FLIPBOOK, baked in Blender — see lightning-source/.
//
// The atlas is LIGHTNING_FLIPBOOK_GRID x GRID frames of a Voronoi
// (4D, Distance to Edge) fork, with a keyframed strike envelope: frame 0 is
// the hit at full brightness, the last frame is gone, with two flickers on the
// way down. The 4th Voronoi axis steps every frame so the fork RESHAPES as it
// flickers instead of just fading — the thing that stops it reading as a
// picture being dimmed.
//
// Played once per strike by stepping the plane's UVs (MeshRenderer.setPlane
// takes them), never looped. Scenes can't author shaders, so a baked atlas is
// how an effect like this reaches Decentraland at all; the same pipeline made
// energyball-source/energyball_flipbook.png.
export const LIGHTNING_FLIPBOOK = 'assets/scene/Textures/lightning_flipbook.png'
export const LIGHTNING_FLIPBOOK_GRID = 4 // atlas is GRID x GRID
export const LIGHTNING_BOLT_HEIGHT = 24 // how tall the bolt quad stands
export const LIGHTNING_BOLT_WIDTH = 7 // quad width — the fork uses most of it
export const LIGHTNING_BOLT_SECONDS = 0.55 // one pass through the atlas
export const LIGHTNING_COLOR = Color3.create(0.72, 0.82, 1.0) // cold storm white-blue
/**
 * How hard the bolt's emissive is driven. This is a COLOUR knob as much as a
 * brightness one, which is not obvious and is why the bolt read as a flat white
 * line however blue its texture was.
 *
 * emissiveIntensity multiplies emissiveColor x emissiveTexture before
 * tonemapping. Any channel landing above 1.0 gets clipped, so once the
 * multiplier is high enough that ALL THREE channels clip, every bolt renders
 * pure white regardless of what colour went in. At 12 the core was
 * (0.46, 0.67, 1.0) x 12 = (5.5, 8.0, 12.0) — nothing survives that.
 *
 * 6 keeps it far brighter than anything else in a night scene while leaving the
 * channels enough headroom for the blue core (see lightning-source/tint_bolt.py)
 * to actually show. If the bolt now reads too dim against the sky, raise this —
 * but expect the blue to wash back out as it climbs, and note the impact light
 * (LIGHTNING_IMPACT_INTENSITY) is what actually lights the yard, not this.
 */
export const LIGHTNING_BOLT_EMISSIVE = 6
export const LIGHTNING_IMPACT_INTENSITY = 9000 // ground flash at the point of impact
export const LIGHTNING_IMPACT_RANGE = 18

// ── THE SPARK WARNING ───────────────────────────────────────────────────────
//
// Ground sparks dance on every spot a bolt is about to hit, for a few seconds
// BEFORE it lands, so the strike can be dodged instead of merely survived.
//
// The old warning was the sky double-flash, and the numbers say why that was
// not enough: the flash fires at strikeClock 0 and the kill test runs at
// THUNDER_AT, which at LIGHTNING_SPEED 1.35 is 0.667 SECONDS later. That is
// reaction time, not decision time — you could not cross the 2.6m kill radius
// in it even if you read the flash perfectly. The sparks are a real telegraph:
// they name the exact spot, they last long enough to walk out of, and the
// strike commits to its points when they appear so walking away always works.
export const LIGHTNING_WARN_SECONDS = 3
/**
 * The spark sprite: a 2x2 atlas of curled electric arcs, white filament in a
 * blue glow, baked by tools/bake_spark_atlas.py.
 *
 * DRAWN, NOT DOWNLOADED, same as ELECTROCUTION_TEXTURE above - a generated
 * texture carries no licence. Re-roll the four shapes with --seed.
 */
export const LIGHTNING_SPARK_TEXTURE = 'assets/scene/Textures/spark_arc.png'
export const LIGHTNING_SPARK_ATLAS_GRID = 2
/** Sparks per bolt. Fewer than the old dots, because each one is now a shape. */
export const LIGHTNING_SPARK_COUNT = 5
/** Scattered across the lethal ring itself, so the warning marks the real danger. */
export const LIGHTNING_SPARK_RADIUS = LIGHTNING_KILL_RADIUS
export const LIGHTNING_SPARK_SIZE = 0.62 // an arc needs room; the old dots were 0.17
/**
 * How far a spark CRAWLS across the ground before it re-seeds, in metres.
 *
 * They used to hop upward, which read as embers rising off a fire. Electricity
 * earthing itself runs along the ground instead - so a spark now lies flat and
 * skitters outward from where it lit.
 */
export const LIGHTNING_SPARK_CRAWL = 1.0
/** Height off the ground plane. Just enough to stay out of the dirt. */
export const LIGHTNING_SPARK_GROUND_Y = 0.05
/** Re-seeds per second, per spark — high enough to crackle, not strobe. */
export const LIGHTNING_SPARK_HZ = 9
export const LIGHTNING_SPARK_EMISSIVE = 8
/** The ground glow under the sparks, ramping in as the strike nears. */
export const LIGHTNING_WARN_LIGHT_INTENSITY = 1400
export const LIGHTNING_WARN_LIGHT_RANGE = 9

/**
 * How fast the whole strike SEQUENCE plays — 1.35 = 35% faster (on request).
 *
 * One multiplier, applied in lightning.ts to every timing inside a strike: the
 * double flash, the delay before the bolt lands, the flipbook, the blackout
 * fade and the settle. Speeding those individually is how a strike ends up out
 * of sync with itself (a bolt still on screen after the flash has finished, or
 * a blackout outlasting the thunder), so they all divide by this one number.
 *
 * NOTE this is the SPEED of a strike, not how OFTEN one happens. Frequency is
 * STRIKE_INTERVAL_MIN/MAX in lightning.ts — lower those to get more storms.
 *
 * There is a floor on how far this can go: the flipbook is 16 frames, so at
 * LIGHTNING_BOLT_SECONDS/1.35 = 0.41s the bolt plays at ~39fps. Past about 2.0
 * it outruns the frame rate and starts skipping cells.
 */
export const LIGHTNING_SPEED = 1.35

/**
 * How many bolts land per strike, each at its own random point (on request).
 *
 * They come down TOGETHER, on one thunderclap. Staggering them would read as
 * two separate storms rather than one strike forking, and it would need the
 * crack, the blackout and the shake to be scheduled per bolt instead of once.
 *
 * This multiplies the danger, not just the spectacle: each bolt carries a full
 * LIGHTNING_KILL_RADIUS, so two of them roughly double the ground a player has
 * to not be standing on. Every entity below scales with it — bolt quads, sky
 * flashes and impact lights are all built per bolt at init.
 */
// 4 on request 2026-08-20, up from 2. Each bolt carries a full
// LIGHTNING_KILL_RADIUS, so this doubles the lethal ground again — the yard is
// meaningfully harder to cross during a storm now. Everything downstream scales
// automatically (bolt quads, sky flashes, impact lights are all built per bolt
// at init, and pickStrikePoint spaces them apart), so this is the only number
// that needs changing.
export const LIGHTNING_BOLT_COUNT = 4
/**
 * Metres apart the strike points of one strike must be.
 *
 * Two bolts landing 3m from each other look like one bad bolt drawn twice, and
 * their kill radii (2.6m each) would merge into a single blob. Comfortably
 * clear of 2x LIGHTNING_KILL_RADIUS so the lethal ground stays two rings.
 */
/**
 * THE SKY AIMS AT YOU. On request: strike points were pure random over the
 * yard, which made lightning weather rather than a threat — you could stand
 * still for an entire round and never be hit.
 *
 * LIGHTNING_HUNT_BOLTS of the volley now lead your movement: the target is
 * where you WILL be when the bolt lands, not where you are when it is chosen.
 * The rest stay random, which is the part that keeps this survivable — four
 * homing bolts every nine seconds is not a game, it is a countdown. One
 * tracking bolt plus scatter means dodging is a decision, and the house is
 * still absolute shelter.
 *
 * LEAD_MAX caps how far ahead it will aim. playerVelocity is a raw one-frame
 * delta, so a single hitched frame can report an enormous speed; without the
 * cap that one frame throws the bolt clear across the yard and the strike is
 * wasted somewhere nobody is standing.
 */
export const LIGHTNING_HUNT_ENABLED = true
export const LIGHTNING_HUNT_BOLTS = 1
export const LIGHTNING_LEAD_MAX = 7 // metres of lead, against velocity spikes

export const LIGHTNING_MIN_SEPARATION = 8

/**
 * Seconds between strikes — the storm's frequency, quite separate from
 * LIGHTNING_SPEED, which is how fast one strike plays out.
 *
 * Averages 35s (on request, down from a 30-75s band that averaged nearly a
 * minute). Kept as a RANGE rather than a flat 35 so the storm can't be counted
 * on: a metronome stops being weather, and a player who can time it just walks
 * indoors on the beat.
 */
// TWICE AS OFTEN, on request: halved from 28-42s. The storm is the scene's
// only ambient pressure, and one strike every ~35s left long dead stretches.
// THE QUIET between strikes, on request — from one strike settling to the next
// one's sparks lighting. NOT the strike-to-strike period: the sequence itself
// (LIGHTNING_WARN_SECONDS of sparks plus the settle) sits on top, so the storm
// actually goes off every 20s at this setting.
//
// This was briefly defined as the period instead, so that lengthening the spark
// warning would not silently slow the storm. Reverted on request: the quiet is
// the part you feel as a player — how long you get to breathe — and it is the
// number worth being able to set directly.
//
// SET FOR A 20-SECOND FULL PERIOD, on request. Because this is the quiet and
// not the period, that is a derived number rather than a typed one:
//
//   period = INTERVAL + LIGHTNING_WARN_SECONDS + STRIKE_SETTLE
//          = INTERVAL + 3 + 2.2 / LIGHTNING_SPEED
//          = INTERVAL + 3 + 1.630
//
// so 20 - 4.630 = 15.370. The phases are strictly sequential — lightning.ts's
// warning branch returns before the countdown is touched — so that sum is exact
// rather than approximate.
//
// RE-DERIVE THIS if LIGHTNING_WARN_SECONDS or LIGHTNING_SPEED ever move. Both
// are inside the period, so either one changes the storm's rhythm while this
// number sits here looking untouched, which is the whole trap the "define it as
// the period" attempt above was trying to avoid.
//
// Set them equal for a metronome, apart for a storm that wanders.
export const LIGHTNING_STRIKE_INTERVAL_MIN = 15.37
export const LIGHTNING_STRIKE_INTERVAL_MAX = 15.37

// THE STRIKE FLASH — a white-blue wash over the screen at the crack, on top of
// the existing blackout. The blackout alone reads as the lights failing; this
// reads as the bolt itself. Half a second, fading out, so it punctuates rather
// than blinds. Colour is a cold electric blue-white, not pure white.
export const LIGHTNING_FLASH_SECONDS = 0.5
export const LIGHTNING_FLASH_PEAK = 0.72
export const LIGHTNING_FLASH_COLOR = { r: 0.78, g: 0.87, b: 1.0 }

// The three walkable planes in this scene, HIGHEST FIRST — the upper floor,
// the interior ground floor (the plane the carpet at (19.25, 2.58, 17.75)
// sits on), and the yard. Used to drop a blood stain onto the floor under a
// death instead of leaving it hanging at the height the player died at; see
// floorBeneath() in effects/deathEffects.ts.
//
// These are snapped to, not raycast for, on purpose. This project has one
// confirmed mobile freeze caused by raycasts and a documented history of
// DCL's collision layers not reporting what they should (which is why candle
// placement moved to offline Blender verification) — and the floor heights
// here are three fixed numbers that are already hardcoded throughout this
// file anyway (CANDLE_POOL, the y≈2.58
// torso-height note on the wall spikes). A lookup is exact, costs nothing,
// and behaves identically on every device.
// Re-measured against dh_new.glb (the replacement house) by histogramming
// horizontal faces in its house_collider mesh: the ground-floor slab's top
// face is the single largest walkable surface at y 2.64 (144 m2), the upper
// floor at y 8.58, and there is a NEW ~48 m2 mezzanine at y 7.65 sitting
// directly over the chandelier lift's shaft — the lift's landing.
//
// Everything moved up ~5.4cm versus the old house purely because the entity
// position did (11.6738 -> 11.7279); the planes are unchanged in model space.
export const YARD_FLOOR_Y = 0
export const FLOOR_LEVELS_Y = [8.58, 7.65, 2.64, YARD_FLOOR_Y]
// How far BELOW a floor a position can be and still count as standing on it.
// Covers avatars sinking slightly into the floor and float noise in the
// reported player Y; small enough that it can't grab a floor you're properly
// beneath.
export const FLOOR_SNAP_TOLERANCE = 0.35
// Wander/patrol is restricted to the back yard only (on request) — entirely
// above the house's maxZ (22.0), so it can never overlap the house footprint
// and doesn't need its own insideHouse rejection check. Pulled in from
// YARD_BOUNDS' outer edges (fence line, corners) so a random wander target
// doesn't land right against the fence or a pillar — chasing a player is
// NOT restricted to this box, only idle wandering is.

/**
 * THE GRAVEYARD PATROL — a fixed circuit the skeleton walks when it isn't
 * chasing anyone. It replaces random wander targets entirely.
 *
 * Random targets inside SKELETON_PATROL_BOUNDS were the direct cause of "the
 * skeleton walks into colliders": that box is x 4-27, z 23-29, and the back-yard
 * grave row sits at z 25.75 across x 14.5-23.5 — squarely inside it. Roughly a
 * fifth of every target drawn was a point inside a gravestone, and the only
 * thing standing between the skeleton and walking into one was three feeler
 * raycasts that DON'T EXIST ON MOBILE (see registerFeelers). The box also
 * reached x=4, which is 1m outside the west fence line.
 *
 * A hand-authored route fixes that at the source instead of reacting to it: the
 * legs are laid through ground that is verifiably empty, so there is nothing to
 * collide with and nothing to steer around.
 *
 * THE FIRST VERSION OF THIS ROUTE WAS ALSO WRONG, and for a worse reason. Its
 * front leg ran west along z 24.0 — checked against HOUSE_RECT, which said the
 * house stopped at z 22.0, so it read as clear. The house actually reaches
 * z 27, and the leg was blocked by the north wing for 5.5m of its 12.6m run.
 * The skeleton walked into that wall every lap. Verifying against a rectangle
 * that is itself a guess is not verifying.
 *
 * These legs are checked against the house's OWN COLLIDER MESH, sampled every
 * 5cm — dh_new.glb's collider triangles in the walking band, projected to x/z —
 * plus the grave rectangles, the pillars and the yard bounds. Tightest
 * clearance to anything solid anywhere on the circuit is 1.00m, against a
 * skeleton body radius of ~0.45m.
 *
 * It runs along the back of the plot, drops down the east side into the open
 * ground beyond the last gravestone, and returns — keeping the graveyard on its
 * flank the whole way, which is what "roam to where the graves are" asks for.
 *
 * A loop rather than a there-and-back: ping-ponging a straight line makes it
 * pivot 180° at each end, which looks like a bug. Order matters — consecutive
 * entries are walked as straight lines, so any two adjacent points must have
 * clear ground between them. Re-verify against the collider, not against
 * HOUSE_RECT, if these ever move.
 */
/**
 * Seconds of no real progress before the skeleton gives up on where it is
 * going. "No progress" means it tried to move and the collision slide ate
 * nearly all of it — not that something is merely in front of it.
 */
export const SKELETON_STUCK_SECONDS = 1.2
/**
 * The failsafe. If it is STILL making no progress this long after rerouting,
 * it gets placed on the nearest patrol node outright.
 *
 * A visible snap is ugly; a skeleton frozen against a wall for the rest of the
 * round is worse, and every previous attempt to fix this by cleverer steering
 * has left some corner where it wedges. This cannot fail to recover, which is
 * the property that actually matters.
 */
export const SKELETON_UNSTICK_SECONDS = 4.0
/**
 * Headings the skeleton will try, in degrees off the direct line to its goal,
 * when the direct step is blocked. First clear one wins, so it always prefers
 * the straightest option and only swings wide when it must.
 *
 * This is "turn left or right instead of grinding", done with arithmetic
 * against the same rectangles everything else uses rather than with raycasts.
 * The raycast version could deadlock — blocked meant don't move, not moving
 * meant not turning, so the ray never left the wall. A fan cannot: either some
 * heading is clear and it moves, or none is and the unstick timer takes over.
 *
 * Stops at 80 deg. Past 90 it would be walking away from its goal, which the
 * stuck timer handles better than steering does.
 */
export const SKELETON_DETOUR_FAN = [0, 30, -30, 55, -55, 80, -80]
// SKELETON_STALK_ARRIVE was removed on 2026-08-19 with the 'stalk' state it
// served — the rewritten skeleton hunts instead of posting up on a circuit.

/**
 * Ground the skeleton must not walk into, as axis-aligned x/z rectangles.
 *
 * This is the general fix for walking through colliders, and it covers the case
 * the patrol route can't: a CHASE goes wherever the player goes, so it can't be
 * routed around anything in advance.
 *
 * Why rectangles and not the physics colliders themselves: the skeleton has no
 * rigid body. Its Transform is written directly every frame, so scene colliders
 * do not push back on it at all — the only collision awareness it ever had was
 * three feeler raycasts, and those are disabled on mobile, where the whole
 * animator/raycast path is parked (see the header in enemies/skeletons.ts).
 * Rectangles are plain arithmetic, so they work identically on every device.
 *
 * Every entry below is MEASURED, not eyeballed: GLB accessor min/max multiplied
 * by the instance's scale, rotated by its yaw, offset to its position in
 * main.composite, then padded by ~0.55m for the skeleton's own body. The four
 * west-side blocks are kept separate rather than merged into one strip so the
 * 4.7m gaps between those graves stay walkable — merging them would wall off
 * the entire west side of the yard and make a player standing there unreachable.
 *
 * Re-measure if the graves are moved. Nothing derives these at runtime.
 */
/**
 * WHERE THE SKELETON MAY NOT WALK — a baked occupancy grid of the yard.
 *
 * The skeleton is moved by code, not physics, so blockedAt() in
 * enemies/skeletons.ts is the ONLY thing that stops it. Anything missing here
 * is something it walks straight through, which is exactly what was happening:
 * this used to be six hand-authored rectangles covering the gravestones and
 * nothing else, so every pillar, crate and porch in the yard was invisible to
 * it.
 *
 * WHY A GRID AND NOT MORE RECTANGLES. The dominant obstacle out here is
 * KILLERHOUSE_.glb, a shell whose bounding box is 355 m2 of mostly-open space;
 * one rectangle for it would wall off the entire yard, and no small set of
 * rectangles describes a building with porches and pillars honestly. A grid
 * also makes blockedAt O(1) instead of O(rects), which matters because it runs
 * seven times per skeleton per frame for the detour fan.
 *
 * HOW IT WAS BUILT: every placed model's collider triangles rasterised at 25cm
 * in the band a walking skeleton sweeps (y 0.15-1.95), dilated by its 0.45m
 * body radius — blockedAt tests a centre point, so obstacles have to be grown
 * by its width — then folded onto 0.5m cells. 14 models contribute; 72% of the
 * yard box stays walkable.
 *
 * VERIFIED: all five SKELETON_PATROL_ROUTE nodes and both SKELETON_SPAWNS land
 * on free cells and are mutually reachable by flood fill, and all five patrol
 * legs sweep clear at 0.1m steps. Re-run scratchpad/skeleton_grid.py if the
 * scene's props move — this is a snapshot of the CURRENT composite, not
 * something the code re-derives at runtime.
 *
 * Row j covers z = ORIGIN_Z + j*CELL, character i covers x = ORIGIN_X + i*CELL.
 * '1' = blocked. Outside the grid, the house rects and YARD_BOUNDS take over.
 */
export const SKELETON_GRID_ORIGIN_X = 5.0
export const SKELETON_GRID_ORIGIN_Z = 1.8
export const SKELETON_GRID_CELL = 0.5
// Regenerated from the LIVE scene (tools/_skeleton_grid_probe.py, a portable
// copy of the original bake tool), not hand-kept in sync. The previous bake
// pre-dated Grave 31_3's current rotation (7.75, 0, 23.25, yaw 90) and left 6
// cells around it marked walkable that are really inside the grave — the
// skeleton walked through it. Regenerate the same way after moving any prop.
export const SKELETON_BLOCKED_GRID: string[] = [
  '000000000000000000000000000000000000000000000000011',
  '000000000000000000000000000000000000000000000000001',
  '000000000000000000000000000000000000000000000000000',
  '000000000000000000000000000000000000000000000000000',
  '000000000000000000000010000000110000000000000000000',
  '000000000000000111000111111001111110000000000000000',
  '000000000000001111100111111101111111000000000000000',
  '000000000000001111101111111101111111000000000000000',
  '000000000000000111001111111001111110000000000000000',
  '000000000000000000001111111111111000000000000000000',
  '000000000000000000001111111111111000000000000000000',
  '000000000000000000011111111111111111111111111100000',
  '110000000000000000111111111111111111111111111111111',
  '111000000000000000111111111111111111111111111111111',
  '111000000000000000111000000000000000000000000111111',
  '111000000000000000111000000000000000000000000000000',
  '110000000000000000111000000000000000000000000000000',
  '000000000000000000111000000000000000000000000000000',
  '000000000000000000111000000000000000000000000000000',
  '000000000000000000111000000000000000000000000000000',
  '000000000000000000111000000000000000000000000000000',
  '000000000000000000111000000000000000000000000000000',
  '111000000000000000111000000011111111111111111111111',
  '111000000000000000111000000111111111111111111111111',
  '111000000000000000111000000111111111111111111111111',
  '111000000000000000111000000111000000000000000000000',
  '000000000000000000111000000111000000000000000000000',
  '000000000000000000111000000111000000000000000000000',
  '000000000000000000111000000111000000000000000000000',
  '000000000000000000111000000111000000000000000000000',
  '000000000000000000111000000111000000000000000000000',
  '010000000000000000111000000111000000000000000000000',
  '111000000000000000111000000111000000000000000000000',
  '111000000000000000111000000111000000000000000000000',
  '111000000000000000111000000111000000000000000000000',
  '010000000000000001110000000111000000000000000000000',
  '000000000000000001110000000111000000000000000000000',
  '000000000000000001110000000111000000000000000000000',
  '000000000000000001110000000111000000000000000000000',
  '000000000000000001110000000111000000000000000000000',
  '000000000000000001110000000111000000000000000000000',
  '011100000000000001111111111111111111111111111111111',
  '011100000000000001111111111111111111111111111111111',
  '011100000000000000111111111111111111111111111111111',
  '011100000000000000011111111111111111111111111111111',
  '000000000000000000001111111111111000000000000000000',
  '000000000000000000001111100011111000000000000000000',
  '000000000000000000001111000001111000000000000000000',
  '000000000000000000001111000001111000000000000000000',
  '000000000000000000001111000001110000000000000000000',
  '000000000000000111000111110011110001111000000000000',
  '000000000000001111100111111111111011111100000000000',
  '000000000000001111100111111111111011111100000000000',
  '000000000000001111100011110011110001111000000000000',
  '000000000000000000000000000000000000000000000000000',
  '000000000000000000000000000000000000000000000000000',
  '000000000000000000000000000000000000000000000000000',
]

/**
 * HOW HIGH THE WALKABLE GROUND IS, cell by cell — same grid as
 * SKELETON_BLOCKED_GRID above, same origin and cell size.
 *
 * WHY THIS EXISTS. The skeleton used to be pinned to y=0 forever
 * (SKELETON_MODEL_Y_OFFSET was written into every position it took), while the
 * blocked grid measured obstacles in an ABSOLUTE world band. On the yard's
 * stone steps that contradiction is the "skeleton walks through the collider"
 * bug: the grid called the steps a wall, and the movement code walked it
 * through them at ground level anyway. Now it rides this instead.
 *
 * ENCODING: one character per cell, ALPHABET.indexOf(char) * 0.125 metres.
 * A plain number array would be ~2900 entries; this keeps it to 57 short rows
 * and, because the alphabet excludes quote and backslash, a row can never
 * break the string literal it lives in.
 *
 * BAKED, NOT WRITTEN — regenerate with tools/bake_skeleton_grid.py, which
 * derives ground as THE LOWEST SURFACE WITH HEADROOM rather than the highest
 * surface below some ceiling. That distinction matters and was got wrong
 * twice: "highest surface" makes the top of every gravestone read as a
 * terrace, and flood-filling heights into empty cells spread those bogus
 * heights across open grass (a direct geometry probe showed all five patrol
 * nodes sit on bare y=0 ground while that bake claimed 1.74-2.57m for them).
 * Surfaces you could stand on but could never CLIMB onto are marked blocked
 * instead, so a gravestone stays an obstacle rather than becoming a platform.
 */
// Fingerprint of the scene these grids were baked from — main.composite plus
// the size of every .glb it references. A stale grid DOES NOT LOOK BROKEN: the
// skeleton simply walks through whatever moved, which is indistinguishable
// from a pathing bug and is why this project chased "walks through colliders"
// more than once. `python tools/check_nav_grid.py` fails if the live scene no
// longer matches this; re-bake with tools/bake_skeleton_grid.py and re-splice.
// SKELETON_GRID_SOURCE_HASH = 'fc45f2b373d79d7d'

export const SKELETON_GROUND_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz+-'
export const SKELETON_GROUND_STEP = 0.125
export const SKELETON_GROUND_GRID: string[] = [
  '00000000000000000000000000000000000000000000000000J',
  '000000000000000000000000000000000000000000000000000',
  '000000000000000000000000000000000000000000000000000',
  '000000000000000000000000000000000000000000000000000',
  '000000000000000000000000000000000000000000000000000',
  '000000000000000000000464000000660000000000000000000',
  '000000000000000BCC000464CCC000AACCC0000000000000000',
  '000000000000000BCC000ABACCC333CCCCC0000000000000000',
  '000000000000000000000EEE666666FF0000000000000000000',
  '000000000000000000000E0EAAAAAAHF0000000000000000000',
  '000000000000000000000I0IEEEEEELJ0000000000000000000',
  '000000000000000000000I0I000000LJ0000000000000000000',
  '0000000000000000000IIIIIIIIIIIIJIIIIIIIIIIIIII00000',
  'DD00000000000000000I0000000000000000000000000IIIIII',
  'DF00000000000000000I0000000000000000000000000000000',
  'DD00000000000000000I0000000000000000000000000000000',
  '0000000000000000000I0000000000000000000000000000000',
  '0000000000000000000I0000000000000000000000000000000',
  '0000000000000000000I0000000000000000000000000000000',
  '0000000000000000000I0000000000000000000000000000000',
  '0000000000000000000I0000000000000000000000000000000',
  '0000000000000000000I0000000000000000000000000000000',
  '0000000000000000000I0000000000000000000000000000000',
  '0D00000000000000000I00000000KKKKKKKKKIIIIKKKKKKKKKI',
  '0D00000000000000000I00000000K0000000000000000000000',
  '0000000000000000000I00000000J0000000000000000000000',
  '0000000000000000000I00000000J0000000000000000000000',
  '0000000000000000000I00000000J0000000000000000000000',
  '0000000000000000000I00000000J0000000000000000000000',
  '0000000000000000000I00000000J0000000000000000000000',
  '0000000000000000000I0000000000000000000000000000000',
  '0000000000000000000I0000000000000000000000000000000',
  '0D00000000000000000I0000000000000000000000000000000',
  '0D00000000000000000I0000000000000000000000000000000',
  '0D00000000000000000I0000000000000000000000000000000',
  '000000000000000000I00000000000000000000000000000000',
  '000000000000000000I000000000J0000000000000000000000',
  '000000000000000000I000000000J0000000000000000000000',
  '000000000000000000I000000000J0000000000000000000000',
  '000000000000000000I000000000J0000000000000000000000',
  '000000000000000000I000000000I0000000000000000000000',
  '000000000000000000I000000000I0000000000000000000000',
  '00D000000000000000IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII',
  '00D0000000000000000IKKKIIIIIIIIIIIIIIIIIIIIIKIIIIII',
  '000000000000000000000JJEEEEEEEII0000000000000000000',
  '000000000000000000000FFBBBBBBBEE0000000000000000000',
  '000000000000000000000FF8888888EE0000000000000000000',
  '000000000000000000000CC5555555BA0000000000000000000',
  '000000000000000000000AA1111111AA0000000000000000000',
  '000000000000000000000660000000640000000000000000000',
  '000000000000000000000440000000000000000000000000000',
  '000000000000000CCC0000CCCC00CCCC000CCCC000000000000',
  '000000000000000EEE0000CEEC00CEEC000CEEC000000000000',
  '000000000000000000000000000000000000000000000000000',
  '000000000000000000000000000000000000000000000000000',
  '000000000000000000000000000000000000000000000000000',
  '000000000000000000000000000000000000000000000000000',
]

// Tallest single step the skeleton may climb, metres. Must match MAX_STEP in
// tools/bake_skeleton_grid.py — the bake uses it to decide which raised
// surfaces are reachable floor and which are obstacle tops, so the two
// drifting apart would let the skeleton try to walk up something the grid
// already decided was a wall.
export const SKELETON_MAX_STEP = 0.6
// YARD_MAX_Y (3.0) was removed on 2026-08-18. It gated posInYard() in
// enemies/skeletons.ts — a player above it stopped counting as being in the
// yard — and it was the reason the skeleton "just stood there doing nothing":
// stepping onto the porch, the stone steps or the fence made you invisible to
// it, so it dropped out of chase and went back to patrolling. Height is no
// longer a defence. Being INDOORS still is, and that is an x/z test
// (insideBuilding) which already covers upstairs and the roof, so nothing
// needed a height ceiling to begin with.

// ---------------------------------------------------------------------------
// OUTER FENCE TIPS — landing on top of the perimeter iron fence is lethal.
// The four kill lines follow the fence rectangle around the plot; you only
// die if your feet are up at tip height (jumping/climbing onto it), never
// from walking beside it on the ground.
// ---------------------------------------------------------------------------
// Fence planes, read off the yard pillars' current positions in the composite.
//
// minX WAS 0.9 and is now 4.25: the west pillars were moved east (pilar.glb_2,
// _6 and _7 all sit at x 4.25 now, _4 at 4.5). Left at 0.9 this trap guarded
// an empty line 3.35m west of the actual fence — lethal air on one side,
// climbable spikes with no hitbox on the other. Re-check these four numbers
// any time the gate or fence is moved; nothing derives them at runtime.
export const FENCE_LINES = { minX: 4.25, maxX: 31.1, minZ: 0.75, maxZ: 31.0 }
// HOW CLOSE (horizontally) TO A FENCE LINE COUNTS AS "ON IT".
//
// 0.75, up from 0.35. This MUST exceed how close a player can physically get,
// or the trap is unreachable and simply never fires:
//
//   player capsule radius            0.400 m
//   fence half-thickness             0.117 m   (model z span 0.233)
//   closest a player centre can get  0.517 m
//
// The iron fence is solid (invisibleMeshesCollisionMask = CL_PHYSICS), so the
// collider holds you 0.517m out while the old 0.35m kill zone sat INSIDE that.
// Reported from play three times as "the fence isn't killing the player", and
// it was right: the condition was unsatisfiable.
//
// 0.55, tightened from 0.75 on request ("the pink hit boxes are too big,
// reduce it to the actual mesh"). 0.517 is a HARD FLOOR — below it the collider
// holds the player outside the kill zone and the trap becomes unreachable
// again, which is the bug that took three passes to find. 0.55 leaves 33mm of
// slack for a player pressed in at an angle against a corner post, and is as
// close to the 0.117m mesh half-thickness as a solid fence physically allows.
export const FENCE_TIP_MARGIN = 0.55

// THE GATE — the gap in the south fence the player spawns in and walks
// through. Read off the pillars either side of it: pilar.glb_3 at x 24.31 and
// pilar at x 30.60.
//
// It MUST be cut out of the fence-tip trap. SPAWN_POSITION is (27, 0.1, 1),
// which sits 0.25m from the south fence line — inside FENCE_TIP_MARGIN. With
// the tips lethal at any height (see FENCE_TIP_Y_MAX), simply JUMPING on the
// spawn point counted as landing on the fence and killed the player with
// "Impaled on the iron fence". Reported live, and entirely self-inflicted by
// removing the old 2.9 ceiling without carving out the doorway first.
//
// Being non-lethal does NOT make the gate a way out: plotBoundary.ts still
// pushes the player back at the gate, and now does so at ANY height, which is
// what stops a running jump from clearing the seal entirely.
export const FENCE_GATE_MIN_X = 23.9
export const FENCE_GATE_MAX_X = 31.0

// SEALED PLOT — the grounds are shut until the ritual is finished, so the
// player can't wander off the plot with candles still unlit (see
// plotBoundary.ts). Derived from FENCE_LINES, so moving the gate moves this
// too and there's nothing separate to keep in sync.
//
// MARGIN MUST STAY 0, and the reason is worth writing down: SPAWN_POSITION
// (27, 0.1, 1) sits IN the gateway — 0.25m inside the south fence line, in
// the gap between the pillars at (24.31, 0, 1.0) and (30.60, 0, 1.5). Any
// inward margin above 0.25 puts the spawn point on the wrong side of the
// player's own seal, so every spawn and every respawn would shove them
// forwards before they'd taken a step. Pull the wall inwards only if the
// spawn moves inwards with it.
export const PLOT_SEAL_MARGIN = 0
// How far back inside they're placed — comfortably more than the distance
// that triggered the push, so the very next frame can't re-trigger it and
// stutter the player in place.
export const PLOT_SEAL_PUSH_IN = 0.9
// Seals at EVERY height a player can reach in the yard.
//
// This was 1.6, to keep the seal from fighting the fence-tip trap over
// somebody standing on the railings. It let a running jump sail straight over
// the boundary and out of the scene — reported live. The two systems no longer
// need separating by height: the tips own the fence LINE (and are lethal at
// any height on it), while the seal owns everything past the boundary
// RECTANGLE, and a player pushed back inside is by definition no longer on the
// line. 30 is above the roof and well under the parcel height cap.
export const PLOT_SEAL_MAX_Y = 30
export const PLOT_SEAL_TOAST_COOLDOWN = 6 // seconds between "gate is sealed" toasts

// ---------------------------------------------------------------------------
// FORCE FIELD HIT — the flare where a player runs into the sealed boundary.
// See effects/forceField.ts for why the panel lies IN the wall plane rather
// than facing the camera.
// ---------------------------------------------------------------------------
export const FORCE_FIELD_ENABLED = true
export const FORCE_FIELD_TEXTURE = 'assets/scene/Textures/forcefield_hit.png'
/**
 * DARK IS DONE WITH ALBEDO, NOT EMISSION — the important bit, because it is
 * counter-intuitive and the request was to make this darker.
 *
 * Emission only ever ADDS light. There is no such thing as a black emissive:
 * turning an emissive colour toward black does not darken the surface, it just
 * makes it emit less, and at pure black it emits nothing and the panel is
 * invisible. Chasing "darker" on emissiveColor alone dead-ends at nothing on
 * screen.
 *
 * So the panel now has an ALBEDO too. With MTM_ALPHA_BLEND the albedo is what
 * blends over the background, so a near-black albedo makes the lattice actually
 * subtract from what is behind it — a shadow in the shape of the barrier, which
 * is what "dark" means here. FORCE_FIELD_COLOR is left as the faint glow that
 * keeps it from disappearing entirely against a night sky.
 *
 * (Hue history: this was spectral green first, deliberately avoiding VEIL —
 * bright violet means "the way out is open" and appears nowhere else in a run.
 * Dark purple dodges that collision anyway, since the boundary is only sealed
 * BEFORE the portal exists and opens the instant it appears, so the two can
 * never be on screen together.)
 */
export const FORCE_FIELD_COLOR = Color3.create(0.13, 0.04, 0.22)
/**
 * What the panel blends over the background with — near-black, faintly violet.
 * Alpha comes from the texture and the fade, not from here; the .a set at the
 * use site is the flare's own dissolve.
 */
export const FORCE_FIELD_ALBEDO = Color3.create(0.02, 0.008, 0.035)
export const FORCE_FIELD_SECONDS = 0.55 // whole flare, contact to gone
/**
 * Metres across at full expansion — doubled from 4, on request.
 *
 * This is world scale on the quad, not a texture change: MeshRenderer.setPlane
 * builds a 1x1 plane, so the number IS the size in metres. The web sprite is
 * untouched.
 *
 * Two consequences worth knowing at 8m, neither of them a problem:
 *   - The panel is centred on the contact point at chest height, so its lower
 *     half now reaches below ground. The terrain occludes it, which leaves the
 *     web looking anchored to the floor with the hub still at the height the
 *     player actually walked into — the reading that matters.
 *   - It stands ~4m over a fence that is only 3m tall. That is honest rather
 *     than wrong: the seal really does hold at every height up to
 *     PLOT_SEAL_MAX_Y, so a barrier taller than the railings is what is
 *     actually there.
 */
export const FORCE_FIELD_SIZE = 8.0
export const FORCE_FIELD_START_SCALE = 0.45 // fraction of SIZE at the instant of contact
/**
 * Low on purpose. emissiveIntensity multiplies the colour before tonemapping
 * and every channel above 1.0 clips, so driving a dark hue hard just turns it
 * pale — the same trap LIGHTNING_BOLT_EMISSIVE fell into. At 1.3 the channels
 * land near (0.17, 0.05, 0.29): a faint violet sheen on the lattice edges,
 * enough that the shape does not vanish against a night sky, nowhere near
 * enough to read as a glow.
 *
 * Raise this and it stops being dark. The dark comes from FORCE_FIELD_ALBEDO.
 */
export const FORCE_FIELD_EMISSIVE = 1.3
// Deliberately small now. A dark barrier that floodlights the yard when it is
// struck contradicts itself, so this is no longer trying to light anything —
// it exists only to put a faint violet bloom right at the contact point so the
// hit registers in peripheral vision. Range pulled in to match: it should not
// reach the fence, only the metre or so around the impact.
export const FORCE_FIELD_LIGHT_INTENSITY = 700
export const FORCE_FIELD_LIGHT_RANGE = 3.5
// Minimum seconds between flares. Someone walking into the boundary and
// holding forward triggers the seal on EVERY frame; without this the flare
// would restart 30-60 times a second and never actually play.
export const FORCE_FIELD_COOLDOWN = 0.6
// The barrier impact, played at the point of contact (not global — it should
// come from the bit of wall you walked into). The clip is 0.85s: the smack and
// zap land inside FORCE_FIELD_SECONDS' 0.55s flare and the field's hum rings
// on a little past it, which is how an impact actually behaves. Slightly under
// full volume so a player pinballing along the boundary isn't shouted at.
// MASTER VOLUME — one multiplier over every sound the scene plays.
//
// 1.2 on request 2026-08-20: everything 20% louder. Applied in sounds.ts at the
// single point where an AudioSource is created, so it covers the per-sound
// constants below AND the volumes passed inline at call sites — of which there
// are plenty (playSoundAt(..., 1.1), heartbeat, ambient). Scaling those by hand
// would have missed some and drifted apart the moment anyone added a sound.
//
// Clamped to 1.0 per source when applied: DCL treats volume above 1 as 1, so
// values over that silently do nothing rather than getting louder. Anything
// already at 1.0 (the plank impact) is therefore unchanged by this — to make
// the mix louder overall, lower the loud ones rather than raising the rest.
export const MASTER_VOLUME = 1.2

export const FORCE_FIELD_SOUND_VOLUME = 0.85
// THE HEIGHT BAND THE FENCE KILLS IN — the player's FEET must be inside it.
//
// Was 1.90..3.20 and effectively never fired. Measured 2026-08-20: the fence
// model is 3.38m tall, so at scale 1.0 on the ground its tips are at 3.03m —
// you had to be standing ON TOP of a 3m fence for your feet to enter the band.
// Worse, the two scaled-1.2 fences at y 1.07 have tips at 4.70m, entirely
// ABOVE the old ceiling, so those could never kill at any height.
//
// Reported from play, twice: "the outer wall fence aren't killing the player".
//
// Now 0.0..4.8: the spikes are lethal on contact at any height up to the
// tallest fence's tips. The gateway cut-out (FENCE_GATE_MIN_X/MAX_X) is what
// keeps the spawn point survivable — the player spawns 0.25m from the south
// line, well inside FENCE_TIP_MARGIN.
export const FENCE_TIP_Y_MIN = 0.0 // ground level: touching the spikes kills
// JUST ABOVE THE REAL FENCE. Measured, not guessed: pilar.glb's collider tops
// out at y 2.603 and HWN20_IronfFence_04's at y 3.028, and those two models are
// the entire perimeter. 3.2 clears the taller of them by 17cm.
//
// THIS WAS 40, and that was a mistake I made — 13x the height of the thing it
// was guarding, i.e. 37 metres of lethal empty sky over every fence line. The
// reasoning at the time was that 2.9 handed players a free escape (a double
// jump clears it, so you sailed over the kill band and walked out on top of the
// fence) and that "there is nothing legitimately above a fence line at any
// height". Both halves were wrong:
//
//   - The escape is not this trap's job any more. plotBoundary.ts seals the
//     plot at EVERY height up to PLOT_SEAL_MAX_Y (30) by pushing the player
//     back, and it acts on dead players too. Nobody leaves over the top now
//     whatever this number is, so it can go back to guarding actual spikes.
//   - "Nothing is legitimately above a fence line" was false. HOUSE_RECT
//     reaches x 31.2 and the east fence line is at x 31.1, so a 0.45m x 13.6m
//     strip of the house INTERIOR sat inside the kill band — on three floors
//     (2.64, 7.65, 8.58). Standing indoors near the east wall killed you with
//     "Impaled on the iron fence". That is fixed properly in fenceTips.ts by
//     excluding the house footprint; lowering this alone would still have left
//     the 2.64 floor lethal.
//
// This is the AIRBORNE half of keeping players in. The ground-level half is
// plotBoundary.ts, which pushes you back rather than killing you.
// 3.2: the real top of a standard fence (model 3.376 tall at scale 1.0 on the
// ground = tips at 3.03m) plus a little. Was 4.8 to cover the two scaled-1.2
// fences whose tips reach 4.70m — those still kill, just along their body
// rather than at their very tips, and 4.8 made the volume a storey and a half
// tall everywhere else for the sake of two posts.
export const FENCE_TIP_Y_MAX = 3.2

// ---------------------------------------------------------------------------
// TRAP 6 — CHANDELIER ELEVATOR CRUSH
// Uses YOUR existing chandelier elevator (the "Vertical Red Pad" smart item
// with the chandelift model, riding y 3.18 <-> 13.18 on a 7s loop). No new
// chandelier is spawned. If the descending chandelier's bottom hits a player
// standing under it, they die. Riding on top stays safe.
// ---------------------------------------------------------------------------
export const CHANDELIER_ENTITY_NAME = 'Vertical Red Pad' // the elevator entity's name in Creator Hub
// Both measured off chandelift.glb rather than tuned by eye. Raw model bounds
// are min (-1.4087, -0.8758, -1.4130) / max (1.4413, 0.6307, 1.4370); the
// entity is placed at scale 0.7, giving a body ~1.99m across (radius ~1.0)
// whose lowest point sits 0.613m below its own pivot.
//
// BOTTOM_OFFSET was -0.5, i.e. the code believed the underside was 11cm
// higher than it is drawn, so the crush registered fractionally after the
// visible bottom had already passed through you.
export const CHANDELIER_BOTTOM_OFFSET = -0.613
// 1.0 model radius + 0.4 player body radius. Unlike the helpers in hits.ts
// this test compares the player's CENTRE to the chandelier's, so the body
// radius has to be baked in here.
export const CHANDELIER_KILL_RADIUS = 1.4

// The hover hint on the chandelier. It reads as scenery otherwise — nothing
// about a light fitting says "this is the lift to the upper floor", and the
// one thing you must NOT do is stand under it. Naming the action turns a trap
// into a choice.
//
// It is deliberately a hint and not a prompt: there is no button to press, you
// genuinely just jump on as it comes past. onPointerDown does nothing.
export const CHANDELIER_HOVER_TEXT = 'Jump to ride'
// Pointer target size. chandelift.glb measures 2.85 x 1.51 x 2.85 about its
// own origin, so this covers the visible fitting without spilling into the
// space beside it where a stray hover would be confusing.
export const CHANDELIER_HOVER_SIZE = Vector3.create(2.85, 1.51, 2.85)


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

// TRAP 8 — SWINGING BLADE: REMOVED. It drove a 'pblade.glb' entity that is
// no longer in main.composite; the scene uses the two pblade2 axes instead
// (see traps/swingTrapShapes.ts). Because the entity was missing, every
// platform fell through to its geometric fallback — a flat 4.8m-radius,
// 6.3m-tall column at (18.60, 3.20, 16.19) that killed on the 2nd floor
// during 100% of its cycle, with nothing drawn anywhere near it.
