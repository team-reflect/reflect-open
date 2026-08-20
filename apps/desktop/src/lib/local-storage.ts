/** localStorage as a set of subscribable per-key stores. */

function read(key: string): string | null {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    return window.localStorage.getItem(key)
  } catch (error) {
    console.error('reading localStorage failed', key, error)
    return null
  }
}

function write(key: string, value: string | null): void {
  if (typeof window === 'undefined') {
    return
  }
  try {
    if (value === null) {
      window.localStorage.removeItem(key)
    } else {
      window.localStorage.setItem(key, value)
    }
  } catch (error) {
    console.error('writing localStorage failed', key, error)
  }
}

/**
 * One key's value, held in memory and published to subscribers. The store
 * assumes it is the only writer of its key.
 */
export class LocalStorageStore {
  private readonly key: string
  /** The last known value; `undefined` until storage has been read once. */
  private cachedValue: string | null | undefined = undefined
  private readonly listeners = new Set<() => void>()

  constructor(key: string) {
    this.key = key
  }

  // Fields, not methods, so they can be passed around unbound.
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get = (): string | null => {
    if (this.cachedValue === undefined) {
      this.cachedValue = read(this.key)
    }
    return this.cachedValue
  }

  set = (value: string | null): void => {
    if (this.get() === value) {
      return
    }
    this.cachedValue = value
    write(this.key, value)
    for (const listener of this.listeners) {
      listener()
    }
  }
}

const stores = new Map<string, LocalStorageStore>()

/** The store for `key`, created on first use and shared from then on. */
export function getLocalStorageStore(key: string): LocalStorageStore {
  const existing = stores.get(key)
  if (existing !== undefined) {
    return existing
  }
  const store = new LocalStorageStore(key)
  stores.set(key, store)
  return store
}

/** Test seam: forget every store, so the next read comes from storage. */
export function resetLocalStorageStores(): void {
  stores.clear()
}
