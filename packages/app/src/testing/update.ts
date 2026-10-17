import type { MaybePromise } from '@reflect/utils'
import type { Unlisten } from '@reflect/core'
import {
  retryUpdate,
  type AvailableUpdate,
  type UpdateDownloadEvent,
  type UpdaterAdapter,
  type UpdateService,
  type UpdateState,
} from '../app/update-service.ts'

export interface TestUpdaterOptions {
  /**
   * The update `check()` offers; `null` or absent means the app is current.
   */
  available?: { version: string } | null
  /**
   * When set, `check()` rejects with this message.
   */
  failCheck?: string
  /**
   * When set, `downloadAndInstall` rejects with this message.
   */
  failInstall?: string
  /**
   * When true, `downloadAndInstall` stays pending until {@link TestUpdaterAdapter.finishInstall}.
   */
  holdInstall?: boolean
}

export type TestUpdaterCall = 'check' | 'downloadAndInstall' | 'relaunch'

/**
 * An {@link UpdaterAdapter} whose answers and download progress a test controls.
 */
export interface TestUpdaterAdapter extends UpdaterAdapter {
  /**
   * Every adapter call, in order.
   */
  readonly calls: readonly TestUpdaterCall[]
  /**
   * Replace the options that later calls answer with.
   */
  configure(options: TestUpdaterOptions): void
  /**
   * Make the next `check()` wait; the returned function lets it answer.
   */
  holdNextCheck(): () => void
  /**
   * Report `percent` of the held download as received.
   */
  progress(percent: number): void
  /**
   * Settle the held download: `Finished` then resolve, or reject under `failInstall`.
   */
  finishInstall(): void
}

const CONTENT_LENGTH = 100

class TestAvailableUpdate implements AvailableUpdate {
  readonly #download: (onEvent: (event: UpdateDownloadEvent) => void) => Promise<void>

  readonly version: string

  constructor(
    version: string,
    download: (onEvent: (event: UpdateDownloadEvent) => void) => Promise<void>,
  ) {
    this.version = version
    this.#download = download
  }

  downloadAndInstall(onEvent: (event: UpdateDownloadEvent) => void): Promise<void> {
    return this.#download(onEvent)
  }
}

class TestUpdaterAdapterImpl implements TestUpdaterAdapter {
  #options: TestUpdaterOptions
  #checkGate: Promise<void> | null = null
  #download: {
    onEvent: (event: UpdateDownloadEvent) => void
    received: number
    settle: () => void
  } | null = null

  readonly calls: TestUpdaterCall[] = []

  constructor(initial: TestUpdaterOptions | undefined) {
    this.#options = { ...initial }
  }

  async check(): Promise<AvailableUpdate | null> {
    this.calls.push('check')
    const gate = this.#checkGate
    this.#checkGate = null
    if (gate) {
      await gate
    }
    if (this.#options.failCheck !== undefined) {
      throw new Error(this.#options.failCheck)
    }
    return this.#options.available ? this.#offer(this.#options.available.version) : null
  }

  relaunch(): void {
    this.calls.push('relaunch')
  }

  configure(options: TestUpdaterOptions): void {
    this.#options = { ...options }
  }

  holdNextCheck(): () => void {
    const { promise, resolve } = Promise.withResolvers<void>()
    this.#checkGate = promise
    return resolve
  }

  progress(percent: number): void {
    if (!this.#download) {
      throw new Error('No download is in progress')
    }
    const target = Math.round((percent / 100) * CONTENT_LENGTH)
    this.#download.onEvent({
      event: 'Progress',
      data: { chunkLength: target - this.#download.received },
    })
    this.#download.received = target
  }

  finishInstall(): void {
    if (!this.#download) {
      throw new Error('No download is in progress')
    }
    const { settle } = this.#download
    this.#download = null
    settle()
  }

  #settleDownload(onEvent: (event: UpdateDownloadEvent) => void): Promise<void> {
    if (this.#options.failInstall !== undefined) {
      return Promise.reject(new Error(this.#options.failInstall))
    }
    onEvent({ event: 'Finished' })
    return Promise.resolve()
  }

  #offer(version: string): AvailableUpdate {
    return new TestAvailableUpdate(version, (onEvent) => {
      this.calls.push('downloadAndInstall')
      onEvent({ event: 'Started', data: { contentLength: CONTENT_LENGTH } })
      if (!this.#options.holdInstall) {
        return this.#settleDownload(onEvent)
      }
      const { promise, resolve, reject } = Promise.withResolvers<void>()
      this.#download = {
        onEvent,
        received: 0,
        settle: () => this.#settleDownload(onEvent).then(resolve, reject),
      }
      return promise
    })
  }
}

/**
 * A test updater; the download reports a content length of 100 bytes.
 */
export function createTestUpdaterAdapter(initial?: TestUpdaterOptions): TestUpdaterAdapter {
  return new TestUpdaterAdapterImpl(initial)
}

export type TestUpdateCall =
  | 'start'
  | 'checkNow'
  | 'install'
  | 'restart'
  | 'retryAction'
  | 'dispose'

/**
 * An {@link UpdateService} whose state a test sets directly.
 */
export interface TestUpdateService extends UpdateService {
  /**
   * Every action call, in order.
   */
  readonly calls: readonly TestUpdateCall[]
  /**
   * Replace the state and notify subscribers.
   */
  setState(state: UpdateState): void
}

class TestUpdateServiceImpl implements TestUpdateService {
  #current: UpdateState
  readonly #listeners = new Set<() => void>()

  readonly supported = true
  readonly calls: TestUpdateCall[] = []

  constructor(state: UpdateState) {
    this.#current = state
  }

  readonly getState = (): UpdateState => this.#current

  readonly subscribe = (listener: () => void): Unlisten => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  start(): void {
    this.calls.push('start')
  }

  checkNow(): void {
    this.calls.push('checkNow')
  }

  install(): void {
    this.calls.push('install')
  }

  restart(): void {
    this.calls.push('restart')
  }

  retryAction(): MaybePromise<void> {
    this.calls.push('retryAction')
    return retryUpdate(this)
  }

  dispose(): void {
    this.calls.push('dispose')
  }

  setState(state: UpdateState): void {
    this.#current = state
    for (const listener of this.#listeners) {
      listener()
    }
  }
}

/**
 * A supported update service that starts in `state` (idle by default); actions only record.
 */
export function createTestUpdateService(state?: UpdateState): TestUpdateService {
  return new TestUpdateServiceImpl(state ?? { phase: 'idle' })
}
