import { noop } from '@ocavue/utils'
import { sha256HexSync } from '@reflect/utils'
import type { Unlisten } from '../unlisten.ts'
import {
  createNoteMoveService,
  type NoteMovedListener,
  type NoteMoveService,
  type NoteMoveServiceDeps,
} from '../documents/note-move-service.ts'
import {
  frontmatterPatchToYaml,
  type FrontmatterPatch,
} from '../documents/note-session-frontmatter.ts'
import type {
  ManagedNoteSession,
  NoteSession,
  NoteSessionCommit,
  NoteSessionService,
  NoteSessionSnapshot,
  NoteSourceTransform,
  NoteSessionEditor,
} from '../documents/note-session-types.ts'
import { WritableStore } from '../store.ts'
import { upsertFrontmatter } from '../markdown/frontmatter.ts'
import { createTestLoggerService } from './logger.ts'
import { createTestIndexStoreService } from './index-store.ts'
import { createTestIpcBridgeService } from './ipc.ts'
import {
  createNoteDocumentService,
  type NoteDocumentService,
  type NoteDocumentServiceDeps,
} from '../documents/note-document-service.ts'
import { createTestNoteFileService } from './graph.ts'
import { createTestIndexLifecycleService } from './index-lifecycle.ts'

export interface TestNoteSessionOptions {
  /**
   * Graph-relative path of the note.
   */
  path: string
  /**
   * The full document (frontmatter + body). Defaults to empty.
   */
  content?: string
  /**
   * False reports a session that is still loading: `liveContent()` is `null`. Defaults to true.
   */
  loaded?: boolean
  /**
   * Defaults to false.
   */
  dirty?: boolean
  /**
   * Defaults to false.
   */
  unpersisted?: boolean
  /**
   * False makes `commitFrontmatter` and
   * `commitSourceEdit` refuse. Defaults to true.
   */
  accepts?: boolean
}

export interface NoteSessionCall {
  method: keyof ManagedNoteSession
  args: readonly unknown[]
}

export interface TestNoteSession extends ManagedNoteSession {
  /**
   * Every method call, in order.
   */
  calls(): readonly NoteSessionCall[]
  /**
   * The arguments of every call of `method`, in order.
   */
  getCalls(method: keyof ManagedNoteSession): ReadonlyArray<readonly unknown[]>
}

class TestNoteSessionImpl implements TestNoteSession {
  readonly #loaded: boolean
  readonly #accepts: boolean
  readonly #options: TestNoteSessionOptions
  readonly #callLog: NoteSessionCall[] = []
  readonly #store: WritableStore<NoteSessionSnapshot>
  #content: string
  readonly id = 1
  path: string

  constructor(options: TestNoteSessionOptions) {
    this.#options = options
    this.#content = options.content ?? ''
    this.#loaded = options.loaded ?? true
    this.#accepts = options.accepts ?? true
    this.path = options.path
    this.#store = new WritableStore<NoteSessionSnapshot>({
      path: options.path,
      status: this.#loaded ? 'ready' : 'loading',
      loadedContent: this.#content,
      protected: false,
      dirty: options.dirty ?? false,
      isPrivate: false,
      missing: options.unpersisted ?? false,
      error: null,
    })
  }

  readonly get = (): NoteSessionSnapshot => {
    return this.#store.get()
  }

  readonly subscribe = (listener: VoidFunction): Unlisten => {
    return this.#store.subscribe(listener)
  }

  editorSeed(): string | null {
    return this.#loaded ? this.#content : null
  }

  revalidate(): Promise<void> {
    this.#record('revalidate')
    return Promise.resolve()
  }

  isSaving(): boolean {
    return false
  }

  retarget(to: string): void {
    this.#record('retarget', to)
    this.path = to
    this.#store.set({ ...this.#store.get(), path: to })
  }

  editorChanged(markdown: string): void {
    this.#record('editorChanged', markdown)
  }

  attachEditor(editor: NoteSessionEditor): Unlisten {
    this.#record('attachEditor', editor)
    return noop
  }

  externalChanged(): void {
    this.#record('externalChanged')
  }

  flush(): Promise<void> {
    this.#record('flush')
    return Promise.resolve()
  }

  liveContent(): string | null {
    return this.#loaded ? this.#content : null
  }

  isDirty(): boolean {
    return this.#options.dirty ?? false
  }

  prepareDelete(): Promise<boolean> {
    this.#record('prepareDelete')
    return Promise.resolve(this.#options.unpersisted ?? false)
  }

  cancelDelete(): void {
    this.#record('cancelDelete')
  }

  commitFrontmatter(patch: FrontmatterPatch): Promise<boolean> {
    return Promise.try(() => {
      this.#record('commitFrontmatter', patch)
      if (!this.#accepts) {
        return false
      }
      this.#content = upsertFrontmatter(this.#content, frontmatterPatchToYaml(patch))
      return true
    })
  }

  commitSourceEdit(transform: NoteSourceTransform): Promise<NoteSessionCommit | null> {
    return Promise.try(() => {
      this.#record('commitSourceEdit', transform)
      if (!this.#accepts) {
        return null
      }
      this.#content = transform(this.#content, sha256HexSync(this.#content))
      return { content: this.#content, revision: sha256HexSync(this.#content), merged: false }
    })
  }

  dispose(): Promise<void> {
    this.#record('dispose')
    return Promise.resolve()
  }

  discard(): void {
    this.#record('discard')
  }

  calls(): readonly NoteSessionCall[] {
    return [...this.#callLog]
  }

  getCalls(method: keyof ManagedNoteSession): ReadonlyArray<readonly unknown[]> {
    return this.#callLog.filter((call) => call.method === method).map((call) => call.args)
  }

  #record(method: keyof ManagedNoteSession, ...args: unknown[]): void {
    this.#callLog.push({ method, args })
  }
}

/**
 * An in-memory {@link NoteSession} with no file behind it: the commit channels
 * edit `content` at once, and nothing loads, saves or reconciles.
 */
export function createTestNoteSession(options: TestNoteSessionOptions): TestNoteSession {
  return new TestNoteSessionImpl(options)
}

export interface TestNoteMoveService extends NoteMoveService {
  /**
   * Every move announced to the subscribers, in order.
   */
  moved(): ReadonlyArray<readonly [from: string, to: string]>
}

/**
 * Forwards every member to the real service and records each landed move.
 */
class TestNoteMoveServiceImpl implements TestNoteMoveService {
  readonly #inner: NoteMoveService
  readonly #moves: Array<readonly [string, string]> = []

  constructor(inner: NoteMoveService) {
    this.#inner = inner
    inner.onMoved((from, to) => {
      this.#moves.push([from, to])
    })
  }

  moveNote(from: string, to: string, generation: number): Promise<void> {
    return this.#inner.moveNote(from, to, generation)
  }

  followHealedMove(from: string, to: string): void {
    this.#inner.followHealedMove(from, to)
  }

  onMoved(listener: NoteMovedListener): Unlisten {
    return this.#inner.onMoved(listener)
  }

  followNativeMoves(): Unlisten {
    return this.#inner.followNativeMoves()
  }

  moved(): ReadonlyArray<readonly [from: string, to: string]> {
    return [...this.#moves]
  }
}

/**
 * A session of {@link TestNoteSessionService}.
 */
export interface TestSessionRegistration {
  session: NoteSession
}

export interface TestNoteSessionService extends NoteSessionService {
  /**
   * Add `session` as the session of its path. The returned function removes it.
   */
  register(registration: TestSessionRegistration): Unlisten
}

class TestNoteSessionServiceImpl implements TestNoteSessionService {
  readonly #registrations = new Map<string, { session: ManagedNoteSession }>()

  register({ session }: TestSessionRegistration): Unlisten {
    // A test's stand-in implements only what the code under test calls.
    const registration = { session: session as ManagedNoteSession }
    this.#registrations.set(session.path, registration)
    return () => {
      for (const [path, registered] of this.#registrations) {
        if (registered === registration) {
          this.#registrations.delete(path)
        }
      }
    }
  }

  sessionFor(path: string): NoteSession {
    const existing = this.#registrations.get(path)
    if (existing !== undefined) {
      return existing.session
    }
    const session = createTestNoteSession({ path })
    this.#registrations.set(path, { session })
    return session
  }

  existingSessionFor(path: string): NoteSession | null {
    return this.#registrations.get(path)?.session ?? null
  }

  currentSessionFor(path: string): Promise<NoteSession | null> {
    return Promise.resolve(this.existingSessionFor(path))
  }

  prefetch(path: string): void {
    this.sessionFor(path)
  }

  dirtyPaths(): string[] {
    return [...this.#registrations.values()]
      .filter(({ session }) => session.isDirty())
      .map(({ session }) => session.path)
  }

  invalidate(path: string): void {
    this.#registrations.get(path)?.session.externalChanged()
  }

  invalidateAll(): void {
    for (const { session } of this.#registrations.values()) {
      session.externalChanged()
    }
  }

  moveSession(from: string, to: string): NoteSession | null {
    const registration = this.#registrations.get(from)
    if (registration === undefined) {
      return null
    }
    void this.#registrations.get(to)?.session.dispose()
    registration.session.retarget(to)
    this.#registrations.delete(from)
    this.#registrations.set(to, registration)
    return registration.session
  }

  discardSession(path: string): void {
    this.#registrations.get(path)?.session.discard()
    this.#registrations.delete(path)
  }

  async flushAll(): Promise<void> {
    await Promise.allSettled(
      [...this.#registrations.values()].map(({ session }) => session.flush()),
    )
  }

  releaseAll(): void {
    for (const { session } of this.#registrations.values()) {
      void session.dispose()
    }
    this.#registrations.clear()
  }
}

/**
 * An in-memory {@link NoteSessionService} that holds the sessions a test registers.
 */
export function createTestNoteSessionService(): TestNoteSessionService {
  return new TestNoteSessionServiceImpl()
}

/**
 * The real {@link NoteMoveService} over `ipc`, `indexStore`, `noteSessions`
 * and `logger` (fresh test doubles by default).
 */
export function createTestNoteMoveService(
  options?: Partial<NoteMoveServiceDeps>,
): TestNoteMoveService {
  return new TestNoteMoveServiceImpl(
    createNoteMoveService({
      ipc: options?.ipc ?? createTestIpcBridgeService(),
      indexStore: options?.indexStore ?? createTestIndexStoreService(),
      noteSessions: options?.noteSessions ?? createTestNoteSessionService(),
      logger: options?.logger ?? createTestLoggerService(),
    }),
  )
}

/**
 * The real {@link NoteDocumentService} over test doubles. Without a
 * `graphSession` no graph is open, so commits write no index rows.
 */
export function createTestNoteDocumentService(
  deps?: Partial<NoteDocumentServiceDeps>,
): NoteDocumentService {
  return createNoteDocumentService({
    noteSessions: deps?.noteSessions ?? createTestNoteSessionService(),
    noteFile: deps?.noteFile ?? createTestNoteFileService(),
    graphSession: deps?.graphSession ?? { get: () => ({ session: null }) },
    indexLifecycle: deps?.indexLifecycle ?? createTestIndexLifecycleService(),
    logger: deps?.logger ?? createTestLoggerService(),
  })
}
