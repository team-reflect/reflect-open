import { appendBlock, editTaskLine, errorMessage, isAppError, removeTaskLine, taskLineToBullet, toggleTaskMarker, upsertFrontmatter, type TaskMarker } from '@reflect/core'
import { splitDoc } from './note-session-doc'
import { frontmatterPatchToYaml, type FrontmatterPatch } from './note-session-frontmatter'
import type { NoteSession, NoteSessionOptions, NoteSessionSnapshot, NoteSessionStatus } from './note-session-types'

const DEFAULT_SAVE_DEBOUNCE_MS = 800

type SaveAttemptResult =
  | { readonly kind: 'landed' }
  | { readonly kind: 'alreadyCurrent' }
  | { readonly kind: 'failed'; readonly message: string | null }

type ConditionalWriteReconciliation =
  | { readonly kind: 'attemptedContent' }
  | { readonly kind: 'liveContent' }
  | { readonly kind: 'divergentContent'; readonly content: string }
  | { readonly kind: 'failed' }

const ALREADY_CURRENT: SaveAttemptResult = { kind: 'alreadyCurrent' }
const SKIPPED_SAVE: SaveAttemptResult = { kind: 'failed', message: null }

/** Create the document session for one note. See note-session.ts for semantics. */
export function createNoteSession(options: NoteSessionOptions): NoteSession {
  const {
    io,
    classify,
    onSnapshot,
    applyContent,
    onContent,
    reconcilePendingEditorInput,
    onInitialCreateConsumed,
  } = options
  /** Mutable: a rename retargets the session in place (Plan 17). */
  let path = options.path
  const createIfMissing = options.createIfMissing ?? false
  let recreateAfterRemoval = options.recreateAfterRemoval ?? false
  const missingSeed = options.missingSeed
  const saveDebounceMs = options.saveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS

  // Snapshot state (surfaces via onSnapshot).
  let status: NoteSessionStatus = 'loading'
  let initialContent = ''
  let isProtected = false
  let dirty = false
  let missing = false
  let conflict: string | null = null
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
  /** The last watcher event during load; replay it after the initial read settles. */
  let missedChange: 'upsert' | 'remove' | null = null
  let disposed = false
  // Set by `discard` — tells `dispose` to skip its flush (the file is being
  // deleted, so rewriting it would recreate it).
  let discarded = false
  /**
   * An existing non-lazy note was removed outside Reflect. Keep its buffer but
   * refuse every write until a successful read proves the path exists again.
   */
  let writeParkedForRemoval = false
  /** A fresh missing route may claim its path once; landing or retargeting revokes it. */
  let initialMissingCreateAvailable = false
  let initialCreateConsumptionReported = false
  /**
   * Monotonic identity of the live document. Transactional edits use this to
   * avoid rolling a failed write back over newer editor input.
   */
  let documentRevision = 0
  /** Monotonic identity of watcher events, including removals and deferred changes. */
  let filesystemRevision = 0
  /** Later reconciliation reads supersede earlier reads, even for the same watcher event. */
  let reconciliationRevision = 0

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
      saveBlockedByRemoval: writeParkedForRemoval,
      conflict,
      error,
    }
    if (
      lastEmitted !== null &&
      lastEmitted.status === next.status &&
      lastEmitted.initialContent === next.initialContent &&
      lastEmitted.protected === next.protected &&
      lastEmitted.dirty === next.dirty &&
      lastEmitted.missing === next.missing &&
      lastEmitted.saveBlockedByRemoval === next.saveBlockedByRemoval &&
      lastEmitted.conflict === next.conflict &&
      lastEmitted.error === next.error
    ) {
      return
    }
    lastEmitted = next
    onSnapshot(next)
  }

  function consumeInitialCreateCapability(): void {
    initialMissingCreateAvailable = false
    if (!initialCreateConsumptionReported) {
      initialCreateConsumptionReported = true
      onInitialCreateConsumed?.()
    }
  }

  function save(): Promise<SaveAttemptResult> {
    // A discarded session never writes: its file is being deleted, so any
    // save — including a teardown `flush()` (the pane unmounts via flush →
    // dispose) or an already-queued step — would recreate it. A parked
    // conflict likewise pauses all saves: writing the buffer before the user
    // chooses Keep mine / Load theirs would clobber the external change and
    // defeat the non-destructive flow.
    if (
      discarded ||
      writeParkedForRemoval ||
      io.write === null ||
      isProtected ||
      conflict !== null
    ) {
      return Promise.resolve(SKIPPED_SAVE)
    }
    if (!dirty) {
      return Promise.resolve(ALREADY_CURRENT)
    }
    const write = io.write
    const attempt = saveChain.then(async (): Promise<SaveAttemptResult> => {
      try {
        // Re-check at execution time and take the freshest buffer — a queued
        // step can run behind a slow prior write, during which the user may
        // have reverted or kept typing, or the session may have been discarded
        // for a delete. (After dispose the buffer is frozen, so this same step
        // doubles as the final flush.)
        if (
          discarded ||
          writeParkedForRemoval ||
          isProtected ||
          conflict !== null
        ) {
          return SKIPPED_SAVE
        }
        if (!dirty) {
          return ALREADY_CURRENT
        }
        const content = header + buffer
        const expected = missing ? null : disk
        if (expected === null && !initialMissingCreateAvailable && !recreateAfterRemoval) {
          // The fresh route already spent its one claim (possibly in a command
          // whose response was lost). Never retry an absent-path write: the
          // earlier command may have landed and the file may since have been
          // removed, which would turn an innocent retry into recreation.
          writeParkedForRemoval = true
          cancelScheduledSave()
          emit()
          return SKIPPED_SAVE
        }
        // Dispatching the first create consumes the fresh-route capability.
        // The native write may land before its IPC response; if a newer remove
        // event arrives in that window, `externalRemoved()` must park the
        // buffer instead of treating the route as never created and allowing
        // a later flush to recreate it.
        if (expected === null && initialMissingCreateAvailable) {
          consumeInitialCreateCapability()
        }
        inFlightWrite = content
        try {
          const written = await write(path, content, expected)
          if (!written) {
            const reconciliation = await reconcileConditionalWriteRefusal(
              expected === null,
              content,
            )
            return reconciliation.kind === 'attemptedContent' ||
              reconciliation.kind === 'liveContent'
              ? ALREADY_CURRENT
              : { kind: 'failed', message: error }
          }
          disk = content
          consumeInitialCreateCapability()
          // A remove can arrive while this write is already in flight. Its
          // successful return does not overrule that newer filesystem fact:
          // keep the buffer dirty and parked until an upsert can be read.
          dirty = writeParkedForRemoval || header + buffer !== content
          if (!writeParkedForRemoval) {
            missing = false // the landed write created the file if it was missing
          }
          error = null // a previous save failure is resolved by this success
          emit()
          if (!writeParkedForRemoval) {
            onContent?.(content, 'saved')
          }
          return { kind: 'landed' }
        } finally {
          inFlightWrite = null
        }
      } catch (cause) {
        console.error('failed to save note:', cause)
        if (missing && !initialMissingCreateAvailable && !recreateAfterRemoval) {
          // The first absent-path command has been dispatched, so transport
          // failure is ambiguous: it may have landed before the response was
          // lost. Park immediately rather than promising a retry that could
          // recreate a subsequently removed file.
          writeParkedForRemoval = true
          cancelScheduledSave()
        }
        const message = errorMessage(cause)
        error = message
        emit()
        return { kind: 'failed', message }
      }
    })
    saveChain = attempt.then(() => undefined)
    return attempt
  }

  function scheduleSave(): void {
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

  function flushWithResult(): Promise<SaveAttemptResult> {
    reconcilePendingEditorInput?.()
    cancelScheduledSave()
    return save()
  }

  async function flush(): Promise<void> {
    await flushWithResult()
    // A clean flush returns `alreadyCurrent` without extending the chain, but
    // it must still wait for any prior in-flight save before reporting settled.
    await saveChain
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
    documentRevision += 1
    dirty = header + markdown !== disk
    if (missing && markdown.trim() === '') {
      // A still-unwritten note cleared back to nothing (e.g. the seeded
      // empty-title template deleted wholesale) stays unwritten: creating an
      // empty file would break the lazy no-litter contract. Dirtiness — and
      // the file's birth — resume with the next real content.
      dirty = false
    }
    emit()
    if (dirty && !writeParkedForRemoval) {
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
    documentRevision += 1
    disk = content
    dirty = false
    missing = false // external content means the file exists on disk now
    // Re-gate: the content may have introduced (or removed) syntax the editor
    // can't round-trip. When protection flips the pane remounts via
    // initialContent; otherwise reload the live editor in place.
    const lossy = classify(doc.body) === 'lossy'
    const flipped = lossy !== isProtected
    isProtected = lossy
    initialContent = lossy ? content : doc.body
    emit()
    // While protected there is no live editor mounted (the pane shows the
    // read-only view), and lossy content must never enter one regardless.
    if (!flipped && !lossy) {
      applyToEditor(doc.body)
    }
    onContent?.(content, 'external')
  }

  /** Reconcile a native compare-and-swap refusal without issuing another write. */
  async function reconcileConditionalWriteRefusal(
    expectedAbsent: boolean,
    attemptedContent: string,
  ): Promise<ConditionalWriteReconciliation> {
    const readRevision = ++reconciliationRevision
    const readFilesystemRevision = filesystemRevision
    let content: string
    try {
      content = await io.read(path)
    } catch (cause) {
      if (
        disposed ||
        readRevision !== reconciliationRevision ||
        readFilesystemRevision !== filesystemRevision
      ) {
        return { kind: 'failed' }
      }
      if (isAppError(cause) && cause.kind === 'notFound') {
        missing = true
        conflict = null
        const mayCreate =
          recreateAfterRemoval || (expectedAbsent && initialMissingCreateAvailable)
        writeParkedForRemoval = !mayCreate
        cancelScheduledSave()
        emit()
        return { kind: 'failed' }
      }
      error = errorMessage(cause)
      emit()
      return { kind: 'failed' }
    }
    if (
      disposed ||
      readRevision !== reconciliationRevision ||
      readFilesystemRevision !== filesystemRevision
    ) {
      return { kind: 'failed' }
    }
    consumeInitialCreateCapability()
    writeParkedForRemoval = false
    missing = false
    disk = content
    error = null
    const observed = content === attemptedContent
      ? { kind: 'attemptedContent' as const }
      : content === header + buffer
        ? { kind: 'liveContent' as const }
        : null
    if (observed !== null) {
      dirty = content !== header + buffer
      conflict = null
      emit()
      onContent?.(content, 'external')
      if (dirty && !writeParkedForRemoval) {
        scheduleSave()
      }
      return observed
    }
    // The attempted write did not land, and these are the winner's exact
    // bytes. Park them as the conflict baseline; Keep mine will conditionally
    // replace this version and must fail again if it changes once more.
    dirty = true
    conflict = content
    cancelScheduledSave()
    emit()
    return { kind: 'divergentContent', content }
  }

  /**
   * Re-read the note and reconcile the buffer with what's on disk (the
   * external-change path).
   */
  async function reconcileFromDisk(eventRevision: number): Promise<void> {
    const readRevision = ++reconciliationRevision
    let content: string
    try {
      content = await io.read(path)
    } catch {
      return // deleted/unreadable between event and read; nothing to reconcile
    }
    if (
      disposed ||
      readRevision !== reconciliationRevision ||
      eventRevision !== filesystemRevision
    ) {
      return
    }
    const wasParkedForRemoval = writeParkedForRemoval
    writeParkedForRemoval = false
    consumeInitialCreateCapability()
    missing = false
    if (content === disk || content === inFlightWrite) {
      // Nothing to reconcile (stale, or an echo of our own possibly
      // still-settling save) — but a successful read of a previously-missing
      // note means the file exists now (e.g. another device wrote the seed
      // verbatim), so record that transition before skipping.
      if (content === header + buffer) {
        dirty = false
      }
      emit()
      if (wasParkedForRemoval && dirty) {
        scheduleSave()
      }
      return
    }
    if (wasParkedForRemoval && content === header + buffer) {
      // A write can land before its IPC response is lost. The watcher then
      // supplies the only trustworthy acknowledgement: identical live bytes
      // mean the editor and disk already agree, not that two versions need a
      // conflict choice.
      disk = content
      dirty = false
      conflict = null
      error = null
      emit()
      onContent?.(content, 'external')
      return
    }
    if (dirty) {
      // Never clobber unsaved edits — park the external content and pause the
      // save pipeline (cancel any pending debounce) until the user chooses; a
      // save landing now would overwrite "theirs" first.
      cancelScheduledSave()
      disk = content
      conflict = content
      emit()
      return
    }
    adoptCleanContent(content)
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
    missedChange = null
    status = 'loading'
    conflict = null
    error = null
    emit()
    void (async () => {
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
        initialMissingCreateAvailable = fileMissing
        if (!fileMissing) {
          consumeInitialCreateCapability()
        }
        // The data-loss gate: a note the editor can't reproduce opens read-only.
        isProtected = classify(doc.body) === 'lossy'
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
          const pendingChange = missedChange
          missedChange = null
          if (pendingChange === 'remove') {
            externalRemoved()
          } else if (pendingChange === 'upsert') {
            externalChanged()
          }
        }
      }
    })()
  }

  function externalChanged(): void {
    if (disposed) {
      return
    }
    filesystemRevision += 1
    const eventRevision = filesystemRevision
    if (loading) {
      missedChange = 'upsert' // deferred; replayed when the load commits
      return
    }
    void reconcileFromDisk(eventRevision)
  }

  function externalRemoved(): void {
    if (disposed) {
      return
    }
    filesystemRevision += 1
    if (loading) {
      missedChange = 'remove'
      return
    }
    missing = true
    // A previously parked external version is no longer on disk, so it is not
    // a meaningful "theirs" choice after the newer remove event.
    conflict = null
    if (!initialMissingCreateAvailable && !recreateAfterRemoval) {
      // Preserve the editor buffer, including pending changes, but stop both
      // its debounce and every later flush from recreating an adopted path.
      writeParkedForRemoval = true
      cancelScheduledSave()
    } else if (dirty) {
      // An as-yet-uncreated fresh route, or a daily route with durable
      // recreation, may still claim the absent path without clobbering.
      scheduleSave()
    }
    emit()
  }

  function keepMine(): void {
    conflict = null
    dirty = true // force the rewrite even if content drifted equal
    emit()
    save()
  }

  function loadTheirs(): void {
    if (conflict === null) {
      return
    }
    const content = conflict
    conflict = null
    // Same re-gating as the clean-reload path: never load lossy content into a
    // live editor whose next save would drop what it can't model.
    adoptCleanContent(content)
  }

  function updateFrontmatter(patch: FrontmatterPatch): boolean {
    if (disposed || writeParkedForRemoval || isProtected || status !== 'ready') {
      return false
    }
    const nextHeader = splitDoc(
      upsertFrontmatter(header + buffer, frontmatterPatchToYaml(patch)),
    ).header
    if (nextHeader !== header) {
      header = nextHeader
      documentRevision += 1
    }
    dirty = header + buffer !== disk
    emit()
    if (dirty) {
      scheduleSave()
    }
    return true
  }

  async function commitFrontmatter(patch: FrontmatterPatch): Promise<boolean> {
    if (writeParkedForRemoval) {
      // Throw instead of returning false: frontmatter callers use false to
      // select their disk fallback, which could otherwise recreate this path.
      throw new Error('This note was removed from disk. Restore it before saving changes.')
    }
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
    const operationRevision = documentRevision

    function rollbackPatch(): void {
      if (documentRevision !== operationRevision) {
        return
      }
      header = previousHeader
      documentRevision += 1
      dirty = header + buffer !== disk
      error = null
      emit()
      if (dirty && conflict === null && !writeParkedForRemoval) {
        scheduleSave()
      }
    }

    if (conflict === null) {
      const result = await flushWithResult()
      if (result.kind === 'failed') {
        rollbackPatch()
        throw new Error(result.message ?? 'The frontmatter update could not be saved.')
      }
      return true
    }
    // Saves are paused: the patch above rides the in-memory header (landing
    // with "keep mine"), so make the other half land too — patch the parked
    // content and write it through. The park refreshes in place, so "load
    // theirs" adopts the patched bytes, and recording the write in `disk`
    // makes the watcher's echo a recognized no-op.
    const contested = conflict
    const yamlPatch = frontmatterPatchToYaml(patch)
    const patched = upsertFrontmatter(contested, yamlPatch)
    if (patched !== contested) {
      try {
        const writeRevision = filesystemRevision
        const written = await io.write(path, patched, contested)
        if (!written || filesystemRevision !== writeRevision) {
          const reconciliation = await reconcileConditionalWriteRefusal(false, patched)
          if (
            reconciliation.kind === 'failed' ||
            (reconciliation.kind === 'divergentContent' &&
              upsertFrontmatter(reconciliation.content, yamlPatch) !== reconciliation.content)
          ) {
            throw new Error('This note changed again before the frontmatter update landed.')
          }
          if (
            reconciliation.kind === 'liveContent' ||
            reconciliation.kind === 'divergentContent'
          ) {
            return true
          }
        }
        initialMissingCreateAvailable = false
        conflict = patched
        disk = patched
        dirty = header + buffer !== disk
        cancelScheduledSave()
        emit()
      } catch (cause) {
        rollbackPatch()
        throw cause
      }
    }
    return true
  }

  /**
   * Compare-and-swap a prepared move rewrite through the live editor. The
   * precondition and in-memory replacement happen without an await between
   * them, so an editor change cannot slip between the equality check and the
   * update. Rollback uses the same path with `after` as the expected content.
   */
  async function commitExactContentReplacement(
    expected: string,
    replacement: string,
  ): Promise<boolean> {
    function unavailable(): boolean {
      return (
        io.write === null ||
        disposed ||
        writeParkedForRemoval ||
        isProtected ||
        status !== 'ready' ||
        dirty ||
        missing ||
        conflict !== null
      )
    }

    if (unavailable()) {
      return false
    }
    // Native input can be ahead of the serialized editor buffer. Pull it in
    // before comparing, then re-check every guard because reconciliation may
    // synchronously mark the session dirty.
    reconcilePendingEditorInput?.()
    if (unavailable() || header + buffer !== expected) {
      return false
    }
    if (replacement === expected) {
      return true
    }

    const next = splitDoc(replacement)
    // A link rewrite cannot legitimately reduce round-trip fidelity. Refuse
    // instead of putting newly lossy syntax into an editable session.
    if (classify(next.body) === 'lossy') {
      return false
    }
    const previousHeader = header
    const previousBuffer = buffer
    header = next.header
    buffer = next.body
    applyToEditor(next.body)
    // `applyContent` may synchronously serialize a normalized document back
    // through `editorChanged`. A prepared rewrite and its inverse require the
    // exact bytes, so put the previous clean document back if that happened.
    if (header + buffer !== replacement) {
      header = previousHeader
      buffer = previousBuffer
      applyToEditor(previousBuffer)
      return false
    }

    documentRevision += 1
    const operationRevision = documentRevision
    dirty = header + buffer !== disk
    const shouldPersist = dirty
    emit()
    cancelScheduledSave()
    const result = shouldPersist ? await save() : { kind: 'alreadyCurrent' as const }
    // The save pipeline records failures in snapshot state instead of
    // rejecting. Restore the live document so persistence is all-or-nothing,
    // matching the other transactional session edits.
    if (result.kind === 'failed') {
      if (documentRevision === operationRevision) {
        header = previousHeader
        buffer = previousBuffer
        documentRevision += 1
        applyToEditor(previousBuffer)
        dirty = header + buffer !== disk
        if (result.message !== null) {
          error = null
        }
        emit()
      }
      if (result.message !== null) {
        throw new Error(result.message)
      }
      return false
    }
    return true
  }

  /**
   * Apply an out-of-editor body edit (the Tasks view's toggle / edit / delete,
   * the suggested-contact card's append) transactionally:
   * `transform` rewrites the live document — header plus the unsaved buffer, so
   * concurrent editor edits survive — then we land it now so the Tasks view
   * refreshes promptly. Returns false when the session can't safely take a body
   * edit (no write channel, disposed, protected/read-only, still loading, or a
   * parked conflict) so the caller refuses rather than clobber the buffer via disk.
   * `transform` runs before any mutation, so a `TaskStaleError` (the marker can't
   * be located) propagates with nothing changed. And the write is all-or-nothing:
   * a failed flush reverts the in-memory edit so the editor and the Tasks list
   * can't diverge, then re-throws the failure.
   */
  async function commitBodyEdit(transform: (full: string) => string): Promise<boolean> {
    if (
      io.write === null ||
      disposed ||
      writeParkedForRemoval ||
      isProtected ||
      status !== 'ready' ||
      conflict !== null
    ) {
      return false
    }
    const previousHeader = header
    const previousBuffer = buffer
    const doc = splitDoc(transform(header + buffer))
    header = doc.header
    buffer = doc.body
    applyToEditor(doc.body) // the open editor shows the edited line
    documentRevision += 1
    const operationRevision = documentRevision
    dirty = header + buffer !== disk
    // A no-op edit (transform changed nothing) writes nothing, so a *prior*
    // surfaced save error must not be mistaken for this edit's failure.
    const shouldPersist = dirty
    emit()
    reconcilePendingEditorInput?.()
    cancelScheduledSave()
    const result = shouldPersist ? await save() : { kind: 'alreadyCurrent' as const }
    // Save attempts report failure as data after updating snapshot state.
    // Revert and surface the failure: it persists, or nothing changes.
    if (result.kind === 'failed') {
      if (documentRevision === operationRevision) {
        header = previousHeader
        buffer = previousBuffer
        documentRevision += 1
        applyToEditor(previousBuffer)
        dirty = header + buffer !== disk
        if (result.message !== null) {
          error = null
        }
        emit()
      }
      if (result.message !== null) {
        throw new Error(result.message)
      }
      return false
    }
    return true
  }

  function commitTaskToggle(task: TaskMarker): Promise<boolean> {
    return commitBodyEdit((full) => toggleTaskMarker(full, task).source)
  }

  function commitTaskEdit(task: TaskMarker, content: string): Promise<boolean> {
    return commitBodyEdit((full) => editTaskLine(full, task, content))
  }

  function commitTaskRemove(task: TaskMarker): Promise<boolean> {
    return commitBodyEdit((full) => removeTaskLine(full, task))
  }

  function commitTaskToBullet(task: TaskMarker): Promise<boolean> {
    return commitBodyEdit((full) => taskLineToBullet(full, task))
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

  return {
    get path() {
      return path
    },
    retarget: (to: string) => {
      path = to
      consumeInitialCreateCapability()
      recreateAfterRemoval = false
      if (missing) {
        writeParkedForRemoval = true
        cancelScheduledSave()
      }
    },
    load,
    editorChanged,
    externalChanged,
    externalRemoved,
    flush,
    keepMine,
    loadTheirs,
    content: () => header + buffer,
    liveContent: () => (status === 'ready' ? header + buffer : null),
    isDirty: () => dirty,
    updateFrontmatter,
    commitFrontmatter,
    commitExactContentReplacement,
    commitTaskToggle,
    commitTaskEdit,
    commitTaskRemove,
    commitTaskToBullet,
    commitBodyAppend,
    dispose,
    discard,
  }
}
