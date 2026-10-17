import type { ClockService, TimerHandle } from '../ports/clock-service.ts'
import { writeGenerationFor, type GraphSessionSource } from '../graph/graph-session.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import { errorMessage, isAppError, AppError } from '../errors.ts'
import type { NoteFileService, NoteWriteResult } from '../graph/note-file-service.ts'
import { appendBlock } from '../markdown/append-section.ts'
import { hasAuthoredTitle, parseNote } from '../markdown/extract.ts'
import { upsertFrontmatter } from '../markdown/frontmatter.ts'
import { splitDoc } from './note-session-doc.ts'
import { frontmatterPatchToYaml, type FrontmatterPatch } from './note-session-frontmatter.ts'
import type {
  NoteSession,
  NoteSessionOptions,
  NoteSessionService,
  NoteSessionSnapshot,
  NoteSessionStatus,
} from './note-session-types.ts'

export { frontmatterPatchToYaml, type FrontmatterPatch } from './note-session-frontmatter.ts'
export {
  INITIAL_NOTE_SNAPSHOT,
  type NoteContentOrigin,
  type NoteSession,
  type NoteSessionOptions,
  type NoteSessionService,
  type NoteSessionSnapshot,
  type NoteSessionStatus,
} from './note-session-types.ts'

/**
 * File access of one session, with the graph generation bound to its writes.
 */
interface NoteSessionIo {
  readonly read: (path: string) => Promise<string>
  readonly write:
    | ((
        path: string,
        contents: string,
        expectedContents?: string | null,
      ) => Promise<NoteWriteResult>)
    | null
}

const DEFAULT_SAVE_DEBOUNCE_MS = 800

export interface NoteSessionServiceDeps {
  readonly noteFile: NoteFileService
  readonly clock: ClockService
  readonly logger: LoggerService
  readonly graphSession: GraphSessionSource
}

class NoteSessionServiceImpl implements NoteSessionService {
  readonly #deps: NoteSessionServiceDeps

  constructor(deps: NoteSessionServiceDeps) {
    this.#deps = deps
  }

  create(options: NoteSessionOptions): NoteSession {
    return new NoteSessionImpl(this.#deps, options)
  }
}

export function createNoteSessionService(deps: NoteSessionServiceDeps): NoteSessionService {
  return new NoteSessionServiceImpl(deps)
}

/**
 * The document session for one note. See note-session-types.ts for semantics.
 */
class NoteSessionImpl implements NoteSession {
  readonly #deps: NoteSessionServiceDeps
  readonly #io: NoteSessionIo
  readonly #classify: NoteSessionOptions['classify']
  readonly #onSnapshot: NoteSessionOptions['onSnapshot']
  readonly #applyContent: NoteSessionOptions['applyContent']
  readonly #onContent: NoteSessionOptions['onContent']
  readonly #reconcilePendingEditorInput: NoteSessionOptions['reconcilePendingEditorInput']
  readonly #createIfMissing: boolean
  readonly #missingSeed: NoteSessionOptions['missingSeed']
  readonly #saveDebounceMs: number

  /**
   * Mutable: a rename retargets the session in place (Plan 17).
   */
  path: string

  // Snapshot state (surfaces via onSnapshot).
  #status: NoteSessionStatus = 'loading'
  #initialContent = ''
  #isProtected = false
  #dirty = false
  #missing = false
  #error: string | null = null

  // Pipeline state (never surfaces).
  /**
   * The **body** as of the last editor change (the editor never sees frontmatter).
   */
  #buffer = ''
  /**
   * The exact frontmatter bytes (with delimiters), `''` when none.
   */
  #header = ''
  /**
   * The full content most recently read from or written to disk.
   */
  #disk = ''
  /**
   * The text the buffer was typed on: the base a checked write names. It
   * differs from `#disk` only after a merged write raced newer keystrokes.
   */
  #writeBase = ''
  #saveTimer: TimerHandle | null = null
  /**
   * Serializes writes so a flush can't interleave with a debounced save.
   */
  #saveChain: Promise<void> = Promise.resolve()
  /**
   * Settles when the current initial load has committed its state.
   */
  #loadPromise: Promise<void> = Promise.resolve()
  /**
   * Content of the write currently in flight (set when dispatched, before the
   * write resolves). The watcher event for our own save can arrive before the
   * write settles and `disk` updates — matching against this prevents a false
   * conflict when the user kept typing during the save.
   */
  #inFlightWrite: string | null = null
  /**
   * True while we push external content into the editor via `applyContent`.
   */
  #applyingContent = false
  /**
   * True while the initial `load()` read is in flight.
   */
  #loading = false
  /**
   * A watcher event arrived during the load; replay reconciliation after it.
   */
  #missedChange = false
  #disposed = false
  /**
   * True while deletion has paused this session's persistence pipeline.
   */
  #deleting = false
  // Set by `discard` — tells `dispose` to skip its flush (the file is being
  // deleted, so rewriting it would recreate it).
  #discarded = false

  /**
   * True after a failed save retried once from its reconciliation; a landed write clears it.
   */
  #retriedFailedSave = false

  #lastEmitted: NoteSessionSnapshot | null = null

  constructor(deps: NoteSessionServiceDeps, options: NoteSessionOptions) {
    this.#deps = deps
    const { noteFile, graphSession } = deps
    this.#classify = options.classify
    this.#onSnapshot = options.onSnapshot
    this.#applyContent = options.applyContent
    this.#onContent = options.onContent
    this.#reconcilePendingEditorInput = options.reconcilePendingEditorInput
    const graph = graphSession.getState().session
    this.#io = {
      read: async (forPath) => {
        if (graph === null) {
          throw new AppError('noGraph', 'No graph is open.')
        }
        return await noteFile.read(forPath, writeGenerationFor(graphSession, graph))
      },
      write:
        options.readOnly === true || graph === null
          ? null
          : async (forPath, contents, expectedContents) => {
              const generation = writeGenerationFor(graphSession, graph)
              return await noteFile.write(forPath, contents, generation, expectedContents)
            },
    }
    this.path = options.path
    this.#createIfMissing = options.createIfMissing ?? false
    this.#missingSeed = options.missingSeed
    this.#saveDebounceMs = options.saveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS
  }

  retarget(to: string): void {
    this.path = to
  }

  content(): string {
    return this.#header + this.#buffer
  }

  liveContent(): string | null {
    return this.#status === 'ready' ? this.#header + this.#buffer : null
  }

  isDirty(): boolean {
    return this.#dirty
  }

  isUnpersisted(): boolean {
    return this.#status === 'ready' && this.#missing && this.#inFlightWrite === null
  }

  #emit(): void {
    if (this.#disposed) {
      return
    }
    const next: NoteSessionSnapshot = {
      status: this.#status,
      initialContent: this.#initialContent,
      protected: this.#isProtected,
      dirty: this.#dirty,
      missing: this.#missing,
      error: this.#error,
    }
    if (
      this.#lastEmitted !== null &&
      this.#lastEmitted.status === next.status &&
      this.#lastEmitted.initialContent === next.initialContent &&
      this.#lastEmitted.protected === next.protected &&
      this.#lastEmitted.dirty === next.dirty &&
      this.#lastEmitted.missing === next.missing &&
      this.#lastEmitted.error === next.error
    ) {
      return
    }
    this.#lastEmitted = next
    this.#onSnapshot(next)
  }

  #save(): void {
    // A discarded session never writes: its file is being deleted, so any
    // save — including a teardown `flush()` (the pane unmounts via flush →
    // dispose) or an already-queued step, would recreate it.
    if (
      this.#discarded ||
      this.#deleting ||
      this.#io.write === null ||
      !this.#dirty ||
      this.#isProtected
    ) {
      return
    }
    const write = this.#io.write
    this.#saveChain = this.#saveChain
      .then(async () => {
        // Re-check at execution time and take the freshest buffer — a queued
        // step can run behind a slow prior write, during which the user may
        // have reverted or kept typing, or the session may have been discarded
        // for a delete. (After dispose the buffer is frozen, so this same step
        // doubles as the final flush.)
        if (this.#discarded || this.#deleting || !this.#dirty || this.#isProtected) {
          return
        }
        const content = this.#header + this.#buffer
        this.#inFlightWrite = content
        try {
          const result = await write(this.path, content, this.#missing ? null : this.#writeBase)
          this.#missing = false // the landed write created the file if it was missing
          this.#error = null // a previous save failure is resolved by this success
          this.#retriedFailedSave = false
          if (result.merged === null) {
            this.#disk = content
            this.#writeBase = content
            this.#dirty = this.#header + this.#buffer !== content
            this.#emit()
            this.#onContent?.(content, 'saved')
          } else {
            this.#adoptMergedWrite(content, result.merged)
          }
        } finally {
          this.#inFlightWrite = null
        }
      })
      .catch(async (cause) => {
        this.#deps.logger.error('failed to save note:', cause)
        this.#error = errorMessage(cause)
        const retry = !this.#retriedFailedSave
        this.#retriedFailedSave = true
        await this.#reconcileFromDisk(retry)
        this.#emit()
      })
  }

  /**
   * Take the text a write merged into the file. `sent` is the content given to that write.
   */
  #adoptMergedWrite(sent: string, merged: string): void {
    this.#inFlightWrite = null
    // A merge that kept the title we sent is a local save for the rename tracker
    // (it may still hold a pending rename); any other title comes from elsewhere.
    const keptTitle = this.#titleOf(merged) === this.#titleOf(sent)
    this.#onContent?.(merged, keptTitle ? 'saved' : 'external')
    if (this.#header + this.#buffer !== sent) {
      // Keystrokes arrived during the write. They were typed on `sent`, so the
      // next save names it as the base and merges them with the file again.
      this.#disk = merged
      this.#writeBase = sent
      this.#dirty = true
      this.#emit()
      return
    }
    this.#adoptCleanContent(merged)
  }

  #titleOf(content: string): string | null {
    const parsed = parseNote({ path: this.path, source: content })
    return hasAuthoredTitle(parsed) ? parsed.title : null
  }

  #scheduleSave(): void {
    if (this.#deleting) {
      return
    }
    if (this.#saveTimer !== null) {
      this.#deps.clock.clearTimeout(this.#saveTimer)
    }
    this.#saveTimer = this.#deps.clock.setTimeout(() => {
      this.#saveTimer = null
      this.#save()
    }, this.#saveDebounceMs)
  }

  #cancelScheduledSave(): void {
    if (this.#saveTimer !== null) {
      this.#deps.clock.clearTimeout(this.#saveTimer)
      this.#saveTimer = null
    }
  }

  flush(): Promise<void> {
    this.#reconcilePendingEditorInput?.()
    this.#cancelScheduledSave()
    this.#save()
    return this.#settleSaves()
  }

  /**
   * Wait for the save chain, including the one retry a failed save queues behind itself.
   */
  async #settleSaves(): Promise<void> {
    let chain: Promise<void>
    do {
      chain = this.#saveChain
      await chain
    } while (chain !== this.#saveChain)
  }

  editorChanged(markdown: string): void {
    if (this.#applyingContent) {
      // This change is our own applyContent pushing disk content, not a user
      // edit. The editor's serialization may normalize (trailing newline, loose
      // lists) and differ from the disk bytes — that must not dirty the buffer
      // or schedule a save, or a reload would rewrite a file the user never
      // touched. Track the serialized form; dirtiness resumes with the next
      // real edit.
      this.#buffer = markdown
      return
    }
    this.#buffer = markdown
    this.#dirty = this.#header + markdown !== this.#disk
    if (!this.#dirty) {
      this.#writeBase = this.#disk
    }
    if (this.#missing && markdown.trim() === '') {
      // A still-unwritten note cleared back to nothing (e.g. the seeded
      // empty-title template deleted wholesale) stays unwritten: creating an
      // empty file would break the lazy no-litter contract. Dirtiness — and
      // the file's birth — resume with the next real content.
      this.#dirty = false
    }
    this.#emit()
    if (this.#dirty) {
      this.#scheduleSave()
    }
  }

  /**
   * Apply external content to the live editor without entering the save path.
   */
  #applyToEditor(content: string): void {
    this.#applyingContent = true
    try {
      // The editor dispatches synchronously, so its change handler runs (and is
      // suppressed) within this call.
      this.#applyContent(content)
    } finally {
      this.#applyingContent = false
    }
  }

  /**
   * Adopt `content` as the new clean document state, re-gating protection.
   */
  #adoptCleanContent(content: string): void {
    const doc = splitDoc(content)
    this.#header = doc.header
    this.#buffer = doc.body
    this.#disk = content
    this.#writeBase = content
    this.#dirty = false
    this.#missing = false // external content means the file exists on disk now
    // Re-gate: the content may have introduced (or removed) syntax the editor
    // can't round-trip. When protection flips the pane remounts via
    // initialContent; otherwise reload the live editor in place.
    const unsafe = this.#classify(doc.body) === 'lossy'
    const flipped = unsafe !== this.#isProtected
    this.#isProtected = unsafe
    this.#initialContent = unsafe ? content : doc.body
    this.#emit()
    // While protected there is no live editor mounted (the pane shows the
    // read-only view), and unsafe content must never enter one regardless.
    if (!flipped && !unsafe && !this.#disposed) {
      this.#applyToEditor(doc.body)
    }
  }

  /**
   * Re-read the note and reconcile the buffer with what's on disk (the
   * external-change path).
   */
  async #reconcileFromDisk(saveIfDirty: boolean): Promise<void> {
    let content: string
    try {
      content = await this.#io.read(this.path)
    } catch (cause) {
      if (!this.#disposed && isAppError(cause) && cause.kind === 'notFound') {
        this.#missing = true
        this.#emit()
      }
      return // preserve the buffer if the file disappeared or cannot be read
    }
    if (this.#disposed) {
      return
    }
    if (content === this.#disk || content === this.#inFlightWrite) {
      // Nothing to reconcile (stale, or an echo of our own possibly
      // still-settling save) — but a successful read of a previously-missing
      // note means the file exists now (e.g. another device wrote the seed
      // verbatim), so record that transition before skipping.
      if (this.#missing) {
        this.#missing = false
        this.#emit()
      }
      return
    }
    if (this.#dirty) {
      // The file exists now, so the save is a checked write against the base
      // the buffer was typed on, and the write merges it with this content.
      if (this.#missing) {
        this.#missing = false
        this.#emit()
      }
      if (saveIfDirty) {
        this.#cancelScheduledSave()
        this.#save()
      }
      return
    }
    this.#adoptCleanContent(content)
    this.#onContent?.(content, 'external')
  }

  /**
   * The initial read; with `createIfMissing`, a missing file is an empty note.
   */
  async #readInitial(): Promise<{ content: string; fileMissing: boolean }> {
    try {
      return { content: await this.#io.read(this.path), fileMissing: false }
    } catch (cause) {
      if (this.#createIfMissing && isAppError(cause) && cause.kind === 'notFound') {
        return { content: '', fileMissing: true } // lazy note: created by the first save
      }
      throw cause
    }
  }

  load(): void {
    this.#loading = true
    this.#missedChange = false
    this.#status = 'loading'
    this.#error = null
    this.#emit()
    this.#loadPromise = (async () => {
      try {
        const { content, fileMissing } = await this.#readInitial()
        if (this.#disposed) {
          return
        }
        // A missing note adopts the seed as its clean baseline: the editor
        // shows the template, but disk-comparison sees no difference, so
        // nothing is written until a real edit (the lazy no-litter contract).
        const adopted = fileMissing && this.#missingSeed !== undefined ? this.#missingSeed : content
        const doc = splitDoc(adopted)
        this.#header = doc.header
        this.#buffer = doc.body
        this.#disk = adopted
        this.#writeBase = adopted
        this.#dirty = false
        this.#missing = fileMissing
        // The data-loss gate: a note the editor can't reproduce opens read-only.
        this.#isProtected = this.#classify(doc.body) === 'lossy'
        this.#initialContent = this.#isProtected ? adopted : doc.body
        this.#status = 'ready'
        this.#emit()
        // The real disk content, not the seed: the rename tracker must
        // baseline untitled so the first authored title is a birth.
        this.#onContent?.(content, 'load')
      } catch (cause) {
        if (!this.#disposed) {
          this.#error = errorMessage(cause)
          this.#status = 'error'
          this.#emit()
        }
      } finally {
        if (!this.#disposed) {
          this.#loading = false
          // A change event during the load was deferred (reconciling mid-load
          // could be overwritten by this load's older read committing later);
          // replay it now against the committed state.
          if (this.#missedChange) {
            this.#missedChange = false
            void this.#reconcileFromDisk(true)
          }
        }
      }
    })()
    void this.#loadPromise
  }

  externalChanged(): void {
    if (this.#disposed) {
      return
    }
    if (this.#loading) {
      this.#missedChange = true // deferred; replayed when the load commits
      return
    }
    void this.#reconcileFromDisk(true)
  }

  updateFrontmatter(patch: FrontmatterPatch): boolean {
    if (this.#disposed || this.#isProtected || this.#status !== 'ready') {
      return false
    }
    this.#header = splitDoc(
      upsertFrontmatter(this.#header + this.#buffer, frontmatterPatchToYaml(patch)),
    ).header
    this.#dirty = this.#header + this.#buffer !== this.#disk
    this.#emit()
    if (this.#dirty) {
      this.#scheduleSave()
    }
    return true
  }

  async commitFrontmatter(patch: FrontmatterPatch): Promise<boolean> {
    // No write channel (no graph generation yet) means the patch can't land —
    // say so, rather than riding `updateFrontmatter`'s in-memory success while
    // `save()` silently no-ops. A `true` here would let publish/pin/private
    // skip their disk fallback and treat an unwritten flag as persisted.
    if (this.#io.write === null) {
      return false
    }
    const previousHeader = this.#header
    if (!this.updateFrontmatter(patch)) {
      return false
    }
    const attemptedHeader = this.#header
    try {
      const shouldPersist = this.#dirty
      await this.flush()
      if (shouldPersist && this.#error !== null) {
        throw new Error(this.#error)
      }
      return true
    } catch (cause) {
      // Preserve body edits and any newer metadata change made during the write.
      if (this.#header === attemptedHeader) {
        this.#header = previousHeader
      }
      this.#dirty = this.#header + this.#buffer !== this.#disk
      this.#emit()
      throw cause
    }
  }

  /**
   * Apply an out-of-editor body edit (the Tasks view's toggle / edit / delete,
   * the suggested-contact card's append) transactionally:
   * `transform` rewrites the live document — header plus the unsaved buffer, so
   * concurrent editor edits survive — then we land it now so the Tasks view
   * refreshes promptly. A session still loading waits for the load first:
   * navigating to a note (⌘D to today) opens its session in the same tick the
   * Tasks view's unmount flush writes to it, and the pending read is a moment,
   * not a reason to refuse. Returns false when the session can't safely take a
   * body edit (no write channel, disposed, protected/read-only, or failed to
   * load) so the caller refuses rather than clobber the buffer
   * via disk. `transform` runs before any mutation, so a `TaskStaleError` (the
   * marker can't be located) propagates with nothing changed. And the write is
   * all-or-nothing: a failed flush reverts the in-memory edit so the editor and
   * the Tasks list can't diverge, then re-throws the failure.
   */
  async commitSourceEdit(transform: (full: string) => string): Promise<boolean> {
    // What the load can't change is refused at once; a stalled read must not
    // hold a session that could never write.
    if (this.#io.write === null || this.#disposed) {
      return false
    }
    if (this.#status === 'loading') {
      // Never rejects: a failed load settles as `status === 'error'`, which the
      // gate below refuses like any other unready session.
      await this.#loadPromise
    }
    // Protection is decided by the load, so this gate runs after the wait.
    if (this.#disposed || this.#isProtected || this.#status !== 'ready') {
      return false
    }
    this.#reconcilePendingEditorInput?.()
    const previousHeader = this.#header
    const previousBuffer = this.#buffer
    const previousInitialContent = this.#initialContent
    const doc = splitDoc(transform(this.#header + this.#buffer))
    this.#header = doc.header
    this.#buffer = doc.body
    // The pane seeds a mounting editor from `initialContent`; after a wait on
    // the load no editor is mounted yet, so the seed must carry the edit too.
    this.#initialContent = doc.body
    this.#applyToEditor(doc.body) // an already open editor shows the edited line
    this.#dirty = this.#header + this.#buffer !== this.#disk
    // A no-op edit (transform changed nothing) writes nothing, so a *prior*
    // surfaced save error must not be mistaken for this edit's failure.
    const shouldPersist = this.#dirty
    this.#emit()
    await this.flush()
    // `flush()` resolves even when the write failed (captured in `error`, not
    // thrown). Revert and surface the failure: it persists, or nothing changes.
    if (shouldPersist && this.#error !== null) {
      const message = this.#error
      if (this.#header === doc.header) this.#header = previousHeader
      if (this.#buffer === doc.body) {
        this.#buffer = previousBuffer
        this.#initialContent = previousInitialContent
        this.#applyToEditor(previousBuffer)
      }
      this.#dirty = this.#header + this.#buffer !== this.#disk
      this.#error = null
      this.#emit()
      throw new Error(message)
    }
    return true
  }

  commitBodyAppend(block: string): Promise<boolean> {
    if (block.trim() === '') {
      return Promise.resolve(false)
    }
    return this.commitSourceEdit((full) => appendBlock(full, block))
  }

  dispose(): void {
    // A discarded session must not write: its file is being deleted, and a
    // flush would recreate it. Otherwise flush first — the queued save step
    // reads the (now frozen) buffer, so pending edits persist to this
    // session's path even after the UI moves on.
    if (!this.#discarded) {
      void this.flush()
    }
    this.#disposed = true
  }

  discard(): void {
    this.#cancelScheduledSave()
    this.#discarded = true
    this.#disposed = true
  }

  async prepareDelete(): Promise<boolean> {
    this.#deleting = true
    this.#cancelScheduledSave()
    await this.#loadPromise
    await this.#saveChain
    return this.#status === 'ready' && this.#missing && this.#inFlightWrite === null
  }

  cancelDelete(): void {
    if (!this.#deleting || this.#discarded) {
      return
    }
    this.#deleting = false
    if (!this.#disposed && this.#dirty) {
      this.#scheduleSave()
    }
  }
}
