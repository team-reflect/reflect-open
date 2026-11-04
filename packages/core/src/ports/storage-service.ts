import type { ZodType } from 'zod'
import { safeParseJson } from '@reflect/utils'
import { type Store, WritableStore } from '../store.ts'
import type { LoggerService } from './logger-service.ts'

/**
 * One string-valued key-value area whose keys can be observed.
 */
export interface KeyValueStore {
  /**
   * The stored value, or `null` when nothing is stored or storage could not be read.
   */
  get(key: string): string | null
  /**
   * Stores `value`; `null` removes the key.
   */
  set(key: string, value: string | null): void
  /**
   * The value of `key` as a `Store`. The same key returns the same store.
   */
  store(key: string): Store<string | null>
}

/**
 * Key-value storage that outlives a page (`local`) or a session (`session`).
 */
export interface StorageService {
  readonly local: KeyValueStore
  readonly session: KeyValueStore
}

/**
 * A store over a Web `Storage`. Reads are cached in memory, and listeners
 * only hear writes made through this store. A failing `Storage` degrades to
 * the in-memory cache and logs one warning.
 */
class WebKeyValueStore implements KeyValueStore {
  readonly #logger: LoggerService
  readonly #name: string
  readonly #storage: Storage | null
  readonly #stores = new Map<string, WritableStore<string | null>>()
  #warned = false

  constructor(logger: LoggerService, name: string, storage: Storage | null) {
    this.#logger = logger
    this.#name = name
    this.#storage = storage
  }

  get(key: string): string | null {
    return this.#store(key).get()
  }

  set(key: string, value: string | null): void {
    const storage = this.#storage
    // Writes go through even when unchanged, since other windows share the area.
    try {
      if (value === null) {
        storage?.removeItem(key)
      } else {
        storage?.setItem(key, value)
      }
    } catch (error) {
      this.#warn('writing', key, error)
    }
    this.#store(key).set(value)
  }

  store(key: string): Store<string | null> {
    return this.#store(key)
  }

  #store(key: string): WritableStore<string | null> {
    let store = this.#stores.get(key)
    if (!store) {
      let value: string | null = null
      try {
        value = this.#storage?.getItem(key) ?? null
      } catch (error) {
        this.#warn('reading', key, error)
      }
      store = new WritableStore(value)
      this.#stores.set(key, store)
    }
    return store
  }

  #warn(action: string, key: string, error: unknown): void {
    if (this.#warned) {
      return
    }
    this.#warned = true
    this.#logger.warn(`${action} ${this.#name} storage failed for ${key}`, error)
  }
}

export interface WebStorageServiceDeps {
  readonly logger: LoggerService
  readonly localStorage: Storage | null
  readonly sessionStorage: Storage | null
}

class WebStorageServiceImpl implements StorageService {
  readonly local: KeyValueStore
  readonly session: KeyValueStore

  constructor(deps: WebStorageServiceDeps) {
    this.local = new WebKeyValueStore(deps.logger, 'local', deps.localStorage)
    this.session = new WebKeyValueStore(deps.logger, 'session', deps.sessionStorage)
  }
}

/**
 * Storage backed by Web `localStorage` and `sessionStorage`; `null` keeps an area in memory.
 */
export function createWebStorageService(deps: WebStorageServiceDeps): StorageService {
  return new WebStorageServiceImpl(deps)
}

/**
 * Parses the JSON stored at `key`; `undefined` when it is missing, malformed, or fails `schema`.
 */
export function getJson<T>(store: KeyValueStore, key: string, schema: ZodType<T>): T | undefined {
  const result = schema.safeParse(safeParseJson(store.get(key) ?? ''))
  return result.success ? result.data : undefined
}

/**
 * Stores `value` as JSON at `key`; does nothing when it fails `schema`.
 */
export function setJson<T>(store: KeyValueStore, key: string, schema: ZodType<T>, value: T): void {
  const result = schema.safeParse(value)
  if (result.success) {
    store.set(key, JSON.stringify(result.data))
  }
}

/**
 * The `window` Web storage area `name`, or `null` when there is no `window` or reaching it fails.
 */
export function reachWebStorage(
  logger: LoggerService,
  name: 'localStorage' | 'sessionStorage',
): Storage | null {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    return window[name]
  } catch (error) {
    logger.warn(`reaching ${name} failed`, error)
    return null
  }
}
