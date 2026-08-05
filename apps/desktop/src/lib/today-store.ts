import { addDays, startOfDay } from 'date-fns'
import { todayIso } from './dates'

/**
 * Today's local calendar date as a module-level external store, shared by
 * every `useToday()` subscriber: one timer set per window, not one per
 * mounted hook.
 *
 * A lone midnight timeout is not enough: DOM timers fire on a monotonic
 * clock that pauses while the machine sleeps, so a timeout armed for local
 * midnight fires hours late after a sleep/wake cycle. The store therefore
 * re-reads the wall clock from every cheap signal it can get: the midnight
 * timer (the precise awake-path rollover), visibility/focus changes (the
 * wake-up path), and a low-frequency heartbeat (a wake with no such event).
 */

let today = todayIso()
const listeners = new Set<() => void>()
let midnightTimer: ReturnType<typeof setTimeout> | null = null
let heartbeat: ReturnType<typeof setInterval> | null = null

/** Re-read the wall clock; notify subscribers only when the date changed. */
function syncToday(): void {
  const next = todayIso()
  if (next === today) {
    return
  }
  today = next
  for (const listener of listeners) {
    listener()
  }
}

function scheduleMidnightRollover(): void {
  const now = new Date()
  const midnight = startOfDay(addDays(now, 1))
  // The pad absorbs timer drift around the boundary; the heartbeat and the
  // wake listeners cover this timer being delayed across system sleep.
  midnightTimer = setTimeout(
    () => {
      syncToday()
      scheduleMidnightRollover()
    },
    midnight.getTime() - now.getTime() + 250,
  )
}

function start(): void {
  // The store may have idled across a date boundary while nothing was
  // subscribed; refresh before the first subscriber reads it.
  syncToday()
  scheduleMidnightRollover()
  heartbeat = setInterval(syncToday, 60_000)

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', syncToday)
  }
}

function stop(): void {
  if (midnightTimer !== null) {
    clearTimeout(midnightTimer)
    midnightTimer = null
  }
  if (heartbeat !== null) {
    clearInterval(heartbeat)
    heartbeat = null
  }

  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', syncToday)
  }
}

/** `useSyncExternalStore` subscribe; timers run only while subscribed. */
export function subscribeToday(listener: () => void): () => void {
  const first = listeners.size === 0
  listeners.add(listener)
  if (first) {
    start()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      stop()
    }
  }
}

export function getTodaySnapshot(): string {
  return today
}
