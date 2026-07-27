/**
 * TOAST NOTIFICATIONS — short-lived text lines fed by scene events (a death,
 * a lit candle) so everyone in the shared house sees what everyone else is
 * doing, not just their own client. Purely a queue + timer; ui.tsx renders it.
 */

import { addSafeSystem } from './safeSystem'

const TOAST_DURATION = 4 // seconds a toast stays visible
const MAX_TOASTS = 4 // oldest drops if more stack up than this

export interface Toast {
  id: number
  text: string
  ttl: number
}

const toasts: Toast[] = []
let nextId = 0

/** Queue a toast for MY client. Callers wanting other players to see it too must also bus.emit a matching event. */
export function pushToast(text: string) {
  toasts.push({ id: nextId++, text, ttl: TOAST_DURATION })
  if (toasts.length > MAX_TOASTS) toasts.shift()
}

/** Oldest-first; ui.tsx renders newest last (bottom) or reverses as it likes. */
export function activeToasts(): Toast[] {
  return toasts
}

function toastSystem(dt: number) {
  for (let i = toasts.length - 1; i >= 0; i--) {
    toasts[i].ttl -= dt
    if (toasts[i].ttl <= 0) toasts.splice(i, 1)
  }
}

export function initNotifications() {
  addSafeSystem(toastSystem, 'notificationsSystem')
}
