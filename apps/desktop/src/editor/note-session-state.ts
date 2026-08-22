import {
  appendBlock,
  detectConflictMarkers,
  editTaskLine,
  errorMessage,
  hashContent,
  isAppError,
  removeTaskLine,
  taskLineToBullet,
  toggleTaskMarker,
  upsertFrontmatter,
  type NoteRevisionWriteOutcome,
  type TaskMarker,
} from '@reflect/core'
import { splitDoc } from './note-session-doc'
import { frontmatterPatchToYaml, type FrontmatterPatch } from './note-session-frontmatter'
import type {
  NoteSession,
  NoteBodyMutationOptions,
  NoteBodyMutationRefusal,
  NoteBodyMutationResult,
  NoteConditionalTrashOptions,
  NoteConditionalTrashResult,
  NoteFreshContent,
  NoteSessionOptions,
  NoteSessionSnapshot,
  NoteSessionStatus,
} from './note-session-types'

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
  /** Serializes out-of-editor body transactions against one another. */
  let bodyMutationChain: Promise<void> = Promise.resolve()
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
  // Set by `discard` — tells `dispose` to skip its flush (the file is being
  // deleted, so rewriting it would recreate it).
  let discarded = false
  /** A move temporarily retains both paths so AI cannot enter its IPC gap. */
  const claimedPaths = new Set<string>()

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
      lastEmitted.conflict === next.conflict &&
      lastEmitted.error === next.error
    ) {
      return
    }
    lastEmitted = next
    onSnapshot(next)
  }

  function enqueueSaveOperation<Result>(
    operation: () => Promise<Result>,
    onRejected?: (cause: unknown) => void,
  ): Promise<Result> {
    const result = saveChain.then(operation)
    saveChain = result.then(
      () => {},
      (cause) => onRejected?.(cause),
    )
    return result
  }

  function save(): void {
    // A discarded session never writes: its file is being deleted, so any
    // save — including a teardown `flush()` (the pane unmounts via flush →
    // dispose) or an already-queued step — would recreate it. A parked
    // conflict likewise pauses all saves: writing the buffer before the user
    // chooses Keep mine / Load theirs would clobber the external change and
    // defeat the non-destructive flow.
    if (discarded || io.write === null || !dirty || isProtected || conflict !== null) {
      return
    }
    const write = io.write
    void enqueueSaveOperation(
      async () => {
        // Re-check at execution time and take the freshest buffer — a queued
        // step can run behind a slow prior write, during which the user may
        // have reverted or kept typing, or the session may have been discarded
        // for a delete. (After dispose the buffer is frozen, so this same step
        // doubles as the final flush.)
        if (discarded || !dirty || isProtected || conflict !== null) {
          return
        }
        const content = header + buffer
        inFlightWrite = content
        try {
          await write(path, content)
          disk = content
          dirty = header + buffer !== content
          missing = false // the landed write created the file if it was missing
          error = null // a previous save failure is resolved by this success
          emit()
          onContent?.(content, 'saved')
        } finally {
          inFlightWrite = null
        }
      },
      (cause) => {
        console.error('failed to save note:', cause)
        error = errorMessage(cause)
        emit()
      },
    )
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

  function flush(): Promise<void> {
    reconcilePendingEditorInput?.()
    cancelScheduledSave()
    save()
    // save() extended the chain synchronously (or left it settled when there
    // was nothing to do) — the chain as of now is exactly this flush's write.
    return saveChain
  }

  function bodyMutationRefusal(): NoteBodyMutationRefusal | null {
    if (io.writeIfRevision === null) {
      return 'no_write'
    }
    if (disposed) {
      return 'disposed'
    }
    if (isProtected) {
      return 'protected'
    }
    if (status !== 'ready') {
      return 'not_ready'
    }
    if (conflict !== null) {
      return 'conflict'
    }
    return null
  }

  async function readFreshContent(
    readPersisted: () => Promise<string> = () => io.read(path),
  ): Promise<NoteFreshContent | null> {
    return await enqueueSaveOperation(async () => {
      if (disposed || status !== 'ready') {
        return null
      }
      reconcilePendingEditorInput?.()
      if (disposed || status !== 'ready') {
        return null
      }
      const persistedSource = await readPersisted()
      if (!reconcilePersistedContent(persistedSource)) {
        return null
      }
      const source = header + buffer
      const revision = await hashContent(source)
      // Hashing yields to editor/frontmatter input. Never return a source that
      // stopped being the complete live document while its revision was being
      // computed: the changed bytes could include a newly-private flag.
      if (disposed || status !== 'ready' || conflict !== null || header + buffer !== source) {
        return null
      }
      return { source, revision }
    })
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
   * Reconcile a source read from disk while the caller owns the relevant
   * operation queue. Clean editors adopt it; dirty editors park it so neither
   * an ordinary save nor an AI mutation can overwrite the external bytes.
   */
  function reconcilePersistedContent(content: string): boolean {
    if (disposed || status !== 'ready') {
      return false
    }
    if (content === disk || content === inFlightWrite) {
      if (missing) {
        missing = false
        emit()
      }
      return true
    }
    if (dirty) {
      cancelScheduledSave()
      conflict = content
      emit()
      return false
    }
    adoptCleanContent(content)
    return true
  }

  /**
   * Re-read the note and reconcile the buffer with what's on disk (the
   * external-change path).
   */
  async function reconcileFromDisk(): Promise<void> {
    let content: string
    try {
      content = await io.read(path)
    } catch {
      return // deleted/unreadable between event and read; nothing to reconcile
    }
    reconcilePersistedContent(content)
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
    conflict = null
    error = null
    emit()
    void (async () => {
      try {
        if (!(await claimOwnership(path))) {
          return
        }
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
  }

  async function claimOwnership(target: string): Promise<boolean> {
    const ownership = io.ownership
    if (ownership === null || ownership === undefined) {
      return !disposed
    }
    try {
      await ownership.claim(target)
      claimedPaths.add(target)
    } catch (cause) {
      // The claim may have landed even when IPC lost its response.
      await ownership.release(target).catch(() => {})
      throw cause
    }
    if (!disposed) {
      return true
    }
    await releaseOwnership(target)
    return false
  }

  async function releaseOwnership(target: string): Promise<void> {
    const ownership = io.ownership
    if (!claimedPaths.has(target) || ownership === null || ownership === undefined) {
      return
    }
    await ownership.release(target)
    claimedPaths.delete(target)
  }

  async function releaseAllOwnership(): Promise<void> {
    for (const target of claimedPaths) {
      try {
        await releaseOwnership(target)
      } catch {
        // A retained native/OS lease is a conservative availability failure;
        // window destruction is the final native cleanup backstop.
      }
    }
  }

  function retarget(to: string): Promise<void> {
    if (io.ownership === null || io.ownership === undefined) {
      path = to
      return Promise.resolve()
    }
    if (claimedPaths.has(to)) {
      if (disposed) {
        return Promise.reject(new Error('the note session was disposed while retargeting'))
      }
      path = to
      return Promise.resolve()
    }
    return claimOwnership(to).then((claimed) => {
      if (!claimed) {
        throw new Error('the note session was disposed while retargeting')
      }
      path = to
    })
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
    if (!updateFrontmatter(patch)) {
      return false
    }
    if (conflict === null) {
      await flush()
      return true
    }
    // Saves are paused: the patch above rides the in-memory header (landing
    // with "keep mine"), so make the other half land too — patch the parked
    // content and write it through. The park refreshes in place, so "load
    // theirs" adopts the patched bytes, and recording the write in `disk`
    // makes the watcher's echo a recognized no-op.
    const patched = upsertFrontmatter(conflict, frontmatterPatchToYaml(patch))
    if (patched !== conflict) {
      await io.write(path, patched)
      conflict = patched
      disk = patched
      emit()
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
  async function performBodyEdit(transform: (full: string) => string): Promise<boolean> {
    if (io.write === null || disposed || isProtected || status !== 'ready' || conflict !== null) {
      return false
    }
    const previousHeader = header
    const previousBuffer = buffer
    const doc = splitDoc(transform(header + buffer))
    header = doc.header
    buffer = doc.body
    applyToEditor(doc.body) // the open editor shows the edited line
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
      header = previousHeader
      buffer = previousBuffer
      applyToEditor(previousBuffer)
      dirty = header + buffer !== disk
      error = null
      emit()
      throw new Error(message)
    }
    return true
  }

  function enqueueBodyMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = bodyMutationChain.then(operation)
    bodyMutationChain = result.then(
      () => {},
      () => {},
    )
    return result
  }

  function commitBodyEdit(transform: (full: string) => string): Promise<boolean> {
    return enqueueBodyMutation(() => performBodyEdit(transform))
  }

  async function performGuardedBodyMutation(
    options: NoteBodyMutationOptions,
  ): Promise<NoteBodyMutationResult> {
    cancelScheduledSave()
    try {
      return await enqueueSaveOperation(async () => {
        reconcilePendingEditorInput?.()
        const initialRefusal = bodyMutationRefusal()
        if (initialRefusal !== null) {
          return { status: 'refused', reason: initialRefusal }
        }

        let persistedSource: string
        try {
          persistedSource = await io.read(path)
        } catch (cause) {
          if (isAppError(cause) && cause.kind === 'notFound') {
            return { status: 'refused', reason: 'missing' }
          }
          throw cause
        }
        if (!reconcilePersistedContent(persistedSource)) {
          return { status: 'refused', reason: conflict === null ? 'not_ready' : 'conflict' }
        }

        const beforeSource = header + buffer
        const beforeRevision = await hashContent(beforeSource)
        // Hashing and the durable prepare callback both yield to the editor. Any
        // intervening keystroke invalidates this operation instead of being folded
        // into a change the model never saw.
        if (header + buffer !== beforeSource || beforeRevision !== options.expectedRevision) {
          const currentSource = header + buffer
          return { status: 'stale', currentRevision: await hashContent(currentSource) }
        }

        const intendedBody = options.transform(buffer)
        const intendedSource = header + intendedBody
        if (detectConflictMarkers(intendedSource) || classify(intendedBody) === 'lossy') {
          return { status: 'refused', reason: 'unsafe_result' }
        }
        if (intendedSource === beforeSource) {
          return { status: 'unchanged', source: beforeSource, revision: beforeRevision }
        }
        const intendedRevision = await hashContent(intendedSource)
        if (header + buffer !== beforeSource) {
          const currentSource = header + buffer
          return { status: 'stale', currentRevision: await hashContent(currentSource) }
        }

        await options.onPrepared?.({
          beforeSource,
          beforeRevision,
          intendedSource,
          intendedRevision,
        })

        // Preparing the durable row can take long enough for native input, a
        // watcher reconciliation, or another UI action to change the document.
        // The entire refresh → prepare → compare-and-swap sequence owns the save
        // queue, so ordinary editor saves can only run before or after it.
        reconcilePendingEditorInput?.()
        const preparedRefusal = bodyMutationRefusal()
        if (preparedRefusal !== null) {
          return { status: 'refused', reason: preparedRefusal }
        }
        if (header + buffer !== beforeSource) {
          const currentSource = header + buffer
          return { status: 'stale', currentRevision: await hashContent(currentSource) }
        }

        const previousHeader = header
        const previousBuffer = buffer
        const persistedBeforeMutation = disk
        const persistedRevision = await hashContent(persistedBeforeMutation)
        if (disk !== persistedBeforeMutation || header + buffer !== beforeSource) {
          const currentSource = header + buffer
          return { status: 'stale', currentRevision: await hashContent(currentSource) }
        }

        buffer = intendedBody
        applyToEditor(intendedBody)
        const afterSource = header + buffer
        if (
          afterSource !== intendedSource ||
          header !== previousHeader ||
          detectConflictMarkers(afterSource) ||
          classify(buffer) === 'lossy'
        ) {
          header = previousHeader
          buffer = previousBuffer
          applyToEditor(previousBuffer)
          return { status: 'refused', reason: 'unsafe_result' }
        }
        dirty = afterSource !== disk
        emit()

        let outcome: NoteRevisionWriteOutcome
        inFlightWrite = afterSource
        try {
          outcome = await io.writeIfRevision!(path, afterSource, persistedRevision)
        } catch (cause) {
          inFlightWrite = null
          await parkPersistedConflict()
          if (header + buffer === afterSource) {
            restoreLiveMutation(previousHeader, previousBuffer)
            throw cause
          }
          return uncertainMutation(
            'live_content_changed',
            beforeSource,
            beforeRevision,
            afterSource,
            intendedRevision,
          )
        } finally {
          inFlightWrite = null
        }

        if (outcome.kind === 'contended') {
          await parkPersistedConflict()
          return uncertainMutation(
            'persisted_write_contended',
            beforeSource,
            beforeRevision,
            afterSource,
            intendedRevision,
          )
        }

        if (outcome.kind === 'blocked') {
          await parkPersistedConflict()
          if (header + buffer !== afterSource) {
            return uncertainMutation(
              'live_content_changed',
              beforeSource,
              beforeRevision,
              afterSource,
              intendedRevision,
            )
          }
          restoreLiveMutation(previousHeader, previousBuffer)
          return { status: 'refused', reason: 'owned_elsewhere' }
        }

        if (outcome.kind !== 'written') {
          await parkPersistedConflict()
          if (header + buffer !== afterSource) {
            return uncertainMutation(
              'live_content_changed',
              beforeSource,
              beforeRevision,
              afterSource,
              intendedRevision,
            )
          }
          restoreLiveMutation(previousHeader, previousBuffer)
          return outcome.kind === 'missing'
            ? { status: 'refused', reason: 'missing' }
            : { status: 'stale', currentRevision: outcome.currentRevision }
        }

        disk = afterSource
        dirty = header + buffer !== afterSource
        missing = false
        error = null
        emit()
        onContent?.(afterSource, 'saved')

        let verifiedSource: string
        try {
          verifiedSource = await io.read(path)
        } catch {
          return uncertainMutation(
            'verification_failed',
            beforeSource,
            beforeRevision,
            afterSource,
            intendedRevision,
          )
        }
        if (verifiedSource !== afterSource || outcome.revision !== intendedRevision) {
          reconcilePersistedContent(verifiedSource)
          return uncertainMutation(
            'persisted_content_mismatch',
            beforeSource,
            beforeRevision,
            afterSource,
            intendedRevision,
          )
        }

        return {
          status: 'applied',
          beforeSource,
          beforeRevision,
          afterSource,
          afterRevision: intendedRevision,
        }
      })
    } finally {
      resumeDirtySave()
    }
  }

  function restoreLiveMutation(previousHeader: string, previousBuffer: string): void {
    header = previousHeader
    buffer = previousBuffer
    applyToEditor(previousBuffer)
    dirty = header + buffer !== disk
    error = null
    emit()
  }

  async function parkPersistedConflict(): Promise<void> {
    let currentPersisted = disk
    try {
      currentPersisted = await io.read(path)
    } catch (cause) {
      if (isAppError(cause) && cause.kind === 'notFound') {
        currentPersisted = ''
      }
    }
    cancelScheduledSave()
    conflict = currentPersisted
    emit()
  }

  function uncertainMutation(
    reason:
      | 'live_content_changed'
      | 'persisted_content_mismatch'
      | 'persisted_write_contended'
      | 'verification_failed',
    beforeSource: string,
    beforeRevision: string,
    intendedSource: string,
    intendedRevision: string,
  ): NoteBodyMutationResult {
    return {
      status: 'uncertain',
      reason,
      beforeSource,
      beforeRevision,
      intendedSource,
      intendedRevision,
    }
  }

  function commitBodyMutation(options: NoteBodyMutationOptions): Promise<NoteBodyMutationResult> {
    return enqueueBodyMutation(() => performGuardedBodyMutation(options))
  }

  function commitConditionalTrash(
    options: NoteConditionalTrashOptions,
  ): Promise<NoteConditionalTrashResult> {
    cancelScheduledSave()
    return enqueueBodyMutation(async () => {
      try {
        return await enqueueSaveOperation<NoteConditionalTrashResult>(async () => {
          reconcilePendingEditorInput?.()
          const refusal = bodyMutationRefusal()
          if (refusal !== null) {
            return { kind: 'refused', reason: refusal }
          }

          let persistedSource: string
          try {
            persistedSource = await io.read(path)
          } catch (cause) {
            if (isAppError(cause) && cause.kind === 'notFound') {
              return { kind: 'missing' }
            }
            throw cause
          }
          if (!reconcilePersistedContent(persistedSource)) {
            return { kind: 'stale', currentRevision: await hashContent(persistedSource) }
          }

          const liveSource = header + buffer
          const liveRevision = await hashContent(liveSource)
          if (
            disposed ||
            status !== 'ready' ||
            conflict !== null ||
            header + buffer !== liveSource ||
            liveRevision !== options.expectedRevision
          ) {
            return { kind: 'stale', currentRevision: await hashContent(header + buffer) }
          }

          const outcome = await options.trash(options.expectedRevision)
          reconcilePendingEditorInput?.()
          if (outcome.kind === 'trashed' && header + buffer === liveSource) {
            discard()
            return outcome
          }
          if (outcome.kind === 'trashed') {
            cancelScheduledSave()
            conflict = ''
            emit()
            return { kind: 'contended', currentRevision: null }
          }
          await parkPersistedConflict()
          return outcome
        })
      } finally {
        resumeDirtySave()
      }
    })
  }

  function resumeDirtySave(): void {
    if (!disposed && dirty && conflict === null) {
      scheduleSave()
    }
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
    const settled = discarded ? Promise.resolve() : flush()
    disposed = true
    void settled.finally(releaseAllOwnership)
  }

  function discard(): void {
    cancelScheduledSave()
    discarded = true
    disposed = true
    void releaseAllOwnership()
  }

  return {
    ownerId: io.ownership?.ownerId ?? null,
    get path() {
      return path
    },
    retarget,
    releaseRetargetedPath: releaseOwnership,
    load,
    editorChanged,
    externalChanged,
    flush,
    keepMine,
    loadTheirs,
    content: () => header + buffer,
    liveContent: () => (status === 'ready' ? header + buffer : null),
    readFreshContent,
    isDirty: () => dirty,
    updateFrontmatter,
    commitFrontmatter,
    commitTaskToggle,
    commitTaskEdit,
    commitTaskRemove,
    commitTaskToBullet,
    commitBodyAppend,
    commitBodyMutation,
    commitConditionalTrash,
    dispose,
    discard,
  }
}
