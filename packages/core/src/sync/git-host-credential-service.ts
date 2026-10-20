import { z } from 'zod'
import { errorMessage } from '../errors.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { SecretStoreService } from '../secrets/secret-store-service.ts'
import type { Unlisten } from '../unlisten.ts'
import type { GitCredential } from './git-repository-service.ts'

const credentialSchema = z.object({ username: z.string().min(1), secret: z.string().min(1) })

/**
 * The keychain entry holding the sign-in of one origin, e.g.
 * `git-credential:https://gitlab.com`.
 */
export function hostCredentialSecretName(origin: string): string {
  return `git-credential:${origin}`
}

/**
 * Sign-ins for HTTPS git hosts other than github.com, one per origin
 * (scheme, host and port, so an `https` sign-in is never sent in the clear to
 * the `http` form of the same host). The GitHub sign-in is not here: it has a
 * refresh token and lives under `GITHUB_AUTH_SECRET`. Two stores with two
 * names, so one host's secret can never be read for another.
 */
export interface GitHostCredentialService {
  /**
   * The stored sign-in of `origin`, or `null` when absent or unreadable.
   */
  load(origin: string): Promise<GitCredential | null>
  /**
   * Stores the sign-in of `origin`, replacing any prior one, and notifies subscribers.
   */
  save(origin: string, credential: GitCredential): Promise<void>
  /**
   * Removes the sign-in of `origin` and notifies subscribers; a missing entry is not an error.
   */
  delete(origin: string): Promise<void>
  /**
   * Called after a save or delete.
   */
  subscribe: (listener: () => void) => Unlisten
}

export interface GitHostCredentialServiceDeps {
  readonly secretStore: SecretStoreService
  readonly logger: LoggerService
}

class GitHostCredentialServiceImpl implements GitHostCredentialService {
  readonly #deps: GitHostCredentialServiceDeps
  readonly #listeners = new Set<() => void>()

  constructor(deps: GitHostCredentialServiceDeps) {
    this.#deps = deps
  }

  async load(origin: string): Promise<GitCredential | null> {
    const { secretStore, logger } = this.#deps
    let raw: string | null
    try {
      raw = await secretStore.get(hostCredentialSecretName(origin))
    } catch (error) {
      // A keychain the app cannot read is, for syncing, one with no entry.
      logger.error(`reading the sign-in for ${origin} failed:`, errorMessage(error))
      return null
    }
    if (raw === null) {
      return null
    }
    const parsed = credentialSchema.safeParse(parseJson(raw))
    if (!parsed.success) {
      logger.error(`the stored sign-in for ${origin} is unreadable; treating it as absent`)
      return null
    }
    return parsed.data
  }

  async save(origin: string, credential: GitCredential): Promise<void> {
    const validated = credentialSchema.parse(credential)
    await this.#deps.secretStore.set(hostCredentialSecretName(origin), JSON.stringify(validated))
    this.#notify()
  }

  async delete(origin: string): Promise<void> {
    await this.#deps.secretStore.delete(hostCredentialSecretName(origin))
    this.#notify()
  }

  readonly subscribe = (listener: () => void): Unlisten => {
    // Wrapped for identity, so one function added twice detaches independently.
    const deliver = (): void => {
      listener()
    }
    this.#listeners.add(deliver)
    return () => {
      this.#listeners.delete(deliver)
    }
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener()
    }
  }
}

export function createGitHostCredentialService(
  deps: GitHostCredentialServiceDeps,
): GitHostCredentialService {
  return new GitHostCredentialServiceImpl(deps)
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}
