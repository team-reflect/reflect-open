import type { MaybePromise } from '@reflect/utils'
import { checkRoundTrip } from '@meowdown/markdown'
import { deferredCreationPolicy } from '../graph/note-creation-service.ts'
import type { FileChange, FileChangeService } from '../indexing/file-change-service.ts'
import type { Unlisten } from '../unlisten.ts'
import { createNoteSession, type NoteSessionDeps } from './note-session.ts'
import type {
  ManagedNoteSession,
  NoteContentOrigin,
  NoteSession,
  NoteSessionService,
} from './note-session-types.ts'

/**
 * How many unobserved sessions the service keeps.
 */
const MAX_IDLE_SESSIONS = 32

/**
 * The settle-time work of one session: the title rename that follows its saves.
 */
export interface SessionCoordinator {
  /**
   * Receives the session's known-on-disk content.
   */
  content(content: string, origin: NoteContentOrigin): void
  /**
   * A settle point (blur, last view gone, quit): fire any pending work now.
   */
  settle(): void
  /**
   * Resolves once fired settle-time work has landed.
   */
  settled(): MaybePromise<void>
  /**
   * The note moved to `path`.
   */
  retarget(path: string): void
  dispose(): void
}

export interface NoteSessionServiceDeps extends NoteSessionDeps {
  readonly fileChanges: FileChangeService
  /**
   * The buffer seed of a note born untitled.
   */
  readonly untitledNoteSeed: () => string
  /**
   * Creates the coordinator of a note that tracks renames.
   */
  readonly createCoordinator: (path: string) => SessionCoordinator
}

interface SessionEntry {
  readonly session: ManagedNoteSession
  readonly coordinator: SessionCoordinator | null
  /**
   * Whether the session has a subscriber.
   */
  observed: boolean
  /**
   * Whether the initial load has started.
   */
  loaded: boolean
  /**
   * Whether the note file may have changed since the session last read it.
   */
  stale: boolean
  /**
   * The running catch-up of a stale session.
   */
  catchingUp: Promise<void> | null
}

class NoteSessionServiceImpl implements NoteSessionService {
  readonly #deps: NoteSessionServiceDeps
  readonly #entries = new Map<string, SessionEntry>()
  /**
   * The unobserved entries, least recently observed first.
   */
  readonly #idle = new Set<SessionEntry>()
  #nextId = 1
  #stopFileChanges: Unlisten | null = null

  constructor(deps: NoteSessionServiceDeps) {
    this.#deps = deps
  }

  sessionFor(path: string): NoteSession {
    return this.#entryFor(path).session
  }

  existingSessionFor(path: string): NoteSession | null {
    return this.#entries.get(path)?.session ?? null
  }

  async currentSessionFor(path: string): Promise<NoteSession | null> {
    const entry = this.#entries.get(path)
    if (entry === undefined) {
      return null
    }
    await this.#catchUp(entry)
    // The catch-up may have outlived the entry.
    return this.#entries.get(path)?.session ?? null
  }

  prefetch(path: string): void {
    void this.#catchUp(this.#entryFor(path))
  }

  dirtyPaths(): string[] {
    return [...this.#entries.values()]
      .filter((entry) => entry.session.isDirty())
      .map((entry) => entry.session.path)
  }

  invalidate(path: string): void {
    const entry = this.#entries.get(path)
    if (entry !== undefined) {
      this.#invalidate(entry)
    }
  }

  invalidateAll(): void {
    for (const entry of this.#entries.values()) {
      this.#invalidate(entry)
    }
  }

  moveSession(from: string, to: string): NoteSession | null {
    const entry = this.#entries.get(from)
    if (entry === undefined) {
      return null
    }
    const occupant = this.#entries.get(to)
    if (occupant !== undefined) {
      this.#drop(occupant)
    }
    entry.session.retarget(to)
    entry.coordinator?.retarget(to)
    this.#entries.delete(from)
    this.#entries.set(to, entry)
    return entry.session
  }

  async flushAll(): Promise<void> {
    await Promise.allSettled(
      [...this.#entries.values()].map(async ({ session, coordinator }) => {
        await session.flush()
        // Settle after the flush so the rename tracker has seen the final title;
        // settle() appends the rewrite synchronously, settled() awaits it.
        coordinator?.settle()
        await coordinator?.settled()
      }),
    )
  }

  settleAll(): void {
    for (const entry of this.#entries.values()) {
      this.#settle(entry)
    }
  }

  releaseAll(): void {
    for (const entry of this.#entries.values()) {
      this.#drop(entry)
    }
  }

  #entryFor(path: string): SessionEntry {
    const existing = this.#entries.get(path)
    if (existing !== undefined) {
      return existing
    }
    const { untitledNoteSeed, createCoordinator } = this.#deps
    const policy = deferredCreationPolicy(path)
    const coordinator = policy.trackRenames ? createCoordinator(path) : null
    const session = createNoteSession(this.#deps, {
      path,
      id: this.#nextId,
      classify: checkRoundTrip,
      createIfMissing: policy.lazyCreatable,
      missingSeed: policy.seedsUntitled ? untitledNoteSeed() : undefined,
      onContent: coordinator
        ? (content, origin) => coordinator.content(content, origin)
        : undefined,
      onObservedChange: (observed) => {
        this.#observedChanged(entry, observed)
      },
      onDiscard: () => {
        this.#forget(entry)
        coordinator?.dispose()
      },
    })
    this.#nextId += 1
    const entry: SessionEntry = {
      session,
      coordinator,
      observed: false,
      loaded: false,
      stale: false,
      catchingUp: null,
    }
    this.#entries.set(path, entry)
    this.#idle.add(entry)
    this.#stopFileChanges ??= this.#deps.fileChanges.subscribe(({ changes }) => {
      this.#onFileChanges(changes)
    })
    this.#evict()
    return entry
  }

  #observedChanged(entry: SessionEntry, observed: boolean): void {
    entry.observed = observed
    if (observed) {
      this.#idle.delete(entry)
      void this.#catchUp(entry)
      return
    }
    if (this.#entries.get(entry.session.path) !== entry) {
      return
    }
    this.#idle.add(entry)
    this.#settle(entry)
    this.#evict()
  }

  #invalidate(entry: SessionEntry): void {
    if (entry.observed) {
      entry.session.externalChanged()
    } else {
      entry.stale = true
    }
  }

  /**
   * Load a session that has not loaded, and bring a stale or failed one up to date.
   */
  #catchUp(entry: SessionEntry): Promise<void> {
    const { session } = entry
    if (!entry.loaded) {
      entry.loaded = true
      entry.stale = false
      session.load()
      return Promise.resolve()
    }
    if (entry.catchingUp !== null) {
      return entry.catchingUp
    }
    if (!entry.stale && session.get().status !== 'error') {
      return Promise.resolve()
    }
    entry.stale = false
    const catchingUp = session.revalidate().finally(() => {
      entry.catchingUp = null
    })
    entry.catchingUp = catchingUp
    return catchingUp
  }

  /**
   * Flush the session, then fire its settle-time work.
   */
  #settle({ session, coordinator }: SessionEntry): void {
    void session.flush().then(() => coordinator?.settle())
  }

  #onFileChanges(changes: readonly FileChange[]): void {
    for (const change of changes) {
      const entry = this.#entries.get(change.path)
      if (entry === undefined) {
        continue
      }
      const { session } = entry
      if (entry.observed) {
        if (change.kind === 'upsert') {
          session.externalChanged()
        }
      } else if (change.kind === 'remove' && !session.isDirty() && !session.isSaving()) {
        this.#drop(entry)
      } else {
        entry.stale = true
      }
    }
  }

  /**
   * Dispose the least recently observed clean sessions beyond the idle limit.
   */
  #evict(): void {
    let excess = this.#idle.size - MAX_IDLE_SESSIONS
    for (const entry of this.#idle) {
      if (excess <= 0) {
        return
      }
      if (entry.session.isDirty() || entry.session.isSaving()) {
        continue
      }
      this.#drop(entry)
      excess -= 1
    }
  }

  /**
   * Flush and dispose the session, then settle and dispose its coordinator.
   */
  #drop(entry: SessionEntry): void {
    const { session, coordinator } = entry
    this.#forget(entry)
    const flushed = session.flush()
    session.dispose()
    if (coordinator !== null) {
      void flushed.then(() => {
        coordinator.settle()
        coordinator.dispose()
      })
    }
  }

  #forget(entry: SessionEntry): void {
    this.#idle.delete(entry)
    if (this.#entries.get(entry.session.path) === entry) {
      this.#entries.delete(entry.session.path)
    }
    if (this.#entries.size === 0) {
      this.#stopFileChanges?.()
      this.#stopFileChanges = null
    }
  }
}

export function createNoteSessionService(deps: NoteSessionServiceDeps): NoteSessionService {
  return new NoteSessionServiceImpl(deps)
}
