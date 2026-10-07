import {
  appendBlock,
  detectConflictMarkers,
  errorMessage,
  isAppError,
  upsertFrontmatter,
  type MergeTextOutcome,
} from '@reflect/core'
import { splitDoc } from './note-session-doc.ts'
import { frontmatterPatchToYaml, type FrontmatterPatch } from './note-session-frontmatter.ts'
import type {
  ConflictCopy,
  NoteSession,
  NoteSessionIo,
  NoteSessionOptions,
  NoteSessionSnapshot,
  NoteSessionStatus,
} from './note-session-types.ts'

const DEFAULT_SAVE_DEBOUNCE_MS = 800

/** Create the document session for one note. See note-session.ts for semantics. */
export function createNoteSession(options: NoteSessionOptions): NoteSession {
  const { io, classify, onSnapshot, applyContent, onContent, reconcilePendingEditorInput } = options
  /** Mutable: a rename retargets the session in place (Plan 17). */
  let path = options.path
  const createIfMissing = options.createIfMissing ?? false
  const missingSeed = options.missingSeed
  const saveDebounceMs = options.saveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS

  // Snapshot state (surfaces via onSnapshot).
  let status: NoteSessionStatus = 'loading'
  let initialContent = ''
  let isProtected = false
  let dirty = false
  let missing = false
  let error: string | null = null

  // Pipeline state (never surfaces).
  /** The **body** as of the last editor change (the editor never sees frontmatter). */
  let buffer = ''
  /** The exact frontmatter bytes (with delimiters), `''` when none. */
  let header = ''
  /** The full content most recently read from or written to disk. */
  let disk = ''
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  /** Serializes writes so a flush can't interleave with a debounced save. */
  let saveChain: Promise<void> = Promise.resolve()
  /** Settles when the current initial load has committed its state. */
  let loadPromise: Promise<void> = Promise.resolve()
  /**
   * Content of the write currently in flight (set when dispatched, before the
   * write resolves). The watcher event for our own save can arrive before the
   * write settles and `disk` updates — matching against this prevents a false
   * conflict when the user kept typing during the save.
   */
  let inFlightWrite: string | null = null
  /** True while we push external content into the editor via `applyContent`. */
  let applyingContent = false
  /** True while the initial `load()` read is in flight. */
  let loading = false
  /** A watcher event arrived during the load; replay reconciliation after it. */
  let missedChange = false
  let disposed = false
  /** True while deletion has paused this session's persistence pipeline. */
  let deleting = false
  // Set by `discard` — tells `dispose` to skip its flush (the file is being
  // deleted, so rewriting it would recreate it).
  let discarded = false

  let lastEmitted: NoteSessionSnapshot | null = null

  function emit(): void {
    if (disposed) {
      return
    }
    const next: NoteSessionSnapshot = {
      status,
      initialContent,
      protected: isProtected,
      dirty,
      missing,
      error,
    }
    if (
      lastEmitted !== null &&
      lastEmitted.status === next.status &&
      lastEmitted.initialContent === next.initialContent &&
      lastEmitted.protected === next.protected &&
      lastEmitted.dirty === next.dirty &&
      lastEmitted.missing === next.missing &&
      lastEmitted.error === next.error
    ) {
      return
    }
    lastEmitted = next
    onSnapshot(next)
  }

  function save(): void {
    // A discarded session never writes: its file is being deleted, so any
    // save — including a teardown `flush()` (the pane unmounts via flush →
    // dispose) or an already-queued step — would recreate it.
    if (discarded || deleting || io.write === null || !dirty || isProtected) {
      return
    }
    const write = io.write
    saveChain = saveChain
      .then(async () => {
        // Re-check at execution time and take the freshest buffer — a queued
        // step can run behind a slow prior write, during which the user may
        // have reverted or kept typing, or the session may have been discarded
        // for a delete. (After dispose the buffer is frozen, so this same step
        // doubles as the final flush.)
        if (discarded || deleting || !dirty || isProtected) {
          return
        }
        const content = header + buffer
        inFlightWrite = content
        try {
          await write(path, content, missing ? null : disk)
          disk = content
          dirty = header + buffer !== content
          missing = false // the landed write created the file if it was missing
          error = null // a previous save failure is resolved by this success
          emit()
          onContent?.(content, 'saved')
        } finally {
          inFlightWrite = null
        }
      })
      .catch(async (cause) => {
        console.error('failed to save note:', cause)
        error = errorMessage(cause)
        await reconcileFromDisk()
        emit()
      })
  }

  function scheduleSave(): void {
    if (deleting) {
      return
    }
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
    }
    saveTimer = setTimeout(() => {
      saveTimer = null
      save()
    }, saveDebounceMs)
  }

  function cancelScheduledSave(): void {
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
  }

  function flush(): Promise<void> {
    reconcilePendingEditorInput?.()
    cancelScheduledSave()
    save()
    // save() extended the chain synchronously (or left it settled when there
    // was nothing to do) — the chain as of now is exactly this flush's write.
    return saveChain
  }

  function editorChanged(markdown: string): void {
    if (applyingContent) {
      // This change is our own applyContent pushing disk content, not a user
      // edit. The editor's serialization may normalize (trailing newline, loose
      // lists) and differ from the disk bytes — that must not dirty the buffer
      // or schedule a save, or a reload would rewrite a file the user never
      // touched. Track the serialized form; dirtiness resumes with the next
      // real edit.
      buffer = markdown
      return
    }
    buffer = markdown
    dirty = header + markdown !== disk
    if (missing && markdown.trim() === '') {
      // A still-unwritten note cleared back to nothing (e.g. the seeded
      // empty-title template deleted wholesale) stays unwritten: creating an
      // empty file would break the lazy no-litter contract. Dirtiness — and
      // the file's birth — resume with the next real content.
      dirty = false
    }
    emit()
    if (dirty) {
      scheduleSave()
    }
  }

  /** Apply external content to the live editor without entering the save path. */
  function applyToEditor(content: string): void {
    applyingContent = true
    try {
      // The editor dispatches synchronously, so its change handler runs (and is
      // suppressed) within this call.
      applyContent(content)
    } finally {
      applyingContent = false
    }
  }

  /** Adopt `content` as the new clean document state, re-gating protection. */
  function adoptCleanContent(content: string): void {
    const doc = splitDoc(content)
    header = doc.header
    buffer = doc.body
    disk = content
    dirty = false
    error = null // a reconciliation that lands clears the save failure that led here
    missing = false // external content means the file exists on disk now
    // Re-gate: the content may have introduced (or removed) syntax the editor
    // can't round-trip. When protection flips the pane remounts via
    // initialContent; otherwise reload the live editor in place.
    const unsafe = detectConflictMarkers(content) || classify(doc.body) === 'lossy'
    const flipped = unsafe !== isProtected
    isProtected = unsafe
    initialContent = unsafe ? content : doc.body
    emit()
    // While protected there is no live editor mounted (the pane shows the
    // read-only view), and unsafe content must never enter one regardless.
    if (!flipped && !unsafe) {
      applyToEditor(doc.body)
    }
    onContent?.(content, 'external')
  }

  /**
   * Re-read the note and reconcile the buffer with what's on disk (the
   * external-change path).
   */
  async function reconcileFromDisk(): Promise<void> {
    let content: string
    try {
      content = await io.read(path)
    } catch (cause) {
      if (!disposed && isAppError(cause) && cause.kind === 'notFound') {
        missing = true
        emit()
      }
      return // preserve the buffer if the file disappeared or cannot be read
    }
    if (disposed) {
      return
    }
    if (content === disk || content === inFlightWrite) {
      // Nothing to reconcile (stale, or an echo of our own possibly
      // still-settling save) — but a successful read of a previously-missing
      // note means the file exists now (e.g. another device wrote the seed
      // verbatim), so record that transition before skipping.
      if (missing) {
        missing = false
        emit()
      }
      return
    }
    if (dirty) {
      await mergeExternal(content)
      return
    }
    adoptCleanContent(content)
  }

  /**
   * External content arrived while the buffer has unsaved edits. Merge the
   * two three-way over the last content read from disk, the way a Git pull
   * or an iCloud sweep would: disjoint edits (a script appending to the
   * daily note while the user types elsewhere, a folded bullet) apply
   * silently and keep saving; overlapping edits are written into the file as
   * labeled markers, which opens the note protected for block-by-block
   * resolution. When no merge is possible (a side already carries markers,
   * no merge is available, or the buffer would not hold still) the edits are
   * kept as a copy beside the note and the external version is adopted.
   * Either way nothing typed is lost and the buffer is never left unsavable.
   */
  async function mergeExternal(content: string, attempt = 0): Promise<void> {
    const ours = header + buffer
    if (content === ours) {
      adoptCleanContent(content) // the same edit landed from both sides
      return
    }
    let merged: MergeTextOutcome | null = null
    if (io.mergeText !== undefined) {
      try {
        merged = await io.mergeText(path, disk, ours, content)
      } catch (cause) {
        console.error('three-way merge failed:', cause)
      }
    }
    if (disposed) {
      return
    }
    if (header + buffer !== ours) {
      // Keystrokes landed while merging: the result no longer covers the
      // buffer. Merge again from the new buffer; a buffer that will not hold
      // still for three rounds is kept aside instead.
      if (attempt < 3) {
        return await mergeExternal(content, attempt + 1)
      }
      merged = null
    }
    if (merged?.kind === 'clean') {
      adoptMerged(merged.content, content)
      return
    }
    if (merged?.kind === 'conflicted' && io.write !== null) {
      await materialize(merged.content, ours, content, io.write)
      return
    }
    if (await keepAside()) {
      adoptCleanContent(content)
    }
  }

  /**
   * Write the marked merge over the external version it was made from (the
   * write expects that version, so a file that moved again is reconciled
   * afresh instead of overwritten) and adopt it: markers open protected.
   * Keystrokes that land during the write are kept beside the note.
   */
  async function materialize(
    marked: string,
    ours: string,
    onDisk: string,
    write: NonNullable<NoteSessionIo['write']>,
  ): Promise<void> {
    try {
      await write(path, marked, onDisk)
    } catch (cause) {
      if (disposed) {
        return
      }
      error = errorMessage(cause)
      emit()
      if (error.includes('changed on disk')) {
        await reconcileFromDisk()
      }
      // Any other failure keeps the dirty buffer; its next save expects the
      // old disk content, fails the same way, and reconciles again.
      return
    }
    if (disposed) {
      return
    }
    error = null
    if (header + buffer === ours || (await keepAside())) {
      adoptCleanContent(marked)
    }
  }

  /**
   * Keep the buffer beside the note before external content replaces it.
   * Keystrokes that land during the copy are copied again, so the copy holds
   * what the user last saw. A copy that cannot be made keeps the dirty
   * buffer with the error: its next save fails against the changed file and
   * comes back here to retry.
   */
  async function keepAside(): Promise<boolean> {
    if (io.copyAside === undefined) {
      return true
    }
    let copy: ConflictCopy | null = null // this reconciliation's copy only
    for (let round = 0; round < 3; round += 1) {
      const contents = header + buffer
      try {
        copy = { path: await io.copyAside(path, contents, copy), contents }
      } catch (cause) {
        error = errorMessage(cause)
        emit()
        return false
      }
      if (disposed || header + buffer === contents) {
        return true
      }
    }
    error = 'The note kept changing while its edits were being kept aside'
    emit()
    return false
  }

  /** Put `merged` in the editor as the dirty buffer over `onDisk`, and keep saving. */
  function adoptMerged(merged: string, onDisk: string): void {
    const doc = splitDoc(merged)
    header = doc.header
    buffer = doc.body
    disk = onDisk
    dirty = merged !== onDisk
    missing = false
    error = null
    emit()
    applyToEditor(doc.body)
    if (dirty) {
      scheduleSave()
    }
  }

  /** The initial read; with `createIfMissing`, a missing file is an empty note. */
  async function readInitial(): Promise<{ content: string; fileMissing: boolean }> {
    try {
      return { content: await io.read(path), fileMissing: false }
    } catch (cause) {
      if (createIfMissing && isAppError(cause) && cause.kind === 'notFound') {
        return { content: '', fileMissing: true } // lazy note: created by the first save
      }
      throw cause
    }
  }

  function load(): void {
    loading = true
    missedChange = false
    status = 'loading'
    error = null
    emit()
    loadPromise = (async () => {
      try {
        const { content, fileMissing } = await readInitial()
        if (disposed) {
          return
        }
        // A missing note adopts the seed as its clean baseline: the editor
        // shows the template, but disk-comparison sees no difference, so
        // nothing is written until a real edit (the lazy no-litter contract).
        const adopted = fileMissing && missingSeed !== undefined ? missingSeed : content
        const doc = splitDoc(adopted)
        header = doc.header
        buffer = doc.body
        disk = adopted
        dirty = false
        missing = fileMissing
        // The data-loss gate: a note the editor can't reproduce opens read-only.
        // Conflict markers need their own check: the round trip mangles them
        // but still classifies `normalizing` (meowdown 0.65.3).
        isProtected = detectConflictMarkers(adopted) || classify(doc.body) === 'lossy'
        initialContent = isProtected ? adopted : doc.body
        status = 'ready'
        emit()
        // The real disk content, not the seed: the rename tracker must
        // baseline untitled so the first authored title is a birth.
        onContent?.(content, 'load')
      } catch (cause) {
        if (!disposed) {
          error = errorMessage(cause)
          status = 'error'
          emit()
        }
      } finally {
        if (!disposed) {
          loading = false
          // A change event during the load was deferred (reconciling mid-load
          // could be overwritten by this load's older read committing later);
          // replay it now against the committed state.
          if (missedChange) {
            missedChange = false
            void reconcileFromDisk()
          }
        }
      }
    })()
    void loadPromise
  }

  function externalChanged(): void {
    if (disposed) {
      return
    }
    if (loading) {
      missedChange = true // deferred; replayed when the load commits
      return
    }
    void reconcileFromDisk()
  }

  function updateFrontmatter(patch: FrontmatterPatch): boolean {
    if (disposed || isProtected || status !== 'ready') {
      return false
    }
    header = splitDoc(upsertFrontmatter(header + buffer, frontmatterPatchToYaml(patch))).header
    dirty = header + buffer !== disk
    emit()
    if (dirty) {
      scheduleSave()
    }
    return true
  }

  async function commitFrontmatter(patch: FrontmatterPatch): Promise<boolean> {
    // No write channel (no graph generation yet) means the patch can't land —
    // say so, rather than riding `updateFrontmatter`'s in-memory success while
    // `save()` silently no-ops. A `true` here would let publish/pin/private
    // skip their disk fallback and treat an unwritten flag as persisted.
    if (io.write === null) {
      return false
    }
    const previousHeader = header
    if (!updateFrontmatter(patch)) {
      return false
    }
    const attemptedHeader = header
    try {
      const shouldPersist = dirty
      await flush()
      if (shouldPersist && error !== null) {
        throw new Error(error)
      }
      return true
    } catch (cause) {
      // Preserve body edits and any newer metadata change made during the write.
      if (header === attemptedHeader) {
        header = previousHeader
      }
      dirty = header + buffer !== disk
      emit()
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
  async function commitBodyEdit(transform: (full: string) => string): Promise<boolean> {
    // What the load can't change is refused at once; a stalled read must not
    // hold a session that could never write.
    if (io.write === null || disposed) {
      return false
    }
    if (status === 'loading') {
      // Never rejects: a failed load settles as `status === 'error'`, which the
      // gate below refuses like any other unready session.
      await loadPromise
    }
    // Protection is decided by the load, so this gate runs after the wait.
    if (disposed || isProtected || status !== 'ready') {
      return false
    }
    reconcilePendingEditorInput?.()
    const previousHeader = header
    const previousBuffer = buffer
    const previousInitialContent = initialContent
    const doc = splitDoc(transform(header + buffer))
    header = doc.header
    buffer = doc.body
    // The pane seeds a mounting editor from `initialContent`; after a wait on
    // the load no editor is mounted yet, so the seed must carry the edit too.
    initialContent = doc.body
    applyToEditor(doc.body) // an already open editor shows the edited line
    dirty = header + buffer !== disk
    // A no-op edit (transform changed nothing) writes nothing, so a *prior*
    // surfaced save error must not be mistaken for this edit's failure.
    const shouldPersist = dirty
    emit()
    await flush()
    // `flush()` resolves even when the write failed (captured in `error`, not
    // thrown). Revert and surface the failure: it persists, or nothing changes.
    if (shouldPersist && error !== null) {
      const message = error
      if (header === doc.header) header = previousHeader
      if (buffer === doc.body) {
        buffer = previousBuffer
        initialContent = previousInitialContent
        applyToEditor(previousBuffer)
      }
      dirty = header + buffer !== disk
      error = null
      emit()
      throw new Error(message)
    }
    return true
  }

  function commitBodyAppend(block: string): Promise<boolean> {
    if (block.trim() === '') {
      return Promise.resolve(false)
    }
    return commitBodyEdit((full) => appendBlock(full, block))
  }

  function dispose(): void {
    // A discarded session must not write: its file is being deleted, and a
    // flush would recreate it. Otherwise flush first — the queued save step
    // reads the (now frozen) buffer, so pending edits persist to this
    // session's path even after the UI moves on.
    if (!discarded) {
      void flush()
    }
    disposed = true
  }

  function discard(): void {
    cancelScheduledSave()
    discarded = true
    disposed = true
  }

  async function prepareDelete(): Promise<boolean> {
    deleting = true
    cancelScheduledSave()
    await loadPromise
    await saveChain
    return status === 'ready' && missing && inFlightWrite === null
  }

  function cancelDelete(): void {
    if (!deleting || discarded) {
      return
    }
    deleting = false
    if (!disposed && dirty) {
      scheduleSave()
    }
  }

  return {
    get path() {
      return path
    },
    retarget: (to: string) => {
      path = to
    },
    load,
    editorChanged,
    externalChanged,
    flush,
    content: () => header + buffer,
    liveContent: () => (status === 'ready' ? header + buffer : null),
    isDirty: () => dirty,
    isUnpersisted: () => status === 'ready' && missing && inFlightWrite === null,
    prepareDelete,
    cancelDelete,
    updateFrontmatter,
    commitFrontmatter,
    commitBodyAppend,
    commitSourceEdit: commitBodyEdit,
    dispose,
    discard,
  }
}
