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
  type NoteSession,
} from '../documents/note-session-service.ts'
import { appendBlock } from '../markdown/append-section.ts'
import { upsertFrontmatter } from '../markdown/frontmatter.ts'
import { createTestLoggerService } from './logger.ts'
import { createTestIndexStoreService } from './index-store.ts'
import { createTestIpcBridgeService } from './ipc.ts'
import { createOpenDocumentsService } from '../documents/open-documents-service.ts'
import { createTestFileChangeService } from './file-change.ts'

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
   * False makes `updateFrontmatter`, `commitFrontmatter`, `commitSourceEdit`
   * and `commitBodyAppend` refuse. Defaults to true.
   */
  accepts?: boolean
}

export interface NoteSessionCall {
  method: keyof NoteSession
  args: readonly unknown[]
}

export interface TestNoteSession extends NoteSession {
  /**
   * Every method call, in order.
   */
  calls(): readonly NoteSessionCall[]
  /**
   * The arguments of every call of `method`, in order.
   */
  getCalls(method: keyof NoteSession): ReadonlyArray<readonly unknown[]>
}

class TestNoteSessionImpl implements TestNoteSession {
  readonly #loaded: boolean
  readonly #accepts: boolean
  readonly #options: TestNoteSessionOptions
  readonly #callLog: NoteSessionCall[] = []
  #content: string
  path: string

  constructor(options: TestNoteSessionOptions) {
    this.#options = options
    this.#content = options.content ?? ''
    this.#loaded = options.loaded ?? true
    this.#accepts = options.accepts ?? true
    this.path = options.path
  }

  retarget(to: string): void {
    this.#record('retarget', to)
    this.path = to
  }

  load(): void {
    this.#record('load')
  }

  editorChanged(markdown: string): void {
    this.#record('editorChanged', markdown)
  }

  externalChanged(): void {
    this.#record('externalChanged')
  }

  flush(): Promise<void> {
    this.#record('flush')
    return Promise.resolve()
  }

  content(): string {
    return this.#content
  }

  liveContent(): string | null {
    return this.#loaded ? this.#content : null
  }

  isDirty(): boolean {
    return this.#options.dirty ?? false
  }

  isUnpersisted(): boolean {
    return this.#options.unpersisted ?? false
  }

  prepareDelete(): Promise<boolean> {
    this.#record('prepareDelete')
    return Promise.resolve(this.#options.unpersisted ?? false)
  }

  cancelDelete(): void {
    this.#record('cancelDelete')
  }

  updateFrontmatter(patch: FrontmatterPatch): boolean {
    this.#record('updateFrontmatter', patch)
    if (!this.#accepts) {
      return false
    }
    this.#content = upsertFrontmatter(this.#content, frontmatterPatchToYaml(patch))
    return true
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

  commitBodyAppend(block: string): Promise<boolean> {
    return Promise.try(() => {
      this.#record('commitBodyAppend', block)
      if (!this.#accepts || block.trim() === '') {
        return false
      }
      this.#content = appendBlock(this.#content, block)
      return true
    })
  }

  commitSourceEdit(transform: (source: string) => string): Promise<boolean> {
    return Promise.try(() => {
      this.#record('commitSourceEdit', transform)
      if (!this.#accepts) {
        return false
      }
      this.#content = transform(this.#content)
      return true
    })
  }

  dispose(): void {
    this.#record('dispose')
  }

  discard(): void {
    this.#record('discard')
  }

  calls(): readonly NoteSessionCall[] {
    return [...this.#callLog]
  }

  getCalls(method: keyof NoteSession): ReadonlyArray<readonly unknown[]> {
    return this.#callLog.filter((call) => call.method === method).map((call) => call.args)
  }

  #record(method: keyof NoteSession, ...args: unknown[]): void {
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
 * The real {@link NoteMoveService} over `ipc`, `indexStore`, `openDocuments`
 * and `logger` (fresh test doubles by default).
 */
export function createTestNoteMoveService(
  options?: Partial<NoteMoveServiceDeps>,
): TestNoteMoveService {
  return new TestNoteMoveServiceImpl(
    createNoteMoveService({
      ipc: options?.ipc ?? createTestIpcBridgeService(),
      indexStore: options?.indexStore ?? createTestIndexStoreService(),
      openDocuments:
        options?.openDocuments ??
        createOpenDocumentsService({ fileChanges: createTestFileChangeService() }),
      logger: options?.logger ?? createTestLoggerService(),
    }),
  )
}
