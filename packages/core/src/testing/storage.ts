import { DefaultMap } from '@ocavue/utils'
import type { KeyValueStore, StorageService } from '../ports/storage-service.ts'
import { type Store, WritableStore } from '../store.ts'

export interface TestStorageService extends StorageService {
  /**
   * A snapshot of every stored key in both areas.
   */
  dump(): { local: Record<string, string>; session: Record<string, string> }
}

class MemoryStore implements KeyValueStore {
  readonly #stores: DefaultMap<string, WritableStore<string | null>>

  constructor(initial: Record<string, string>) {
    this.#stores = new DefaultMap(
      () => new WritableStore<string | null>(null),
      Object.entries(initial).map(([key, value]) => [key, new WritableStore<string | null>(value)]),
    )
  }

  get(key: string): string | null {
    return this.#stores.get(key).get()
  }

  set(key: string, value: string | null): void {
    this.#stores.get(key).set(value)
  }

  store(key: string): Store<string | null> {
    return this.#stores.get(key)
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
