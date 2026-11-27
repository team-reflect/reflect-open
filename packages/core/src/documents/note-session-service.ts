import type { MaybePromise } from '@reflect/utils'
import { checkRoundTrip } from '@meowdown/markdown'
import { deferredCreationPolicy, type NoteCreationService } from '../graph/note-creation-service.ts'
import { isDaily } from '../graph/paths.ts'
import type { FileChange, FileChangeService } from '../indexing/file-change-service.ts'
import type { Unlisten } from '../unlisten.ts'
import type { LinkedDayService } from './linked-day-service.ts'
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
  readonly noteCreation: NoteCreationService
  readonly linkedDays: LinkedDayService
  /**
   * Creates the coordinator of a note that tracks renames.
   */
  readonly createCoordinator: (path: string) => SessionCoordinator
}

interface SessionEntry {
  readonly session: ManagedNoteSession
  readonly coordinator: SessionCoordinator | null
  /**
   * Whether a view shows the session.
   */
  observed: boolean
  /**
   * Whether the note file may hold text the session has not read.
   */
  stale: boolean
  /**
   * The running catch-up.
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
    // The catch-up may have outlived the entry, or the session may have moved.
    return this.#entries.get(path) === entry ? entry.session : null
  }

  prefetch(path: string): void {
    void this.#catchUp(this.#entryFor(path))
    this.#evict()
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
    this.#entries.delete(from)
    this.#entries.set(to, entry)
    entry.session.retarget(to)
    entry.coordinator?.retarget(to)
    return entry.session
  }

  discardSession(path: string): void {
    const entry = this.#entries.get(path)
    if (entry !== undefined) {
      this.#forget(entry)
      entry.session.discard()
      entry.coordinator?.dispose()
    }
  }

  async flushAll(): Promise<void> {
    await Promise.allSettled(
      [...this.#entries.values()].map(async (entry) => {
        await this.#flushAndSettle(entry)
        await entry.coordinator?.settled()
      }),
    )
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
    const { noteCreation, createCoordinator } = this.#deps
    const policy = deferredCreationPolicy(path)
    const coordinator = policy.trackRenames ? createCoordinator(path) : null
    const session = createNoteSession(this.#deps, {
      path,
      id: this.#nextId,
      classify: checkRoundTrip,
      createIfMissing: policy.lazyCreatable,
      missingSeed: policy.seedsUntitled ? noteCreation.untitledNoteSeed() : undefined,
      onContent: (content, origin) => {
        coordinator?.content(content, origin)
        this.#ensureLinkedDays(session, content, origin)
      },
      onObservedChange: (observed) => {
        this.#observedChanged(entry, observed)
      },
    })
    this.#nextId += 1
    const entry: SessionEntry = {
      session,
      coordinator,
      observed: false,
      stale: true,
      catchingUp: null,
    }
    this.#entries.set(path, entry)
    this.#idle.add(entry)
    this.#stopFileChanges ??= this.#deps.fileChanges.subscribe(({ changes }) => {
      this.#onFileChanges(changes)
    })
    return entry
  }

  /**
   * Create the daily notes that a saved note links to, and the daily note of
   * a loaded day that has no file and that notes link to.
   */
  #ensureLinkedDays(session: NoteSession, content: string, origin: NoteContentOrigin): void {
    const generation = this.#deps.graphSession.get().session?.generation
    if (generation === undefined) {
      return
    }
    const { linkedDays } = this.#deps
    if (origin === 'saved') {
      void linkedDays.ensureLinkedDays(session.path, content, generation)
    } else if (origin === 'load' && isDaily(session.path) && session.get().missing) {
      void linkedDays.ensureLinkedDay(session.path, generation)
    }
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
    // No event reaches an unobserved session reliably: the next view checks the file.
    entry.stale = true
    void this.#flushAndSettle(entry)
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
   * Bring a stale session up to date with the note file.
   */
  #catchUp(entry: SessionEntry): Promise<void> {
    entry.catchingUp ??= this.#revalidate(entry).finally(() => {
      entry.catchingUp = null
    })
    return entry.catchingUp
  }

  async #revalidate(entry: SessionEntry): Promise<void> {
    // A change during a read makes the entry stale again.
    while (entry.stale) {
      entry.stale = false
      await entry.session.revalidate()
    }
  }

  /**
   * Flush the session, then fire its settle-time work: the rename tracker
   * must have seen the final title.
   */
  async #flushAndSettle({ session, coordinator }: SessionEntry): Promise<void> {
    await session.flush()
    coordinator?.settle()
  }

  #onFileChanges(changes: readonly FileChange[]): void {
    for (const change of changes) {
      const entry = this.#entries.get(change.path)
      if (entry === undefined) {
        continue
      }
      const { session } = entry
      if (change.kind === 'upsert') {
        this.#invalidate(entry)
      } else if (!entry.observed && !session.isDirty() && !session.isSaving()) {
        this.#drop(entry)
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

  #drop(entry: SessionEntry): void {
    const { session, coordinator } = entry
    this.#forget(entry)
    const flushed = session.dispose()
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
