import type { ClockService, TimerHandle } from '../ports/clock-service.ts'
import { writeGenerationFor, type GraphSessionSource } from '../graph/graph-session.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import { errorMessage, isAppError, AppError } from '../errors.ts'
import { WritableStore } from '../store.ts'
import type { Unlisten } from '../unlisten.ts'
import type { WritableNoteFileService } from '../graph/note-file-service.ts'
import { hasAuthoredTitle, parseNote } from '../markdown/extract.ts'
import { upsertFrontmatter } from '../markdown/frontmatter.ts'
import { notePrivate } from '../privacy/privacy-service.ts'
import { splitDoc } from './note-session-doc.ts'
import { frontmatterPatchToYaml, type FrontmatterPatch } from './note-session-frontmatter.ts'
import { isShallowEqual } from '@ocavue/utils'
import type {
  ManagedNoteSession,
  NoteSessionCommit,
  NoteSourceTransform,
  NoteSessionEditor,
  NoteSessionOptions,
  NoteSessionSnapshot,
  NoteSessionStatus,
} from './note-session-types.ts'

const DEFAULT_SAVE_DEBOUNCE_MS = 800

export interface NoteSessionDeps {
  readonly noteFile: WritableNoteFileService
  readonly clock: ClockService
  readonly logger: LoggerService
  readonly graphSession: GraphSessionSource
}

/**
 * Creates the state machine of one note. {@link NoteSessionService} owns the result.
 */
export function createNoteSession(
  deps: NoteSessionDeps,
  options: NoteSessionOptions,
): ManagedNoteSession {
  return new NoteSessionImpl(deps, options)
}

class NoteSessionImpl implements ManagedNoteSession {
  readonly id: number
  readonly #deps: NoteSessionDeps
  /**
   * The graph open at creation: every read and write is pinned to its generation.
   */
  readonly #graph: ReturnType<GraphSessionSource['get']>['session']
  readonly #classify: NoteSessionOptions['classify']
  readonly #onContent: NoteSessionOptions['onContent']
  readonly #onObservedChange: NoteSessionOptions['onObservedChange']
  readonly #onDiscard: NoteSessionOptions['onDiscard']
  readonly #store: WritableStore<NoteSessionSnapshot>
  /**
   * Whether the session has had a subscriber since it last reported none.
   */
  #observed = false
  #editor: NoteSessionEditor | null = null
  readonly #createIfMissing: boolean
  readonly #missingSeed: NoteSessionOptions['missingSeed']
  readonly #saveDebounceMs: number

  /**
   * Mutable: a rename retargets the session in place (Plan 17).
   */
  path: string

  // Snapshot state.
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
   * The hash of `#disk`; `null` while no file holds that text.
   */
  #diskHash: string | null = null
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
   * The count of save steps on `#saveChain` that have not settled.
   */
  #pendingSaves = 0
  /**
   * Settles when the latest load has committed its state; `null` before the first load.
   */
  #loadPromise: Promise<void> | null = null
  /**
   * Content of the write currently in flight (set when dispatched, before the
   * write resolves). The watcher event for our own save can arrive before the
   * write settles and `disk` updates — matching against this prevents a false
   * conflict when the user kept typing during the save.
   */
  #inFlightWrite: string | null = null
  /**
   * True while we push external content into the editor with `#applyToEditor`.
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
  /**
   * Set by `discard`: the file is being deleted, so nothing writes it again.
   */
  #discarded = false

  constructor(deps: NoteSessionDeps, options: NoteSessionOptions) {
    this.#deps = deps
    this.id = options.id
    this.#classify = options.classify
    this.#onContent = options.onContent
    this.#onObservedChange = options.onObservedChange
    this.#onDiscard = options.onDiscard
    this.#graph = deps.graphSession.get().session
    this.path = options.path
    this.#createIfMissing = options.createIfMissing ?? false
    this.#missingSeed = options.missingSeed
    this.#saveDebounceMs = options.saveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS
    this.#store = new WritableStore(this.#snapshot(), isShallowEqual)
  }

  readonly get = (): NoteSessionSnapshot => {
    return this.#store.get()
  }

  readonly subscribe = (listener: VoidFunction): Unlisten => {
    const unlisten = this.#store.subscribe(listener)
    if (!this.#observed) {
      this.#observed = true
      this.#onObservedChange?.(true)
    }
    return () => {
      unlisten()
      if (this.#store.subscribed()) {
        return
      }
      // A view that swaps its subscription within one task is still a view.
      queueMicrotask(() => {
        if (this.#observed && !this.#store.subscribed()) {
          this.#observed = false
          this.#onObservedChange?.(false)
        }
      })
    }
  }

  editorSeed(): string | null {
    return this.#status === 'ready' && !this.#isProtected ? this.#buffer : null
  }

  isSaving(): boolean {
    return this.#pendingSaves > 0
  }

  retarget(to: string): void {
    this.path = to
    this.#emit()
  }

  attachEditor(editor: NoteSessionEditor): Unlisten {
    this.#editor = editor
    return () => {
      if (this.#editor === editor) {
        this.#reconcilePendingEditorInput()
        this.#editor = null
      }
    }
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

  #snapshot(): NoteSessionSnapshot {
    return {
      path: this.path,
      status: this.#status,
      initialContent: this.#initialContent,
      protected: this.#isProtected,
      dirty: this.#dirty,
      isPrivate: this.#status === 'ready' ? notePrivate(this.#header) : true,
      missing: this.#missing,
      error: this.#error,
    }
  }

  #generation(): number {
    if (this.#graph === null) {
      throw new AppError('noGraph', 'No graph is open.')
    }
    return writeGenerationFor(this.#deps.graphSession, this.#graph)
  }

  #emit(): void {
    if (!this.#disposed) {
      this.#store.set(this.#snapshot())
    }
  }

  /**
   * Queue a write of the buffer. With `retryOnFailure`, a failed write queues one more.
   */
  #save(retryOnFailure: boolean): void {
    // A discarded session never writes: its file is being deleted, so any
    // save, including an already-queued step, would recreate it.
    if (this.#discarded || this.#deleting || !this.#dirty || this.#isProtected) {
      return
    }
    this.#pendingSaves += 1
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
          const result = await this.#deps.noteFile.write(
            this.path,
            content,
            this.#generation(),
            this.#missing ? null : this.#writeBase,
          )
          this.#missing = false // the landed write created the file if it was missing
          this.#error = null // a previous save failure is resolved by this success
          if (result.merged === null) {
            this.#disk = content
            this.#diskHash = result.hash
            this.#writeBase = content
            this.#dirty = this.#header + this.#buffer !== content
            this.#emit()
            this.#onContent?.(content, 'saved')
          } else {
            this.#adoptMergedWrite(content, result.merged, result.hash)
          }
        } finally {
          this.#inFlightWrite = null
        }
      })
      .catch(async (cause) => {
        this.#deps.logger.error('failed to save note:', cause)
        this.#error = errorMessage(cause)
        await this.#reconcileFromDisk(false)
        if (retryOnFailure) {
          this.#save(false)
        }
        this.#emit()
      })
      .finally(() => {
        this.#pendingSaves -= 1
      })
  }

  /**
   * Take the text a write merged into the file, and its hash. `sent` is the
   * content given to that write.
   */
  #adoptMergedWrite(sent: string, merged: string, hash: string): void {
    this.#inFlightWrite = null
    // A merge that kept the title we sent is a local save for the rename tracker
    // (it may still hold a pending rename); any other title comes from elsewhere.
    const keptTitle = this.#titleOf(merged) === this.#titleOf(sent)
    this.#onContent?.(merged, keptTitle ? 'saved' : 'external')
    if (this.#header + this.#buffer !== sent) {
      // Keystrokes arrived during the write. They were typed on `sent`, so the
      // next save names it as the base and merges them with the file again.
      this.#disk = merged
      this.#diskHash = hash
      this.#writeBase = sent
      this.#dirty = true
      this.#emit()
      return
    }
    this.#adoptCleanContent(merged, hash)
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
      this.#save(true)
    }, this.#saveDebounceMs)
  }

  #cancelScheduledSave(): void {
    if (this.#saveTimer !== null) {
      this.#deps.clock.clearTimeout(this.#saveTimer)
      this.#saveTimer = null
    }
  }

  flush(): Promise<void> {
    this.#reconcilePendingEditorInput()
    this.#cancelScheduledSave()
    this.#save(true)
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
      // This change is our own `#applyToEditor` pushing disk content, not a user
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
      this.#editor?.setMarkdown(content)
    } finally {
      this.#applyingContent = false
    }
  }

  /**
   * Let the editor report native input it has not reported yet. The returned
   * Markdown is discarded: a normalized but unchanged document is not an edit.
   */
  #reconcilePendingEditorInput(): void {
    this.#editor?.getMarkdown()
  }

  /**
   * Adopt `content`, the file text with hash `hash`, as the new clean
   * document state, re-gating protection.
   */
  #adoptCleanContent(content: string, hash: string): void {
    const doc = splitDoc(content)
    this.#header = doc.header
    this.#buffer = doc.body
    this.#disk = content
    this.#diskHash = hash
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
  async #reconcileFromDisk(saveIfDirty: boolean, resetIfGone = false): Promise<void> {
    let content: string
    let hash: string
    try {
      ;({ content, hash } = await this.#read())
    } catch (cause) {
      if (isAppError(cause) && cause.kind === 'notFound') {
        if (resetIfGone && !this.#dirty && !this.#missing && !this.#disposed) {
          this.#adoptGone(cause)
          return
        }
        this.#missing = true
        this.#emit()
      }
      return // preserve the buffer if the file disappeared or cannot be read
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
        this.#save(true)
      }
      return
    }
    if (this.#disposed) {
      return
    }
    this.#adoptCleanContent(content, hash)
    this.#onContent?.(content, 'external')
  }

  /**
   * The note file is gone and the buffer holds nothing to keep: end as a
   * load of the missing file would.
   */
  #adoptGone(cause: unknown): void {
    if (!this.#createIfMissing) {
      this.#error = errorMessage(cause)
      this.#status = 'error'
      this.#emit()
      return
    }
    this.#adoptInitial('', null)
    if (!this.#isProtected) {
      this.#applyToEditor(this.#buffer)
    }
  }

  /**
   * Take `content`, the file text with hash `hash`, as the loaded document.
   * `hash` is `null` for a missing file.
   */
  #adoptInitial(content: string, hash: string | null): void {
    const fileMissing = hash === null
    // A missing note adopts the seed as its clean baseline: the editor
    // shows the template, but disk-comparison sees no difference, so
    // nothing is written until a real edit (the lazy no-litter contract).
    const adopted = fileMissing && this.#missingSeed !== undefined ? this.#missingSeed : content
    const doc = splitDoc(adopted)
    this.#header = doc.header
    this.#buffer = doc.body
    this.#disk = adopted
    this.#diskHash = hash
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
  }

  async #read(): Promise<{ content: string; hash: string }> {
    return await this.#deps.noteFile.readWithHash(this.path, this.#generation())
  }

  /**
   * The initial read; with `createIfMissing`, a missing file is an empty note.
   */
  async #readInitial(): Promise<{ content: string; hash: string | null }> {
    try {
      return await this.#read()
    } catch (cause) {
      if (this.#createIfMissing && isAppError(cause) && cause.kind === 'notFound') {
        return { content: '', hash: null } // lazy note: created by the first save
      }
      throw cause
    }
  }

  #load(): void {
    this.#loading = true
    this.#missedChange = false
    this.#status = 'loading'
    this.#error = null
    this.#emit()
    this.#loadPromise = (async () => {
      try {
        const { content, hash } = await this.#readInitial()
        if (this.#disposed) {
          return
        }
        this.#adoptInitial(content, hash)
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
  }

  async revalidate(): Promise<void> {
    if (this.#disposed) {
      return
    }
    if (this.#loadPromise === null || this.#status === 'error') {
      this.#load()
      await this.#loadPromise
      return
    }
    await this.#loadPromise
    if (this.#disposed || this.#status !== 'ready') {
      return
    }
    await this.#reconcileFromDisk(true, true)
    await this.#settleSaves()
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

  async commitSourceEdit(transform: NoteSourceTransform): Promise<NoteSessionCommit | null> {
    // What the load can't change is refused at once; a stalled read must not
    // hold a session that could never write.
    if (this.#disposed) {
      return null
    }
    if (this.#status === 'loading') {
      // Never rejects: a failed load settles as `status === 'error'`, which the
      // gate below refuses like any other unready session.
      await this.#loadPromise
    }
    // Protection is decided by the load, so this gate runs after the wait.
    if (this.#disposed || this.#isProtected || this.#status !== 'ready') {
      return null
    }
    this.#reconcilePendingEditorInput()
    const previousHeader = this.#header
    const previousBuffer = this.#buffer
    const source = this.#header + this.#buffer
    const edited = transform(source, source === this.#disk ? this.#diskHash : null)
    const doc = splitDoc(edited)
    this.#header = doc.header
    this.#buffer = doc.body
    this.#applyToEditor(doc.body) // an already open editor shows the edited line
    const applied = this.#buffer
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
      if (this.#buffer === applied) {
        this.#buffer = previousBuffer
        this.#applyToEditor(previousBuffer)
      }
      this.#dirty = this.#header + this.#buffer !== this.#disk
      this.#error = null
      this.#emit()
      throw new Error(message)
    }
    return { content: this.#disk, revision: this.#diskHash, merged: this.#disk !== edited }
  }

  dispose(): Promise<void> {
    // The queued save step reads the buffer, which is frozen from here on. A
    // discarded session writes nothing: `#save` refuses.
    const flushed = this.flush()
    this.#disposed = true
    return flushed
  }

  discard(): void {
    this.#cancelScheduledSave()
    const discarded = this.#discarded
    this.#discarded = true
    this.#disposed = true
    if (!discarded) {
      this.#onDiscard?.()
    }
  }

  async prepareDelete(): Promise<boolean> {
    this.#deleting = true
    this.#cancelScheduledSave()
    await this.#loadPromise
    await this.#saveChain
    return this.isUnpersisted()
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
