import { z } from 'zod'
import { errorMessage } from '../errors.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import { WritableStore, type Store } from '../store.ts'
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
 * The global settings document: loaded once, updates visible immediately,
 * saves persisted one at a time. When the load fails, updates stay
 * session-only so a defaults-built save never overwrites the stored document.
 */
export interface SettingsService extends Store<Settings> {
  /**
   * Merges `patch` now and persists the full document in the background.
   */
  update: (patch: Partial<Settings>) => void
  /**
   * Merges the patch that `updater` builds from the latest settings. Calls made
   * while loading replay over the loaded document, so `updater` must be pure.
   */
  updateWith: (updater: SettingsUpdater) => void
  whenLoaded: () => Promise<SettingsLoadOutcome>
  /**
   * After a failed load, loads the stored document again; on success it
   * replaces the session-only settings. Otherwise answers {@link whenLoaded}.
   */
  reload: () => Promise<SettingsLoadOutcome>
  /**
   * Waits for pending saves and resubmits settings that no save confirmed. Never rejects.
   */
  flush: () => Promise<void>
  /**
   * Whether the stored document is loaded. Changes after the settings it brings.
   */
  readonly status: Store<SettingsStatus>
}

const voidSchema = z.null()

export interface SettingsServiceDeps {
  readonly ipc: IpcBridgeService
  readonly progress: ProgressPort
}

class SettingsServiceImpl implements SettingsService {
  readonly #deps: SettingsServiceDeps
  readonly #store = new WritableStore(DEFAULT_SETTINGS)
  readonly #status = new WritableStore<SettingsStatus>('loading')
  #loading: Promise<SettingsLoadOutcome> | undefined
  /**
   * Updates made while loading, replayed over the loaded document.
   */
  #pending: SettingsUpdater[] = []
  /**
   * The settings that the disk holds, as far as this service knows.
   */
  #saved?: Settings
  #saving: Promise<void> = Promise.resolve()

  constructor(deps: SettingsServiceDeps) {
    this.#deps = deps
  }

  readonly get = (): Settings => {
    void this.#load()
    return this.#store.get()
  }

  readonly subscribe = (listener: VoidFunction): Unlisten => {
    void this.#load()
    return this.#store.subscribe(listener)
  }

  readonly update = (patch: Partial<Settings>): void => {
    this.updateWith(() => patch)
  }

  readonly updateWith = (updater: SettingsUpdater): void => {
    const previous = this.get()
    this.#store.set(mergeSettings(previous, updater(previous)))
    if (this.#status.get() === 'loading') {
      this.#pending.push(updater)
    }
    this.#save()
  }

  readonly whenLoaded = (): Promise<SettingsLoadOutcome> => this.#load()

  readonly reload = (): Promise<SettingsLoadOutcome> => {
    if (this.#status.get() === 'failed') {
      this.#status.set('loading')
      this.#loading = undefined
    }
    return this.#load()
  }

  readonly flush = async (): Promise<void> => {
    await this.#drain()
    this.#save()
    await this.#drain()
  }

  readonly status: Store<SettingsStatus> = this.#status

  #load(): Promise<SettingsLoadOutcome> {
    const { ipc, progress } = this.#deps
    this.#loading ??= ipc.call('settings_load', {}, settingsSchema).then(
      (document) => {
        this.#saved = document
        const settings = this.#pending.reduce(
          (s, updater) => mergeSettings(s, updater(s)),
          document,
        )
        return this.#settle('loaded', settings)
      },
      (error: unknown) => {
        progress.fail('Loading settings', errorMessage(error))
        // Every pending update is already visible.
        return this.#settle('failed', this.#store.get())
      },
    )
    return this.#loading
  }

  #settle(status: SettingsLoadOutcome, settings: Settings): SettingsLoadOutcome {
    this.#pending = []
    // Settings first, so a status listener reads the settings that came with it.
    this.#store.set(settings)
    this.#status.set(status)
    this.#save()
    return status
  }

  #save(): void {
    const { ipc, progress } = this.#deps
    const settings = this.#store.get()
    if (this.#status.get() !== 'loaded' || settings === this.#saved) {
      return
    }
    this.#saving = this.#saving.then(async () => {
      try {
        await ipc.call('settings_save', { settings }, voidSchema)
        this.#saved = settings
      } catch (error) {
        progress.fail('Saving settings', errorMessage(error))
      }
    })
  }

  async #drain(): Promise<void> {
    let saving: Promise<void>
    do {
      saving = this.#saving
      await saving
    } while (saving !== this.#saving)
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
