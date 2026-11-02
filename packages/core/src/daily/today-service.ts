import { addDays, formatIsoDate, startOfDay } from '@reflect/utils'
import type { ClockService, TimerHandle } from '../ports/clock-service.ts'
import { WritableStore, type Store } from '../store.ts'
import type { Unlisten } from '../unlisten.ts'

/**
 * The local calendar date as `YYYY-MM-DD`. Subscribers are notified whenever it changes.
 */
export interface TodayService extends Store<string> {}

export interface TodayServiceDeps {
  readonly clock: ClockService
}

const HEARTBEAT_MS = 60_000
const MIDNIGHT_PAD_MS = 250

class TodayServiceImpl implements TodayService {
  readonly #deps: TodayServiceDeps
  readonly #store: WritableStore<string>
  #midnightTimer: TimerHandle | null = null
  #stop: Unlisten | null = null

  constructor(deps: TodayServiceDeps) {
    this.#deps = deps
    this.#store = new WritableStore(this.#readToday())
  }

  readonly get = (): string => {
    // While nothing is subscribed, no timer keeps the cached date fresh.
    if (!this.#store.subscribed()) {
      this.#syncToday()
    }
    return this.#store.get()
  }

  readonly subscribe = (listener: VoidFunction): Unlisten => {
    const unlisten = this.#store.subscribe(listener)
    this.#stop ??= this.#start()
    return () => {
      unlisten()
      if (!this.#store.subscribed()) {
        this.#stop?.()
        this.#stop = null
      }
    }
  }

  readonly #syncToday = (): void => {
    this.#store.set(this.#readToday())
  }

  #readToday(): string {
    return formatIsoDate(new Date(this.#deps.clock.now()))
  }

  // DOM timers pause while the machine sleeps, so the heartbeat and the
  // visibility listener catch a midnight that this timer misses.
  #scheduleMidnightRollover(): void {
    const now: number = this.#deps.clock.now()
    const midnight: number = addDays(startOfDay(now), 1).getTime()

    this.#midnightTimer = this.#deps.clock.setTimeout(
      () => {
        this.#syncToday()
        this.#scheduleMidnightRollover()
      },
      midnight - now + MIDNIGHT_PAD_MS,
    )
  }

  /**
   * Keep the date fresh until the returned function runs.
   */
  #start(): Unlisten {
    const { clock } = this.#deps
    this.#syncToday()
    this.#scheduleMidnightRollover()
    const heartbeat = clock.setInterval(this.#syncToday, HEARTBEAT_MS)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.#syncToday)
    }
    return () => {
      if (this.#midnightTimer !== null) {
        clock.clearTimeout(this.#midnightTimer)
        this.#midnightTimer = null
      }
      clock.clearInterval(heartbeat)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', this.#syncToday)
      }
    }
  }
}

export function createTodayService(deps: TodayServiceDeps): TodayService {
  return new TodayServiceImpl(deps)
}
