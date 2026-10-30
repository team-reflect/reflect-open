import { getIsoToday } from '@reflect/utils'

/**
 * An opaque timer handle owned by a {@link ClockService}.
 */
export type TimerHandle = { readonly id: number }

/**
 * Wall time, monotonic time, the local date, and timers.
 */
export interface ClockService {
  /**
   * Epoch milliseconds, like `Date.now()`.
   */
  now(): number
  /**
   * Monotonic milliseconds, like `performance.now()`.
   */
  monotonicNow(): number
  /**
   * The local calendar date as `YYYY-MM-DD`.
   */
  today(): string
  /**
   * Calls `listener` with the new date whenever the local date changes.
   */
  subscribeToday(listener: (today: string) => void): () => void
  setTimeout(fn: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
  setInterval(fn: () => void, ms: number): TimerHandle
  clearInterval(handle: TimerHandle): void
  sleep(ms: number): Promise<void>
}

const HEARTBEAT_MS = 60_000
const MIDNIGHT_PAD_MS = 250

class SystemClockImpl implements ClockService {
  readonly #timers = new Map<number, ReturnType<typeof globalThis.setTimeout>>()
  #nextId = 1
  #today = getIsoToday()
  readonly #listeners = new Set<(today: string) => void>()
  #midnightTimer: ReturnType<typeof globalThis.setTimeout> | null = null
  #heartbeat: ReturnType<typeof globalThis.setInterval> | null = null

  readonly #syncToday = (): void => {
    const next = getIsoToday()
    if (next === this.#today) {
      return
    }
    this.#today = next
    for (const listener of this.#listeners) {
      listener(next)
    }
  }

  now(): number {
    return Date.now()
  }

  monotonicNow(): number {
    return performance.now()
  }

  today(): string {
    // While nothing is subscribed, no timer keeps the cached date fresh.
    if (this.#listeners.size === 0) {
      this.#today = getIsoToday()
    }
    return this.#today
  }

  subscribeToday(listener: (today: string) => void): () => void {
    const first = this.#listeners.size === 0
    this.#listeners.add(listener)
    if (first) {
      this.#start()
    }
    return () => {
      if (!this.#listeners.delete(listener)) {
        return
      }
      if (this.#listeners.size === 0) {
        this.#stop()
      }
    }
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.#nextId++
    this.#timers.set(
      id,
      globalThis.setTimeout(() => {
        this.#timers.delete(id)
        fn()
      }, ms),
    )
    return { id }
  }

  clearTimeout(handle: TimerHandle): void {
    this.#clearTimer(handle)
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    const id = this.#nextId++
    this.#timers.set(id, globalThis.setInterval(fn, ms))
    return { id }
  }

  clearInterval(handle: TimerHandle): void {
    this.#clearTimer(handle)
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.setTimeout(resolve, ms)
    })
  }

  // DOM timers pause while the machine sleeps, so the heartbeat and the
  // visibility listener catch a midnight that this timer misses.
  #scheduleMidnightRollover(): void {
    const now = new Date()
    const midnight = new Date(now)
    midnight.setDate(midnight.getDate() + 1)
    midnight.setHours(0, 0, 0, 0)
    this.#midnightTimer = globalThis.setTimeout(
      () => {
        this.#syncToday()
        this.#scheduleMidnightRollover()
      },
      midnight.getTime() - now.getTime() + MIDNIGHT_PAD_MS,
    )
  }

  #start(): void {
    this.#syncToday()
    this.#scheduleMidnightRollover()
    this.#heartbeat = globalThis.setInterval(this.#syncToday, HEARTBEAT_MS)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.#syncToday)
    }
  }

  #stop(): void {
    if (this.#midnightTimer !== null) {
      globalThis.clearTimeout(this.#midnightTimer)
      this.#midnightTimer = null
    }
    if (this.#heartbeat !== null) {
      globalThis.clearInterval(this.#heartbeat)
      this.#heartbeat = null
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#syncToday)
    }
  }

  #clearTimer(handle: TimerHandle): void {
    const timer = this.#timers.get(handle.id)
    if (timer === undefined) {
      return
    }
    this.#timers.delete(handle.id)
    globalThis.clearTimeout(timer)
  }
}

/**
 * The clock backed by the platform's `Date`, `performance`, and timers.
 */
export function createSystemClock(): ClockService {
  return new SystemClockImpl()
}
