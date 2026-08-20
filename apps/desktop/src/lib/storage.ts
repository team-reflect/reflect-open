/** localStorage and sessionStorage as sets of subscribable per-key stores. */

/**
 * One key's value, held in memory and published to subscribers. The store
 * assumes it is the only writer of its key, and treats every failure storage
 * can produce as "nothing stored".
 */
export class StorageStore {
  private readonly key: string
  private readonly storage: Storage | null
  /** The last known value; `undefined` until storage has been read once. */
  private cachedValue: string | null | undefined = undefined
  private readonly listeners = new Set<() => void>()

  constructor(key: string, storage?: Storage | null) {
    this.key = key
    this.storage = storage ?? null
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get = (): string | null => {
    if (this.cachedValue === undefined) {
      try {
        this.cachedValue = this.storage?.getItem(this.key) ?? null
      } catch (error) {
        console.error('reading storage failed', this.key, error)
        this.cachedValue = null
      }
    }
    return this.cachedValue
  }

  set = (value: string | null): void => {
    if (this.get() === value) {
      return
    }
    this.cachedValue = value
    try {
      if (value === null) {
        this.storage?.removeItem(this.key)
      } else {
        this.storage?.setItem(this.key, value)
      }
    } catch (error) {
      console.error('writing storage failed', this.key, error)
    }
    for (const listener of this.listeners) {
      listener()
    }
  }
}

const localStorageStores = new Map<string, StorageStore>()
const sessionStorageStores = new Map<string, StorageStore>()

/** The localStorage store for `key`, created on first use and shared from then on. */
export function getLocalStorageStore(key: string): StorageStore {
  const existing = localStorageStores.get(key)
  if (existing !== undefined) {
    return existing
  }
  const storage = typeof window === 'undefined' ? null : window.localStorage
  const store = new StorageStore(key, storage)
  localStorageStores.set(key, store)
  return store
}

/** The sessionStorage store for `key`, created on first use and shared from then on. */
export function getSessionStorageStore(key: string): StorageStore {
  const existing = sessionStorageStores.get(key)
  if (existing !== undefined) {
    return existing
  }
  const storage = typeof window === 'undefined' ? null : window.sessionStorage
  const store = new StorageStore(key, storage)
  sessionStorageStores.set(key, store)
  return store
}

/** Test seam: forget every store, so the next read comes from storage. */
export function resetStorageStores(): void {
  localStorageStores.clear()
  sessionStorageStores.clear()
}
