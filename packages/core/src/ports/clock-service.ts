import { getIsoToday } from '@reflect/utils'
import { WritableStore, type Store } from '../store.ts'
import type { Unlisten } from '../unlisten.ts'

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
   * The local calendar date as `YYYY-MM-DD`. Subscribers are notified whenever it changes.
   */
  readonly today: Store<string>
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
  readonly #today = new WritableStore(getIsoToday())
  #watchers = 0
  #midnightTimer: ReturnType<typeof globalThis.setTimeout> | null = null
  #heartbeat: ReturnType<typeof globalThis.setInterval> | null = null

  readonly #syncToday = (): void => {
    this.#today.set(getIsoToday())
  }

  readonly today: Store<string> = {
    get: () => {
      // While nothing is subscribed, no timer keeps the cached date fresh.
      if (this.#watchers === 0) {
        this.#syncToday()
      }
      return this.#today.get()
    },
    subscribe: (listener: VoidFunction): Unlisten => {
      const unlisten = this.#today.subscribe(listener)
      if (++this.#watchers === 1) {
        this.#start()
      }
      let active = true
      return () => {
        if (!active) {
          return
        }
        active = false
        unlisten()
        if (--this.#watchers === 0) {
          this.#stop()
        }
      }
    },
  }

  now(): number {
    return Date.now()
  }

  monotonicNow(): number {
    return performance.now()
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
