import { z } from 'zod'
import { errorMessage } from '../errors.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import type { Unlisten } from '../unlisten.ts'
import { DEFAULT_SETTINGS, settingsSchema, type Settings } from './schema.ts'

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
export interface SettingsService {
  /**
   * The current settings, merged over `DEFAULT_SETTINGS`. Stable until the next change.
   */
  get: () => Settings
  subscribe: (listener: () => void) => Unlisten
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
  readonly #listeners = new Set<() => void>()

  #state: SettingsStatus = 'loading'
  #started = false
  #current: Settings = DEFAULT_SETTINGS
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
    return this.#current
  }

  readonly subscribe = (listener: () => void): Unlisten => {
    this.#start()
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  readonly update = (patch: Partial<Settings>): void => {
    this.#start()
    if (this.#state === 'loading') {
      this.#preloadPatch = { ...this.#preloadPatch, ...patch }
      this.#current = { ...DEFAULT_SETTINGS, ...this.#preloadPatch }
      this.#emit()
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
          this.#current = document
          this.#loaded = Promise.resolve('loaded')
          this.#emit()
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
      this.#submit(this.#current)
      await this.#drain()
    }
  }

  status(): SettingsStatus {
    return this.#state
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      listener()
    }
  }

  #submit(target: Settings): void {
    const { ipc, progress } = this.#deps
    this.#dirty = true
    this.#lastSubmission = this.#lastSubmission.then(async () => {
      try {
        await ipc.call('settings_save', { settings: target }, voidSchema)
        if (this.#current === target) {
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
    if (outcome === 'loaded') {
      next = replaceEqualDeep(document, next)
      this.#current = next
      if (next !== document) {
        this.#submit(next)
      }
    } else {
      this.#current = next
    }
    this.#resolveLoad(outcome)
    this.#emit()
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
    const previous = this.#current
    const merged = { ...previous, ...updater(previous) }
    if (this.#state === 'failed') {
      this.#current = merged
      this.#emit()
      return
    }
    const next = replaceEqualDeep(previous, merged)
    this.#current = next
    if (next !== previous) {
      this.#emit()
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Returns `next`, reusing every part of `previous` that is deeply equal to it.
 */
function replaceEqualDeep<T>(previous: T, next: T): T {
  if (previous === next) {
    return previous
  }
  if (Array.isArray(previous) && Array.isArray(next)) {
    const before: readonly unknown[] = previous
    const after: readonly unknown[] = next
    let equal = before.length === after.length
    const copy = after.map((item, i) => {
      const shared = replaceEqualDeep(before[i], item)
      if (shared !== before[i]) {
        equal = false
      }
      return shared
    })
    return equal ? previous : (copy as T)
  }
  if (isPlainObject(previous) && isPlainObject(next)) {
    const keys = Object.keys(next)
    let equal = keys.length === Object.keys(previous).length
    const copy: Record<string, unknown> = {}
    for (const key of keys) {
      const shared = replaceEqualDeep(previous[key], next[key])
      if (shared !== previous[key] || !Object.hasOwn(previous, key)) {
        equal = false
      }
      copy[key] = shared
    }
    return equal ? previous : (copy as T)
  }
  return next
}
