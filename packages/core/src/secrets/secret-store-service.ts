import { z } from 'zod'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'

export interface SecretStoreServiceDeps {
  readonly ipc: IpcBridgeService
}

/**
 * The OS keychain. Every credential (BYOK AI keys, the GitHub backup token)
 * goes through here and only here: never into markdown, Git, `.reflect/`,
 * or the settings document. Which names exist is each domain's policy.
 */
export interface SecretStoreService {
  /**
   * The secret stored under `name`, or `null` when none exists.
   */
  get(name: string): Promise<string | null>
  /**
   * Stores `value` under `name`, replacing any prior value.
   */
  set(name: string, value: string): Promise<void>
  /**
   * Removes the secret stored under `name`; a missing entry is not an error.
   */
  delete(name: string): Promise<void>
}

/**
 * Commands that return `()` from Rust serialize as `null` over IPC.
 */
const voidSchema = z.null()

const secretSchema = z.string().nullable()

/**
 * A keychain over the `secret_get`, `secret_set` and `secret_delete` commands.
 */
class SecretStoreServiceImpl implements SecretStoreService {
  readonly #deps: SecretStoreServiceDeps

  constructor(deps: SecretStoreServiceDeps) {
    this.#deps = deps
  }

  async get(name: string): Promise<string | null> {
    return await this.#deps.ipc.call('secret_get', { name }, secretSchema)
  }

  async set(name: string, value: string): Promise<void> {
    await this.#deps.ipc.call('secret_set', { name, value }, voidSchema)
  }

  async delete(name: string): Promise<void> {
    await this.#deps.ipc.call('secret_delete', { name }, voidSchema)
  }
}

export function createSecretStoreService(deps: SecretStoreServiceDeps): SecretStoreService {
  return new SecretStoreServiceImpl(deps)
}
