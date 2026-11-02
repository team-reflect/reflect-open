import { z } from 'zod'
import { errorMessage } from '../errors.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import { deriveStore, WritableStore, type Store } from '../store.ts'
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
   * Whether the stored document is loaded. Changes together with the settings it brings.
   */
  readonly status: Store<SettingsStatus>
}

const voidSchema = z.null()

export interface SettingsServiceDeps {
  readonly ipc: IpcBridgeService
  readonly progress: ProgressPort
}

interface SettingsState {
  readonly settings: Settings
  readonly status: SettingsStatus
}

function selectSettings(state: SettingsState): Settings {
  return state.settings
}

function selectStatus(state: SettingsState): SettingsStatus {
  return state.status
}

class SettingsServiceImpl implements SettingsService {
  readonly #deps: SettingsServiceDeps
  /**
   * One store, so the settings and the status change together.
   */
  readonly #state = new WritableStore<SettingsState>({
    settings: DEFAULT_SETTINGS,
    status: 'loading',
  })
  readonly #settings = deriveStore(this.#state, selectSettings, isDeepEqual)
  readonly status = deriveStore(this.#state, selectStatus)
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
    return this.#settings.get()
  }

  readonly subscribe = (listener: VoidFunction): Unlisten => {
    void this.#load()
    return this.#settings.subscribe(listener)
  }

  readonly update = (patch: Partial<Settings>): void => {
    this.updateWith(() => patch)
  }

  readonly updateWith = (updater: SettingsUpdater): void => {
    const settings = this.get()
    this.#setState({ settings: { ...settings, ...updater(settings) } })
    if (this.status.get() === 'loading') {
      this.#pending.push(updater)
    }
    this.#save()
  }

  readonly whenLoaded = (): Promise<SettingsLoadOutcome> => this.#load()

  readonly reload = (): Promise<SettingsLoadOutcome> => {
    if (this.status.get() === 'failed') {
      this.#setState({ status: 'loading' })
      this.#loading = undefined
    }
    return this.#load()
  }

  readonly flush = async (): Promise<void> => {
    await this.#drain()
    this.#save()
    await this.#drain()
  }

  #load(): Promise<SettingsLoadOutcome> {
    const { ipc, progress } = this.#deps
    this.#loading ??= ipc.call('settings_load', {}, settingsSchema).then(
      (document) => {
        this.#saved = document
        const settings = this.#pending.reduce((s, updater) => ({ ...s, ...updater(s) }), document)
        return this.#settle('loaded', settings)
      },
      (error: unknown) => {
        progress.fail('Loading settings', errorMessage(error))
        // Every pending update is already visible.
        return this.#settle('failed', this.#settings.get())
      },
    )
    return this.#loading
  }

  #settle(status: SettingsLoadOutcome, settings: Settings): SettingsLoadOutcome {
    this.#pending = []
    this.#setState({ status, settings })
    this.#save()
    return status
  }

  #setState(patch: Partial<SettingsState>): void {
    this.#state.set({ ...this.#state.get(), ...patch })
  }

  #save(): void {
    const { ipc, progress } = this.#deps
    const settings = this.#settings.get()
    if (this.status.get() !== 'loaded' || isDeepEqual(settings, this.#saved)) {
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
