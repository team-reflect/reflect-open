import type { AppInfoService } from '../ports/app-info-service.ts'
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

  async get(name: string): Promise<string | null> {
    return this.#secrets.get(name) ?? null
  }

  async set(name: string, value: string): Promise<void> {
    this.#secrets.set(name, value)
  }

  async delete(name: string): Promise<void> {
    this.#secrets.delete(name)
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

class TestAppInfoServiceImpl implements AppInfoService {
  readonly #version: string

  constructor(version: string) {
    this.#version = version
  }

  version(): string {
    return this.#version
  }
}

/**
 * An {@link AppInfoService} that reports `version`.
 */
export function createTestAppInfoService(version = '0.0.0-test'): AppInfoService {
  return new TestAppInfoServiceImpl(version)
}
