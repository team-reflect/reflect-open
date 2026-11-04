/**
 * An opaque timer handle owned by a {@link ClockService}.
 */
export type TimerHandle = { readonly id: number }

/**
 * Wall time, monotonic time, and timers.
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
  setTimeout(fn: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
  setInterval(fn: () => void, ms: number): TimerHandle
  clearInterval(handle: TimerHandle): void
  sleep(ms: number): Promise<void>
}

class SystemClockImpl implements ClockService {
  readonly #timers = new Map<number, ReturnType<typeof globalThis.setTimeout>>()
  #nextId = 1

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
