import type { KeyValueStore, StorageService } from '../ports/storage-service.ts'
import { type Store, WritableStore } from '../store.ts'

export interface TestStorageService extends StorageService {
  /**
   * A snapshot of every stored key in both areas.
   */
  dump(): { local: Record<string, string>; session: Record<string, string> }
}

class MemoryStore implements KeyValueStore {
  readonly #stores: Map<string, WritableStore<string | null>>

  constructor(initial: Record<string, string>) {
    this.#stores = new Map(
      Object.entries(initial).map(([key, value]) => [key, new WritableStore<string | null>(value)]),
    )
  }

  get(key: string): string | null {
    return this.#store(key).get()
  }

  set(key: string, value: string | null): void {
    this.#store(key).set(value)
  }

  store(key: string): Store<string | null> {
    return this.#store(key)
  }

  dump(): Record<string, string> {
    const values: Record<string, string> = {}
    for (const [key, store] of this.#stores) {
      const value = store.get()
      if (value !== null) {
        values[key] = value
      }
    }
    return values
  }

  #store(key: string): WritableStore<string | null> {
    let store = this.#stores.get(key)
    if (!store) {
      store = new WritableStore<string | null>(null)
      this.#stores.set(key, store)
    }
    return store
  }
}

class TestStorageServiceImpl implements TestStorageService {
  readonly local: MemoryStore
  readonly session: MemoryStore

  constructor(initial: { local?: Record<string, string>; session?: Record<string, string> }) {
    this.local = new MemoryStore(initial.local ?? {})
    this.session = new MemoryStore(initial.session ?? {})
  }

  dump(): { local: Record<string, string>; session: Record<string, string> } {
    return { local: this.local.dump(), session: this.session.dump() }
  }
}

/**
 * In-memory local and session storage, seeded from `initial`.
 */
export function createTestStorageService(
  initial: { local?: Record<string, string>; session?: Record<string, string> } = {},
): TestStorageService {
  return new TestStorageServiceImpl(initial)
}
