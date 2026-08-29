/**
 * UI THEME — design tokens and responsive scaling for the Spooky House HUD.
 *
 * ── The palette contract ────────────────────────────────────────────────────
 * Every colour here means exactly ONE thing. The old HUD spent a single
 * saturated red on "timer", "danger", "defeat", "death" and "important" all at
 * once — a colour that means five things means nothing at a glance in a dark
 * scene, which is why the HUD read as noise. The rules below are the design:
 *
 *   FLAME  fire, and only fire. The candle you are lighting, and lit wax.
 *   VEIL   the way out, and only that. It does NOT appear once during a run,
 *          so the instant the strip turns violet the exit is open — readable
 *          from peripheral vision with zero reading.
 *   RUST   loss, and only loss. Death and defeat headlines. NEVER on the
 *          running HUD — the clock never turns red. Red is loss, not urgency.
 *          Urgency is carried by motion (the strip gutters) instead.
 *
 * Because no red appears on the HUD, the blood overlay on the death screen and
 * the blood in the 3D scene become the only red the player ever sees.
 *
 * ── The scaling contract ────────────────────────────────────────────────────
 * Every size in the UI goes through px() / fs(). Do not write raw pixel
 * numbers in ui.tsx — raw numbers are what made the old HUD unusable on
 * phones (a 760px-wide intro panel on a 390px screen).
 *
 * Why not the SDK's 'Nvw'/'Nvh' font units? Two reasons, both verified in
 * node_modules/@dcl/react-ecs:
 *   1. Mixed regimes. Label/utils.js routes a STRING fontSize through
 *      calcOnViewport() but multiplies a NUMBER by getUiScaleFactor(). Mixing
 *      the two in one screen gives two different scaling curves.
 *   2. Orientation. 'vh' holds steady from desktop to a PORTRAIT phone, but
 *      collapses on a LANDSCAPE phone (844x390 -> 1vh = 3.9px); 'vw' has the
 *      mirror-image problem. Neither unit alone survives both orientations.
 *
 * uiScale() keys off the SHORT edge instead, so it is orientation-independent,
 * and it is clamped so a phone never renders illegibly small nor a large
 * monitor absurdly large.
 */

import { engine, UiCanvasInformation } from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'
import { isMobileNow } from './platform'

/** Reference short-edge, in virtual px. A 1920x1080 desktop sits just above 1. */
const BASE_SHORT_EDGE = 900
const MIN_SCALE = 0.55
const MAX_SCALE = 1.25

// ── Mobile boost ───────────────────────────────────────────────────────────
// The official mobile guide's rule is "design desktop first, then scale UI
// sizes up ~3× for mobile" — a phone is physically small and read at arm's
// length, and touch targets need real area. Applying the raw 3× to this
// layout would overflow it (the intro/win columns were composed at desktop
// proportions), so the boost is applied through the same short-edge curve and
// then clamped: MOBILE_MAX_SCALE is the actual knob that decides how much
// bigger mobile UI gets. On the phone canvases seen in testing (~920 short
// edge) the pre-boost scale lands ≈1.0 — i.e. desktop-sized text on a
// hand-held screen, which is why the mobile HUD read as tiny — and the boost
// takes it to the clamp instead.
const MOBILE_UI_BOOST = 3
const MOBILE_MIN_SCALE = 0.9
const MOBILE_MAX_SCALE = 1.6

// isMobileNow() (src/platform.ts) reads false until the explorer's async
// platform answer arrives, so the UI starts at desktop scaling and pops to
// mobile size the moment the answer lands — the same accepted one-frame-pop
// failure mode as uiScale()'s own missing-canvas-info fallback below.

/**
 * Layout branch for the few spots that must dodge the mobile client's own
 * on-screen controls (joystick, jump/E/F cluster) — safe-area insets do NOT
 * cover those, they're drawn by the explorer inside the safe area.
 */
export function uiIsMobile(): boolean {
  return isMobileNow()
}

/**
 * Current UI scale factor, derived from the canvas's short edge.
 *
 * Returns 1 when UiCanvasInformation has not arrived yet (frame 0) — a sane
 * desktop default. We deliberately do NOT gate the whole UI tree on canvas
 * info being present: a one-frame size pop is a far better failure mode than a
 * permanently blank UI if the component never shows up.
 */
export function uiScale(): number {
  // Guarded because this runs inside the render function on EVERY frame. A
  // throw here would propagate out of the react-ecs system and take the whole
  // scene update loop down with it — the exact failure that has bricked this
  // scene before. A wrong-but-sane scale is always better than a dead scene.
  try {
    const info = UiCanvasInformation.getOrNull(engine.RootEntity)
    if (info === null) return 1
    const short = Math.min(info.width, info.height)
    if (!(short > 0)) return 1
    if (isMobileNow()) {
      return Math.max(MOBILE_MIN_SCALE, Math.min(MOBILE_MAX_SCALE, (short / BASE_SHORT_EDGE) * MOBILE_UI_BOOST))
    }
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, short / BASE_SHORT_EDGE))
  } catch {
    return 1
  }
}

/**
 * Canvas width in virtual px — for the one case px() cannot serve.
 *
 * react-ecs has no aspect-ratio property, so an image that must keep its shape
 * needs BOTH dimensions in real numbers, which means knowing how much room
 * there actually is. px() can't answer that: it scales a fixed design size, so
 * on a narrow phone at mobile boost a px()-sized title happily computes wider
 * than the screen and overflows. Anything sized off this should still clamp
 * with px() for the upper bound — this is the ceiling, not the size.
 *
 * Falls back to a desktop-ish width for the frames before UiCanvasInformation
 * arrives, same one-frame-pop trade-off as uiScale().
 */
export function uiCanvasWidth(): number {
  try {
    const info = UiCanvasInformation.getOrNull(engine.RootEntity)
    if (info === null || !(info.width > 0)) return 1280
    return info.width
  } catch {
    return 1280
  }
}

/** Scale a layout dimension. `floor` keeps hairline elements from vanishing on phones. */
export function px(n: number, floor = 0): number {
  return Math.max(floor, Math.round(n * uiScale()))
}

/**
 * Scale a font size. Always a plain number, never a 'vw'/'vh' string, so the
 * whole UI stays in one scaling regime (see the header note).
 *
 * NOTE: fontSize 0 is silently dropped by the SDK (Label/utils.js guards with
 * `if (!fontSize)`), so this never returns 0 — hide text by not rendering it.
 */
export function fs(n: number): number {
  return Math.max(1, Math.round(n * uiScale()))
}

// ── Palette ────────────────────────────────────────────────────────────────
// Alpha is applied at the use site via a() so each colour has one definition.

/** Deep night. The time-shadow and full-screen scrims. Never text. */
export const VOID = Color4.create(0.043, 0.055, 0.071, 1) // #0B0E12
/** Unclaimed strip cells and dormant fills. Never text. */
export const COLD = Color4.create(0.106, 0.145, 0.188, 1) // #1B2530
/** Inactive text and spent marks. If it is ASH, you cannot act on it. */
export const ASH = Color4.create(0.290, 0.310, 0.341, 1) // #4A4F57
/** Secondary prose. Warm grey so it reads as bone, not as a dimmed white. */
export const BONE = Color4.create(0.604, 0.561, 0.486, 1) // #9A8F7C
/** Primary text, the run clock, lit wax. The colour of progress. */
export const WAX = Color4.create(0.929, 0.906, 0.855, 1) // #EDE7DA
/** Fire, and strictly fire: the candle currently being lit. */
export const FLAME = Color4.create(1.0, 0.604, 0.180, 1) // #FF9A2E
/** The way out. Absent for the entire run until the portal opens. */
export const VEIL = Color4.create(0.549, 0.251, 0.949, 1) // #8C40F2
/** Loss. Death and defeat headlines only — never on the running HUD. */
export const RUST = Color4.create(0.557, 0.169, 0.133, 1) // #8E2B22

/** Same colour at a different alpha. */
export function a(c: Color4, alpha: number): Color4 {
  return Color4.create(c.r, c.g, c.b, alpha)
}

// ── Type scale ─────────────────────────────────────────────────────────────
// Three roles, three families. serif = the house speaking (headlines only, so
// serif appearing means the round has ended). sans = the game speaking plainly
// (survives small sizes in a dark scene, which serif does not). mono = every
// numeral without exception, so digits do not jitter as the clock ticks.

export const FONT_DISPLAY = 'serif' as const
export const FONT_BODY = 'sans-serif' as const
export const FONT_DATA = 'monospace' as const

/** Ramp in reference px (multiply through fs()). ~1.35x between steps. */
export const T_MICRO = 13 // footers, eyebrows, the exit line
export const T_SMALL = 17 // leaderboard rows, supporting detail
export const T_BODY = 21 // prose
export const T_CLOCK = 75 // the live run clock — largest thing in the HUD (+50%, on request)
/**
 * The HUD heart pips.
 *
 * Twice T_BODY, on request. They used to render at T_BODY, the same size as
 * prose, which made the one readout you check mid-panic the same weight as a
 * sentence. Hearts are a glance target: three glyphs that have to be countable
 * without stopping, so they get their own step rather than borrowing the body
 * size.
 */
export const T_HEART = T_BODY * 2
export const T_HEAD = 48 // overlay headlines
export const T_SCORE = 78 // the win screen's escape time; the score IS the win

// ── Strip geometry ─────────────────────────────────────────────────────────
// Floored so the signature element never becomes a hairline on a phone.

export const STRIP_HEIGHT = () => px(15, 11)
export const STRIP_GAP = () => px(2, 1)
