import { z } from 'zod'
import { errorMessage } from '../errors.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import { WriteableStore, type Store } from '../store.ts'
import type { Unlisten } from '../unlisten.ts'
import { DEFAULT_SETTINGS, settingsSchema, type Settings } from './schema.ts'
import { isDeepEqual } from '@ocavue/utils'

/**
 * How the initial settings load ended; `failed` means session-only updates.
 */
export type SettingsLoadOutcome = 'loaded' | 'failed'

export type SettingsStatus = 'loading' | SettingsLoadOutcome

type SettingsUpdater = (current: Settings) => Partial<Settings>

/**
 * The global settings document: loaded once, patches visible immediately,
 * saves persisted one at a time. When the load fails, updates stay
 * session-only so a defaults-built save never overwrites the stored document.
 */
export interface SettingsService extends Store<Settings> {
  /**
   * Merges `patch` now and persists the full document in the background.
   */
  update: (patch: Partial<Settings>) => void
  /**
   * Computes a patch from the latest settings; calls made before the load replay over the loaded document.
   */
  updateWith: (updater: SettingsUpdater) => void
  whenLoaded: () => Promise<SettingsLoadOutcome>
  /**
   * After a failed load, load the stored document again; on success it
   * replaces the session-only settings. Otherwise answers {@link whenLoaded}.
   */
  reload(): Promise<SettingsLoadOutcome>
  /**
   * Drains pending saves and resubmits a document that no save has confirmed. Never rejects.
   */
  flush(): Promise<void>
  status(): SettingsStatus
}

const voidSchema = z.null()

export interface SettingsServiceDeps {
  readonly ipc: IpcBridgeService
  readonly progress: ProgressPort
}

class SettingsServiceImpl implements SettingsService {
  readonly #deps: SettingsServiceDeps
  readonly #store = new WriteableStore(DEFAULT_SETTINGS, isDeepEqual)

  #state: SettingsStatus = 'loading'
  #started = false

  #preloadPatch: Partial<Settings> = {}
  #pendingUpdaters: SettingsUpdater[] = []

  #dirty = false
  #lastSubmission: Promise<void> = Promise.resolve()

  #resolveLoad: (outcome: SettingsLoadOutcome) => void = () => {}
  #loaded = new Promise<SettingsLoadOutcome>((resolve) => {
    this.#resolveLoad = resolve
  })
  #reloading: Promise<SettingsLoadOutcome> | null = null

  constructor(deps: SettingsServiceDeps) {
    this.#deps = deps
  }

  readonly get = (): Settings => {
    this.#start()
    return this.#store.get()
  }

  readonly subscribe = (listener: () => void): Unlisten => {
    this.#start()
    return this.#store.subscribe(listener)
  }

  readonly update = (patch: Partial<Settings>): void => {
    this.#start()
    if (this.#state === 'loading') {
      this.#preloadPatch = { ...this.#preloadPatch, ...patch }
      this.#store.set({ ...DEFAULT_SETTINGS, ...this.#preloadPatch })
      return
    }
    this.#apply(() => patch)
  }

  readonly updateWith = (updater: SettingsUpdater): void => {
    this.#start()
    if (this.#state === 'loading') {
      this.#pendingUpdaters.push(updater)
      return
    }
    this.#apply(updater)
  }

  readonly whenLoaded = (): Promise<SettingsLoadOutcome> => {
    this.#start()
    return this.#loaded
  }

  reload(): Promise<SettingsLoadOutcome> {
    const { ipc, progress } = this.#deps
    if (this.#state !== 'failed') {
      this.#start()
      return this.#loaded
    }
    this.#reloading ??= ipc
      .call('settings_load', {}, settingsSchema)
      .then(
        (document): SettingsLoadOutcome => {
          this.#state = 'loaded'
          // The status changed too, so notify even if the document did not.
          this.#store.set(document, false)
          this.#loaded = Promise.resolve('loaded')
          this.#store.emit()
          return 'loaded'
        },
        (error: unknown): SettingsLoadOutcome => {
          progress.fail('Loading settings', errorMessage(error))
          return 'failed'
        },
      )
      .finally(() => {
        this.#reloading = null
      })
    return this.#reloading
  }

  async flush(): Promise<void> {
    await this.#drain()
    if (this.#dirty && this.#state === 'loaded') {
      this.#submit(this.#store.get())
      await this.#drain()
    }
  }

  status(): SettingsStatus {
    return this.#state
  }

  #submit(target: Settings): void {
    const { ipc, progress } = this.#deps
    this.#dirty = true
    this.#lastSubmission = this.#lastSubmission.then(async () => {
      try {
        await ipc.call('settings_save', { settings: target }, voidSchema)
        if (this.#store.get() === target) {
          this.#dirty = false
        }
      } catch (error) {
        progress.fail('Saving settings', errorMessage(error))
      }
    })
  }

  #hydrate(outcome: SettingsLoadOutcome, document: Settings): void {
    let next: Settings = { ...document, ...this.#preloadPatch }
    const queued = this.#pendingUpdaters
    this.#pendingUpdaters = []
    this.#preloadPatch = {}
    for (const updater of queued) {
      next = { ...next, ...updater(next) }
    }
    this.#state = outcome
    if (outcome === 'loaded' && isDeepEqual(document, next)) {
      next = document
    }
    // The status changed too, so notify even if the document did not.
    this.#store.set(next, false)
    if (outcome === 'loaded' && next !== document) {
      this.#submit(next)
    }
    this.#resolveLoad(outcome)
    this.#store.emit()
  }

  #start(): void {
    const { ipc, progress } = this.#deps
    if (this.#started) {
      return
    }
    this.#started = true
    ipc.call('settings_load', {}, settingsSchema).then(
      (document) => this.#hydrate('loaded', document),
      (error: unknown) => {
        progress.fail('Loading settings', errorMessage(error))
        this.#hydrate('failed', DEFAULT_SETTINGS)
      },
    )
  }

  #apply(updater: SettingsUpdater): void {
    const previous = this.#store.get()
    const next = mergeSettings(previous, updater(previous))
    this.#store.set(next)
    if (this.#state === 'failed') {
      return
    }
    if (this.#dirty || next !== previous) {
      this.#submit(next)
    }
  }

  async #drain(): Promise<void> {
    let submission = this.#lastSubmission
    await submission
    while (submission !== this.#lastSubmission) {
      submission = this.#lastSubmission
      await submission
    }
  }
}

export function createSettingsService(deps: SettingsServiceDeps): SettingsService {
  return new SettingsServiceImpl(deps)
}

/**
 * `previous` with `patch` applied. A patched field deeply equal to its current
 * value keeps the current reference, so a reader of only that field sees no
 * change. Returns `previous` itself when no field changed.
 */
function mergeSettings(previous: Settings, patch: Partial<Settings>): Settings {
  const changed = Object.entries(patch).filter(([key, value]) => {
    return !isDeepEqual(previous[key], value)
  })
  return changed.length === 0 ? previous : { ...previous, ...Object.fromEntries(changed) }
}
