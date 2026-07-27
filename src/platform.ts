/**
 * PLATFORM DETECTION — one cached answer for the whole scene.
 *
 * getPlatform() reads a value the SDK populates asynchronously after scene
 * start (official docs caveat: nothing guarantees it's ready by the time
 * main() runs — it returns null until the explorer answers). Callers that
 * BRANCH BEHAVIOR on it must either tolerate the desktop-default answer
 * until it resolves (per-frame reads, like the UI scale) or defer the
 * decision until platformKnown() is true (one-shot setup, like registering
 * the skeletons' raycast feelers).
 */

import { getPlatform } from '@dcl/sdk/platform'

/** Has the explorer answered yet? False during the first moments of a session. */
export function platformKnown(): boolean {
  return getPlatform() !== null
}

let known: boolean | null = null

/**
 * Is this the mobile client? Returns false while the answer is still pending
 * (desktop-default), then caches the real answer forever — the platform
 * can't change mid-session.
 */
export function isMobileNow(): boolean {
  if (known !== null) return known
  const p = getPlatform()
  if (p === null) return false
  known = p === 'mobile'
  return known
}
