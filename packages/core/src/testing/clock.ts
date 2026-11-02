import type { ClockService, TimerHandle } from '../ports/clock-service.ts'
import { WritableStore, type Store } from '../store.ts'
import { formatIsoDate } from '@reflect/utils'

/**
 * A {@link ClockService} whose time moves only when a test moves it.
 */
export interface TestClockService extends ClockService {
  /**
   * Moves time forward by `ms`, running due timers in order and settling promises between them.
   */
  advance(ms: number): Promise<void>
  /**
   * Sets the wall clock without running timers or moving the monotonic clock.
   */
  setNow(epochMs: number): void
  /**
   * Pins `today` to `isoDate` and notifies its subscribers.
   */
  setToday(isoDate: string): void
  /**
   * The number of scheduled timeouts and intervals.
   */
  pendingTimers(): number
}

interface ScheduledTimer {
  readonly fn: () => void
  readonly interval: number | null
  due: number
  order: number
}

const MICROTASK_TURNS = 20

async function settle(): Promise<void> {
  for (let turn = 0; turn < MICROTASK_TURNS; turn++) {
    await Promise.resolve()
  }
}

class TestClockServiceImpl implements TestClockService {
  #wallMs: number
  #monotonicMs = 0
  #pinnedToday: string | null
  readonly #timers = new Map<number, ScheduledTimer>()
  #nextId = 1
  #nextOrder = 0
  readonly #today: WritableStore<string>
  readonly today: Store<string>

  constructor(options: { now?: number; today?: string } | undefined) {
    this.#wallMs = options?.now ?? 0
    this.#pinnedToday = options?.today ?? null
    this.#today = new WritableStore(this.#readToday())
    this.today = this.#today
  }

  now(): number {
    return this.#wallMs
  }

  monotonicNow(): number {
    return this.#monotonicMs
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    return this.#schedule(fn, ms, null)
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle.id)
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    // A zero period would never let `advance` finish.
    return this.#schedule(fn, ms, Math.max(1, ms))
  }

  clearInterval(handle: TimerHandle): void {
    this.#timers.delete(handle.id)
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.setTimeout(resolve, ms)
    })
  }

  async advance(ms: number): Promise<void> {
    const target = this.#monotonicMs + Math.max(0, ms)
    await settle()
    for (let next = this.#nextDue(target); next !== null; next = this.#nextDue(target)) {
      const [id, timer] = next
      this.#moveTo(timer.due)
      if (timer.interval === null) {
        this.#timers.delete(id)
      } else {
        timer.due += timer.interval
        timer.order = this.#nextOrder++
      }
      timer.fn()
      await settle()
    }
    this.#moveTo(target)
    await settle()
  }

  setNow(epochMs: number): void {
    this.#wallMs = epochMs
    this.#notifyToday()
  }

  setToday(isoDate: string): void {
    this.#pinnedToday = isoDate
    this.#notifyToday()
  }

  pendingTimers(): number {
    return this.#timers.size
  }

  #readToday(): string {
    return this.#pinnedToday ?? formatIsoDate(new Date(this.#wallMs))
  }

  #notifyToday(): void {
    this.#today.set(this.#readToday())
  }

  #schedule(fn: () => void, ms: number, interval: number | null): TimerHandle {
    const id = this.#nextId++
    this.#timers.set(id, {
      fn,
      interval,
      due: this.#monotonicMs + Math.max(0, ms),
      order: this.#nextOrder++,
    })
    return { id }
  }

  #nextDue(limit: number): [number, ScheduledTimer] | null {
    let found: [number, ScheduledTimer] | null = null
    for (const entry of this.#timers) {
      const timer = entry[1]
      if (timer.due > limit) {
        continue
      }
      if (
        found === null ||
        timer.due < found[1].due ||
        (timer.due === found[1].due && timer.order < found[1].order)
      ) {
        found = entry
      }
    }
    return found
  }

  #moveTo(monotonicTarget: number): void {
    this.#wallMs += monotonicTarget - this.#monotonicMs
    this.#monotonicMs = monotonicTarget
    this.#notifyToday()
  }
}

/**
 * Without `today`, the `today` store follows the local date of `now()`. `setToday`
 * pins it until the next `setToday`.
 */
export function createTestClockService(options?: {
  now?: number
  today?: string
}): TestClockService {
  return new TestClockServiceImpl(options)
}
