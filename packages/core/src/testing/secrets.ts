import type { SecretStoreService } from '../secrets/secret-store-service.ts'

export interface TestSecretStoreService extends SecretStoreService {
  /**
   * The stored secrets, keyed by name.
   */
  snapshot(): Record<string, string>
}

class TestSecretStoreServiceImpl implements TestSecretStoreService {
  readonly #secrets: Map<string, string>

  constructor(initial: Record<string, string>) {
    this.#secrets = new Map<string, string>(Object.entries(initial))
  }

  get(name: string): Promise<string | null> {
    return Promise.resolve(this.#secrets.get(name) ?? null)
  }

  set(name: string, value: string): Promise<void> {
    this.#secrets.set(name, value)
    return Promise.resolve()
  }

  delete(name: string): Promise<void> {
    this.#secrets.delete(name)
    return Promise.resolve()
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.#secrets)
  }
}

/**
 * An in-memory {@link SecretStoreService} seeded with `initial`.
 */
export function createTestSecretStoreService(
  initial: Record<string, string> = {},
): TestSecretStoreService {
  return new TestSecretStoreServiceImpl(initial)
}
