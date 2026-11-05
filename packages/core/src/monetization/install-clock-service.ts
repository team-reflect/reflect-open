import { isDeepEqual } from '@ocavue/utils'
import { safeParseJson } from '@reflect/utils'
import { z } from 'zod'
import type { ActivityPort } from '../ports/activity-port.ts'
import type { ClockService } from '../ports/clock-service.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { PlatformFacts } from '../ports/platform-facts.ts'
import type { SecretStoreService } from '../secrets/secret-store-service.ts'
import { WritableStore, type Store } from '../store.ts'
import type { Unlisten } from '../unlisten.ts'
import { DAY_MS, getPaywallPhase, type PaywallPhase } from './paywall-phase.ts'

/**
 * The keychain entry holding this device's first launch.
 */
export const INSTALL_CLOCK_SECRET = 'reflect-install-clock'

const installClockSchema = z.object({
  /**
   * Epoch ms of the first launch on this device.
   */
  firstLaunchAt: z.number(),
  /**
   * The latest epoch ms the app has seen, so a clock set back never rewinds the phase.
   */
  lastSeenAt: z.number(),
})
type InstallClockRecord = z.infer<typeof installClockSchema>

const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 60 * 1000

export interface InstallClockState {
  /**
   * The paywall phase for the time since the first launch; `null` while loading.
   */
  readonly phase: PaywallPhase | null
  /**
   * Epoch ms of the first launch; `null` while loading or when the keychain is unreadable.
   */
  readonly firstLaunchAt: number | null
  /**
   * Whole days from the first launch to the latest time the app has seen; `0`
   * while loading or when the keychain is unreadable.
   */
  readonly dayIndex: number
  readonly isLoading: boolean
}

/**
 * Time since this device's first launch, kept in the keychain. On iOS, while
 * the state has a subscriber, it reads the record and refreshes it whenever
 * the page turns visible. An unreadable keychain reads as `hidden` and is
 * never overwritten.
 */
export interface InstallClockService extends Store<InstallClockState> {}

export interface InstallClockServiceDeps {
  readonly secretStore: SecretStoreService
  readonly clock: ClockService
  readonly activity: ActivityPort
  readonly platform: PlatformFacts
  readonly logger: LoggerService
}

class InstallClockServiceImpl implements InstallClockService {
  readonly #deps: InstallClockServiceDeps
  readonly #enabled: boolean
  readonly #state: WritableStore<InstallClockState>
  #record: InstallClockRecord | null = null
  #savedLastSeenAt: number | null = null
  #pendingRefresh: Promise<void> | null = null
  #stopWork: Unlisten | null = null

  constructor(deps: InstallClockServiceDeps) {
    this.#deps = deps
    this.#enabled = deps.platform.appPlatform === 'ios'
    this.#state = new WritableStore<InstallClockState>(
      {
        phase: this.#enabled ? null : 'hidden',
        firstLaunchAt: null,
        dayIndex: 0,
        isLoading: this.#enabled,
      },
      isDeepEqual,
    )
  }

  readonly get = (): InstallClockState => this.#state.get()

  readonly subscribe = (listener: VoidFunction): Unlisten => {
    const unsubscribe = this.#state.subscribe(listener)
    if (this.#enabled) {
      this.#stopWork ??= this.#startWork()
    }
    return () => {
      unsubscribe()
      if (!this.#state.subscribed()) {
        this.#stopWork?.()
        this.#stopWork = null
      }
    }
  }

  #startWork(): Unlisten {
    void this.#refresh()
    return this.#deps.activity.subscribeVisible(() => {
      void this.#refresh()
    })
  }

  #refresh(): Promise<void> {
    if (this.#pendingRefresh === null) {
      const current = this.#runRefresh()
      this.#pendingRefresh = current
      void current.finally(() => {
        if (this.#pendingRefresh === current) this.#pendingRefresh = null
      })
    }
    return this.#pendingRefresh
  }

  async #runRefresh(): Promise<void> {
    if (this.#record === null) {
      await this.#load()
    }
    this.#publish()
  }

  /**
   * Reads the record, or starts one when none is stored. A failed read leaves
   * `#record` empty and writes nothing.
   */
  async #load(): Promise<void> {
    const { secretStore, clock, logger } = this.#deps
    let raw: string | null
    try {
      raw = await secretStore.get(INSTALL_CLOCK_SECRET)
    } catch (error) {
      logger.error('Reading the install clock failed', error)
      return
    }
    const parsed = raw === null ? null : installClockSchema.safeParse(safeParseJson(raw))
    if (parsed?.success === true) {
      this.#record = parsed.data
      this.#savedLastSeenAt = parsed.data.lastSeenAt
      return
    }
    if (parsed !== null) {
      logger.error('Replacing an unreadable install clock record', parsed.error)
    }
    const now = clock.now()
    this.#record = { firstLaunchAt: now, lastSeenAt: now }
    this.#save(this.#record)
  }

  /**
   * Writes the record. A failed write clears the saved mark, so the next
   * refresh writes again.
   */
  #save(record: InstallClockRecord): void {
    this.#savedLastSeenAt = record.lastSeenAt
    this.#deps.secretStore
      .set(INSTALL_CLOCK_SECRET, JSON.stringify(record))
      .catch((error: unknown) => {
        this.#savedLastSeenAt = null
        this.#deps.logger.warn('Saving the install clock failed', error)
      })
  }

  #publish(): void {
    const now = this.#deps.clock.now()
    const record = this.#record
    if (record === null) {
      this.#state.set({
        phase: 'hidden',
        firstLaunchAt: null,
        dayIndex: 0,
        isLoading: false,
      })
      return
    }
    const effectiveNow = Math.max(now, record.lastSeenAt)
    const phase = getPaywallPhase(effectiveNow - record.firstLaunchAt)
    // The high-water mark moves in memory on every refresh. The keychain gets
    // it at most once an hour, and also on a phase change, so a clock set
    // back never rewinds a phase the app has seen.
    this.#record = { ...record, lastSeenAt: effectiveNow }
    const saved = this.#savedLastSeenAt
    if (
      saved === null ||
      effectiveNow - saved >= LAST_SEEN_WRITE_INTERVAL_MS ||
      phase !== getPaywallPhase(saved - record.firstLaunchAt)
    ) {
      this.#save(this.#record)
    }
    this.#state.set({
      phase,
      firstLaunchAt: record.firstLaunchAt,
      dayIndex: Math.floor((effectiveNow - record.firstLaunchAt) / DAY_MS),
      isLoading: false,
    })
  }
}

export function createInstallClockService(deps: InstallClockServiceDeps): InstallClockService {
  return new InstallClockServiceImpl(deps)
}
