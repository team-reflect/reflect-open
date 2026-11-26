import type { Unlisten } from '../unlisten.ts'
import type { NoteSessionService } from '../documents/note-session-types.ts'
import type {
  PersistenceFlusher,
  PersistenceFlusherKind,
  PersistenceFlushService,
} from '../graph/persistence-flush-service.ts'

export type TestPersistenceFlushService = PersistenceFlushService

class TestPersistenceFlushServiceImpl implements TestPersistenceFlushService {
  readonly #flushers = new Map<PersistenceFlusherKind, PersistenceFlusher>()

  constructor(noteSessions: NoteSessionService | undefined) {
    if (noteSessions !== undefined) {
      this.#flushers.set('documents', () => noteSessions.flushAll())
    }
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
    for (const kind of ['tasks', 'documents', 'git-sync'] as const) {
      try {
        await this.#flushers.get(kind)?.()
      } catch {
        // A failed flusher never blocks the next one.
      }
    }
  }

  startFlushAll(): void {
    void this.flushAll()
  }
}

/**
 * An in-memory {@link PersistenceFlushService}.
 */
export function createTestPersistenceFlushService(deps?: {
  noteSessions?: NoteSessionService
}): TestPersistenceFlushService {
  return new TestPersistenceFlushServiceImpl(deps?.noteSessions)
}
