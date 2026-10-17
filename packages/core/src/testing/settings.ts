import type { ProgressPort } from '../ports/progress-port.ts'
import { AppError } from '../errors.ts'
import type { Unlisten } from '../unlisten.ts'
import type { Settings } from '../settings/schema.ts'
import {
  createSettingsService,
  type SettingsLoadOutcome,
  type SettingsService,
  type SettingsStatus,
} from '../settings/settings-service.ts'
import { createTestIpcBridgeService, type TestIpcBridgeService } from './ipc.ts'
import { createTestProgressPort } from './ports.ts'

/**
 * The real {@link SettingsService} over an in-memory settings document.
 */
export interface TestSettingsService extends SettingsService {
  /**
   * Answers `settings_load` and `settings_save`; register handlers to gate them.
   */
  readonly ipc: TestIpcBridgeService
  /**
   * Every document a save persisted, oldest first.
   */
  saves(): Settings[]
  /**
   * Makes the next `settings_save` reject with an `io` error.
   */
  failNextSave(): void
  /**
   * Makes the load reject with an `io` error. Call before the first read.
   */
  failLoad(): void
  /**
   * Merges `patch` into the stored document. Throws once the load has read it.
   */
  seed(patch: Partial<Settings>): void
}

class TestSettingsServiceImpl implements TestSettingsService {
  readonly ipc: TestIpcBridgeService
  readonly #inner: SettingsService
  readonly #saved: Settings[] = []
  #stored: Partial<Settings>
  #loadStarted = false
  #failSave = false
  #loadFails = false

  constructor(initial: Partial<Settings> | undefined, progress: ProgressPort) {
    this.#stored = { ...initial }
    this.ipc = createTestIpcBridgeService({
      commands: {
        settings_load: () => {
          this.#loadStarted = true
          if (this.#loadFails) {
            throw new AppError('io', 'test settings: load failed')
          }
          return this.#saved.at(-1) ?? { ...this.#stored }
        },
        settings_save: (args) => {
          if (this.#failSave) {
            this.#failSave = false
            throw new AppError('io', 'test settings: save failed')
          }
          this.#saved.push(args['settings'] as Settings)
          return null
        },
      },
    })
    this.#inner = createSettingsService({ ipc: this.ipc, progress })
  }

  readonly get = (): Settings => this.#inner.get()

  readonly subscribe = (listener: () => void): Unlisten => this.#inner.subscribe(listener)

  readonly update = (patch: Partial<Settings>): void => {
    this.#inner.update(patch)
  }

  readonly updateWith = (updater: (current: Settings) => Partial<Settings>): void => {
    this.#inner.updateWith(updater)
  }

  readonly whenLoaded = (): Promise<SettingsLoadOutcome> => {
    return this.#inner.whenLoaded()
  }

  reload(): Promise<SettingsLoadOutcome> {
    return this.#inner.reload()
  }

  flush(): Promise<void> {
    return this.#inner.flush()
  }

  status(): SettingsStatus {
    return this.#inner.status()
  }

  saves(): Settings[] {
    return [...this.#saved]
  }

  failNextSave(): void {
    this.#failSave = true
  }

  failLoad(): void {
    this.#loadFails = true
  }

  seed(patch: Partial<Settings>): void {
    if (this.#loadStarted) {
      throw new Error('test settings: seed() must come before the first read')
    }
    this.#stored = { ...this.#stored, ...patch }
  }
}

/**
 * A {@link SettingsService} whose stored document starts as `initial`. The
 * load starts at the first read, so `failLoad()` and handler overrides must
 * come before it.
 */
export function createTestSettingsService(
  initial?: Partial<Settings>,
  deps?: { progress?: ProgressPort | undefined },
): TestSettingsService {
  return new TestSettingsServiceImpl(initial, deps?.progress ?? createTestProgressPort())
}
