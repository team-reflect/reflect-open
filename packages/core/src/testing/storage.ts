import type { KeyValueStore, StorageService } from '../ports/storage-service.ts'

export interface TestStorageService extends StorageService {
  /**
   * A snapshot of every stored key in both areas.
   */
  dump(): { local: Record<string, string>; session: Record<string, string> }
}

class MemoryStore implements KeyValueStore {
  readonly #values: Map<string, string>
  readonly #listeners = new Map<string, Set<() => void>>()

  constructor(initial: Record<string, string>) {
    this.#values = new Map(Object.entries(initial))
  }

  get(key: string): string | null {
    return this.#values.get(key) ?? null
  }

  set(key: string, value: string | null): void {
    if ((this.#values.get(key) ?? null) === value) {
      return
    }
    if (value === null) {
      this.#values.delete(key)
    } else {
      this.#values.set(key, value)
    }
    for (const listener of this.#listeners.get(key) ?? []) {
      listener()
    }
  }

  subscribe(key: string, listener: () => void): () => void {
    const keyListeners = this.#listeners.get(key) ?? new Set<() => void>()
    this.#listeners.set(key, keyListeners)
    keyListeners.add(listener)
    return () => {
      keyListeners.delete(listener)
    }
  }

  dump(): Record<string, string> {
    return Object.fromEntries(this.#values)
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
