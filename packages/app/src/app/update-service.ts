import type { MaybePromise } from '@reflect/utils'
import {
  isMobilePlatform,
  type ClockService,
  type LoggerService,
  type PlatformFacts,
  type TimerHandle,
  type Unlisten,
} from '@reflect/core'
import type { WindowService } from './window-service.ts'

/**
 * The auto-update lifecycle, as plain-language phases the UI renders
 * directly: nothing, then "Update available", then "Downloading…", then
 * "Restart to update". Every transition is user-deferrable: the app never
 * blocks on an update, and a failed check leaves the app exactly as it was.
 */
export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'upToDate' }
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; version: string; percent: number | null }
  | { phase: 'ready'; version: string }
  /** `during` tells surfaces what failed: a check retries by re-checking, a
      failed install still has its found update and retries by installing. */
  | { phase: 'error'; message: string; during: 'check' | 'install' }

/**
 * A download progress event, shaped like the Tauri updater plugin's `DownloadEvent`.
 */
export type UpdateDownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' }

/**
 * An update the release endpoint offers.
 */
export interface AvailableUpdate {
  readonly version: string
  /**
   * Download, verify, and install the update, reporting progress through `onEvent`.
   */
  downloadAndInstall(onEvent: (event: UpdateDownloadEvent) => void): Promise<void>
  /**
   * Release the native resource that holds this update.
   */
  close(): Promise<void>
}

/**
 * The native updater and process relaunch behind an {@link UpdateService}.
 */
export interface UpdaterAdapter {
  /**
   * The newer release, or `null` when the app is current.
   */
  check(): Promise<AvailableUpdate | null>
  relaunch(): MaybePromise<void>
}

/**
 * `getState` and `subscribe` are function properties so React can read them unbound.
 */
export interface UpdateService {
  /**
   * False outside a desktop native shell (browser dev, iOS, Android): hide
   * update UI entirely.
   */
  readonly supported: boolean
  getState: () => UpdateState
  subscribe: (listener: () => void) => Unlisten
  /**
   * Begin auto-checking in the main window: once now, then every six hours.
   */
  start(): void
  /**
   * User-initiated check: surfaces "up to date" and failures, unlike auto.
   */
  checkNow(): MaybePromise<void>
  /**
   * Download and install the found update; progress lands in the state.
   */
  install(): MaybePromise<void>
  /**
   * Relaunch into the installed update.
   */
  restart(): MaybePromise<void>
  /**
   * Retry what failed: an install after a failed install, otherwise a check.
   */
  retryAction(): MaybePromise<void>
  /**
   * Stop auto-checking.
   */
  dispose(): void
}

export interface UpdateServiceDeps {
  /**
   * The native updater, or `undefined` on a host without one: updates are
   * then unsupported.
   */
  readonly updater: UpdaterAdapter | undefined
  readonly clock: ClockService
  readonly logger: LoggerService
  readonly platform: PlatformFacts
  readonly window: WindowService
}

/**
 * Six hours: frequent enough to catch releases, quiet enough to be free.
 */
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Runs the retry that matches the failure in `service`'s state.
 */
export function retryUpdate(service: UpdateService): MaybePromise<void> {
  const state = service.getState()
  return state.phase === 'error' && state.during === 'install'
    ? service.install()
    : service.checkNow()
}

/**
 * Drives the native updater as a subscribable state machine. The Tauri
 * updater verifies every downloaded payload against the minisign pubkey in
 * `tauri.conf.json` before installing: a tampered or unsigned artifact
 * surfaces here as a plain `error` state, never as an install.
 *
 * Auto-checks fail silently by design: offline is a normal condition, and the
 * release endpoint being unreachable must never cost the user attention.
 */
class UpdateServiceImpl implements UpdateService {
  readonly #deps: UpdateServiceDeps & { readonly updater: UpdaterAdapter }
  readonly #listeners = new Set<() => void>()
  #state: UpdateState = { phase: 'idle' }
  #pendingUpdate: AvailableUpdate | null = null
  #timer: TimerHandle | null = null

  readonly #mainWindow: boolean

  readonly supported: boolean

  constructor(deps: UpdateServiceDeps & { readonly updater: UpdaterAdapter }) {
    this.#deps = deps
    this.#mainWindow = deps.window.isMainWindow()
    this.supported = deps.platform.isNativeShell && !isMobilePlatform(deps.platform.appPlatform)
  }

  readonly getState = (): UpdateState => this.#state

  readonly subscribe = (listener: () => void): Unlisten => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  start(): void {
    if (!this.supported || !this.#mainWindow || this.#timer !== null) {
      return
    }
    void this.#runCheck(true)
    this.#timer = this.#deps.clock.setInterval(
      () => void this.#runCheck(true),
      AUTO_CHECK_INTERVAL_MS,
    )
  }

  checkNow(): Promise<void> {
    return this.#runCheck(false)
  }

  async install(): Promise<void> {
    const update: AvailableUpdate | null = this.#pendingUpdate
    if (!update || this.#state.phase === 'downloading' || this.#state.phase === 'ready') {
      return
    }
    let contentLength: number | null = null
    let received = 0
    this.#setState({ phase: 'downloading', version: update.version, percent: null })
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength ?? null
            received = 0
            break
          case 'Progress':
            received += event.data.chunkLength
            if (contentLength !== null && contentLength > 0) {
              const percent = Math.min(100, Math.round((received / contentLength) * 100))
              this.#setState({ phase: 'downloading', version: update.version, percent })
            }
            break
          case 'Finished':
            this.#setState({ phase: 'downloading', version: update.version, percent: 100 })
            break
        }
      })
      this.#setState({ phase: 'ready', version: update.version })
    } catch (error) {
      this.#setState({ phase: 'error', message: errorMessage(error), during: 'install' })
    }
  }

  restart(): MaybePromise<void> {
    return this.#deps.updater.relaunch()
  }

  retryAction(): MaybePromise<void> {
    return retryUpdate(this)
  }

  dispose(): void {
    if (this.#timer !== null) {
      this.#deps.clock.clearInterval(this.#timer)
      this.#timer = null
    }
  }

  #setState(next: UpdateState): void {
    this.#state = next
    for (const listener of this.#listeners) {
      listener()
    }
  }

  async #close(update: AvailableUpdate | null): Promise<void> {
    try {
      await update?.close()
    } catch (error) {
      this.#deps.logger.warn('closing an update failed', error)
    }
  }

  async #runCheck(silent: boolean): Promise<void> {
    const phase = this.#state.phase
    if (phase === 'checking' || phase === 'downloading' || phase === 'ready') {
      return
    }
    // A silent check never touches visible state except to add a found
    // update: no "Checking…" blink over the sidebar row, and no retracting
    // anything on an empty answer (transient: release mid-edit, manifest
    // propagation) or a failure (offline is normal). Only the user's own
    // check shows its lifecycle, and only its answer is authoritative.
    if (!silent) {
      this.#setState({ phase: 'checking' })
    }
    // Every setState replaces the object, so identity means "nothing else
    // (e.g. an install of a previously found update) transitioned while we awaited".
    const baseline = this.#state
    try {
      const update: AvailableUpdate | null = await this.#deps.updater.check()
      if (this.#state !== baseline) {
        void this.#close(update)
        return
      }
      if (update) {
        void this.#close(this.#pendingUpdate)
        this.#pendingUpdate = update
        this.#setState({ phase: 'available', version: update.version })
      } else if (!silent) {
        void this.#close(this.#pendingUpdate)
        this.#pendingUpdate = null
        this.#setState({ phase: 'upToDate' })
      }
    } catch (error) {
      if (this.#state !== baseline) {
        return
      }
      if (silent) {
        this.#deps.logger.warn('update check failed (ignored)', error)
      } else {
        this.#setState({ phase: 'error', message: errorMessage(error), during: 'check' })
      }
    }
  }
}

const IDLE: UpdateState = { phase: 'idle' }

/**
 * An {@link UpdateService} for hosts without an updater: always idle, every
 * action a no-op.
 */
class UnsupportedUpdateService implements UpdateService {
  readonly supported = false

  readonly getState = (): UpdateState => IDLE

  readonly subscribe = (): Unlisten => () => {}

  start(): void {}

  async checkNow(): Promise<void> {}

  async install(): Promise<void> {}

  async restart(): Promise<void> {}

  async retryAction(): Promise<void> {}

  dispose(): void {}
}

export function createUpdateService(deps: UpdateServiceDeps): UpdateService {
  const { updater } = deps
  return updater === undefined
    ? new UnsupportedUpdateService()
    : new UpdateServiceImpl({ ...deps, updater })
}
