import type { OpenDocumentsService } from '../documents/open-documents-service.ts'
import type { Unlisten } from '../unlisten.ts'
import type { SettingsService } from '../settings/settings-service.ts'
import type { LoggerService } from '../ports/logger-service.ts'

/**
 * The dirty state a registered flusher lands. Settings is built in.
 */
export type PersistenceFlusherKind = 'documents' | 'git-sync'

export type PersistenceFlusher = () => Promise<void>

/**
 * Lands dirty state before the app exits or the OS suspends it: note buffers
 * and settings first, then the local backup commit, so the commit captures
 * them. A backup flusher makes a local commit only, never a push, which
 * could stall the exit.
 */
export interface PersistenceFlushService {
  /**
   * Install the flusher of `kind`, replacing the previous one. The returned
   * function removes it if it is still installed.
   */
  registerFlusher(kind: PersistenceFlusherKind, fn: PersistenceFlusher): Unlisten
  /**
   * Documents and settings in parallel, then backup. Never rejects; failures are logged.
   */
  flushAll(): Promise<void>
  /**
   * Start every flush at once without waiting for any, for a page unload.
   * Never rejects; failures are logged.
   */
  startFlushAll(): void
}

export interface PersistenceFlushServiceDeps {
  readonly settings: SettingsService
  readonly openDocuments: OpenDocumentsService
  readonly logger: LoggerService
}

class PersistenceFlushServiceImpl implements PersistenceFlushService {
  readonly #deps: PersistenceFlushServiceDeps
  readonly #flushers: Map<PersistenceFlusherKind, PersistenceFlusher>

  constructor(deps: PersistenceFlushServiceDeps) {
    this.#deps = deps
    this.#flushers = new Map<PersistenceFlusherKind, PersistenceFlusher>([
      ['documents', () => deps.openDocuments.flushAll()],
    ])
  }

  registerFlusher(kind: PersistenceFlusherKind, fn: PersistenceFlusher): Unlisten {
    this.#flushers.set(kind, fn)
    return () => {
      if (this.#flushers.get(kind) === fn) {
        this.#flushers.delete(kind)
      }
    }
  }

  async flushAll(): Promise<void> {
    const { settings } = this.#deps
    await Promise.allSettled([
      this.#run('documents', this.#flushers.get('documents')),
      this.#run('settings', () => settings.flush()),
    ])
    await this.#run('git-sync', this.#flushers.get('git-sync'))
  }

  startFlushAll(): void {
    const { settings } = this.#deps
    void this.#run('documents', this.#flushers.get('documents'))
    void this.#run('settings', () => settings.flush())
    void this.#run('git-sync', this.#flushers.get('git-sync'))
  }

  async #run(what: string, fn: (() => Promise<void>) | undefined): Promise<void> {
    try {
      await fn?.()
    } catch (cause) {
      this.#deps.logger.error(`${what} flush failed:`, cause)
    }
  }
}

export function createPersistenceFlushService(
  deps: PersistenceFlushServiceDeps,
): PersistenceFlushService {
  return new PersistenceFlushServiceImpl(deps)
}
