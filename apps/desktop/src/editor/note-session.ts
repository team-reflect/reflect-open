import {
  errorMessage,
  isAppError,
  splitFrontmatter,
  upsertFrontmatter,
  type GistFrontmatter,
} from '@reflect/core'
import type { RoundTripFidelity } from './roundtrip'

/**
 * The save pipeline + external-change reconciliation for one open note
 * (Plan 05 steps 4–5), as a pure state machine — no React, no editor, no IPC.
 * `useNoteDocument` adapts it to React; tests drive it directly.
 *
 * A session is created for one `path` and lives until {@link NoteSession.dispose}.
 * Binding the path at construction keeps the machine simple: a note switch is
 * "dispose the old session (which flushes its buffer to *its* path), create a
 * new one" — there is no cross-note state to guard. The one sanctioned path
 * mutation is {@link NoteSession.retarget} (Plan 17): a rename moves the
 * *file*, not the document, so the same session continues under the new path
 * — content, dirtiness, and conflict state untouched. Lifecycle policy around
 * that (adopt vs teardown) lives in `document-binding.ts`, not here.
 *
 * Saves are debounced atomic writes (Plan 02); indexing is **not** triggered
 * here — the watcher is the sole incremental-reindex path (Plan 04b), so our own
 * write flows file → watcher → index like any other change. The same watcher
 * event comes back to us; we recognize the echo by content (it matches what we
 * last saved) and ignore it. A real external change reloads a clean buffer
 * imperatively, and **never clobbers a dirty one** — it parks as `conflict` for
 * the user to resolve.
 *
 * **Frontmatter is the session's, not the editor's** (Plan 07b): meowdown
 * mangles a `---` block (it reads as thematic breaks/setext), so the editor
 * sees only the body — the session splits every disk read, keeps the exact
 * header bytes aside, and rejoins them on every write. This is also what makes
 * frontmatter notes editable at all (a joined round-trip classifies lossy),
 * and gives metadata writes ({@link NoteSession.updateFrontmatter}) a channel
 * that never disturbs the editor view.
 */

const DEFAULT_SAVE_DEBOUNCE_MS = 800

export type NoteSessionStatus = 'loading' | 'ready' | 'error'

/** The observable document state, emitted to `onSnapshot` whenever it changes. */
export interface NoteSessionSnapshot {
  status: NoteSessionStatus
  /**
   * Markdown to seed the editor with once `status` is `ready` — the body
   * (the editor never sees frontmatter). While `protected` it is the **full**
   * file instead: the read-only view's job is honest display of a file we
   * refuse to touch, frontmatter included.
   */
  initialContent: string
  /**
   * True when the editor cannot faithfully round-trip this note (a converter
   * gap, e.g. task lists today) — the note opens read-only and is **never**
   * auto-rewritten, so no content can be silently lost.
   */
  protected: boolean
  /** True while the buffer has changes not yet written to disk. */
  dirty: boolean
  /**
   * True when the initial load found no file (the lazy-create contract): the
   * note exists only as this buffer until the first save lands.
   */
  missing: boolean
  /** External content waiting on the user's choice (set only when dirty). */
  conflict: string | null
  error: string | null
}

/** The snapshot before a session has loaded anything. */
export const INITIAL_NOTE_SNAPSHOT: NoteSessionSnapshot = {
  status: 'loading',
  initialContent: '',
  protected: false,
  dirty: false,
  missing: false,
  conflict: null,
  error: null,
}

/** File access injected by the host (the hook binds `@reflect/core` commands). */
export interface NoteSessionIo {
  read: (path: string) => Promise<string>
  /**
   * Atomic write, with the graph generation pre-bound by the host. `null` when
   * no generation is available — the session then tracks dirtiness but never
   * writes.
   */
  write: ((path: string, contents: string) => Promise<void>) | null
}

/** Why {@link NoteSessionOptions.onContent} fired. */
export type NoteContentOrigin = 'load' | 'external' | 'saved'

export interface NoteSessionOptions {
  /** Graph-relative path of the note this session owns. */
  path: string
  io: NoteSessionIo
  /** Round-trip fidelity check gating editability (see `roundtrip.ts`). */
  classify: (markdown: string) => RoundTripFidelity
  /** Receives every state change. Not called after `dispose()`. */
  onSnapshot: (snapshot: NoteSessionSnapshot) => void
  /**
   * Receives the full document (frontmatter + body) whenever it transitions
   * to a known-on-disk state: the initial load, an adopted external change
   * (including "load theirs"), or a landed save. `saved` is the only
   * user-driven origin — the title-rename tracker (Plan 07b) keys off it.
   */
  onContent?: (content: string, origin: NoteContentOrigin) => void
  /**
   * Push content into the live editor (external reload / "load theirs"). The
   * editor's change handler may fire synchronously during this call; the
   * session recognizes the re-entry and won't treat it as a user edit.
   */
  applyContent: (markdown: string) => void
  /**
   * Treat a missing file as an empty note on load instead of an error; the
   * file is then created by the first save — Plan 06's lazy daily-note
   * contract: opening a day never litters the graph, writing does. Applies
   * only to the initial load: a note deleted mid-session still reconciles to
   * a no-op rather than silently emptying the editor.
   */
  createIfMissing?: boolean
  /**
   * Markdown to seed a **missing** note's buffer with (only meaningful with
   * `createIfMissing`) — the new-note title template. The seed is adopted as
   * the clean dirty-comparison baseline, so opening still writes nothing: the
   * file is created only once the user edits, lazy contract intact. The
   * rename tracker baselines on the real (empty) disk content, so the first
   * authored title stays a birth, not a rename.
   */
  missingSeed?: string
  saveDebounceMs?: number
}

/**
 * The frontmatter keys the app patches through a live session — deliberately
 * narrower than what `upsertFrontmatter` can write, so a typo'd key can't
 * silently land junk in a note's header. Extend it when a new key earns a
 * session-channel writer.
 */
export interface FrontmatterPatch {
  /** Alternative wiki-link titles for this note (the Plan 07b auto-alias). */
  aliases?: string[]
  /**
   * Sidebar pin. `true` pins; a number pins with an explicit order (what the
   * future reorder UI writes); `false` deletes the key rather than writing
   * `pinned: false` — unpinned is the absence of the flag, and a note whose
   * only metadata was the pin returns to having no frontmatter at all.
   */
  pinned?: boolean | number
  /**
   * The hard privacy flag (`private: true`): the note's content must never be
   * sent to AI or any other external service. `false` deletes the key — like
   * the pin, not-private is the absence of the flag.
   */
  private?: boolean
  /**
   * The published GitHub Gist block (id, url, file, hash of the published
   * body) — written whole after every publish. Publishing is set-only in the
   * first wave; there is no unpublish, so no delete encoding either.
   */
  gist?: GistFrontmatter
}

/** Translate the typed patch into the YAML write (`undefined` deletes a key). */
function yamlPatch(patch: FrontmatterPatch): Record<string, unknown> {
  const yaml: Record<string, unknown> = {}
  if (patch.aliases !== undefined) {
    yaml.aliases = patch.aliases
  }
  if (patch.pinned !== undefined) {
    yaml.pinned = patch.pinned === false ? undefined : patch.pinned
  }
  if (patch.private !== undefined) {
    yaml.private = patch.private === false ? undefined : true
  }
  if (patch.gist !== undefined) {
    // Spelled out key-by-key so the YAML block's shape (and key order) is
    // this module's contract, not whatever object the caller happened to hold.
    yaml.gist = {
      id: patch.gist.id,
      url: patch.gist.url,
      file: patch.gist.file,
      hash: patch.gist.hash,
    }
  }
  return yaml
}

/** One open note's document lifecycle. Create via {@link createNoteSession}. */
export interface NoteSession {
  /** The graph-relative path this session is bound to (mutable via {@link NoteSession.retarget}). */
  readonly path: string
  /**
   * Rebind the session to a renamed path (Plan 17). The *file* moved; the
   * document didn't — buffer, header, dirtiness, and conflict state are all
   * untouched, and every subsequent read/write uses `to`. Call after flushing,
   * right before the file move lands, so a racing save can never resurrect
   * the old path.
   */
  retarget: (to: string) => void
  /** Read the note and emit `ready` (or `error`). Call once after creation. */
  load: () => void
  /** Every editor document change enters the pipeline here. */
  editorChanged: (markdown: string) => void
  /** The watcher reported an on-disk change to this note; reconcile. */
  externalChanged: () => void
  /**
   * Persist pending edits now (e.g. on window blur). Resolves once the
   * flushed write has settled — quit-time teardown awaits this so the webview
   * can't die before the bytes land.
   */
  flush: () => Promise<void>
  /** Resolve a conflict by keeping the buffer (rewrites the file). */
  keepMine: () => void
  /** Resolve a conflict by loading the external content (discards the buffer). */
  loadTheirs: () => void
  /** The full current document (frontmatter + buffer), as a save would write it. */
  content: () => string
  /**
   * Patch frontmatter keys (e.g. `aliases`, Plan 07b) without touching the
   * editor: the header is updated in place and saved through the normal
   * pipeline. Returns false (and does nothing) when the session can't take
   * the patch — disposed, protected, or not yet `ready`. All three mean the
   * same thing to a caller: this channel is unavailable, use the fallback
   * (the rename coordinator writes straight to disk, which a live session
   * then reconciles like any external change).
   */
  updateFrontmatter: (patch: FrontmatterPatch) => boolean
  /**
   * {@link NoteSession.updateFrontmatter}, but the patch **lands on disk now**
   * regardless of session state. Normally that's a flush; under a parked
   * conflict — where saves are paused and a flush is a deliberate no-op — the
   * contested content is patched and written through too, so the index sees
   * the change immediately and *both* resolutions keep it ("keep mine" writes
   * the patched header, "load theirs" adopts the patched park). Same gating
   * and false-return as `updateFrontmatter`. For patches that should ride the
   * resolution instead (the rename alias), use `updateFrontmatter`.
   */
  commitFrontmatter: (patch: FrontmatterPatch) => Promise<boolean>
  /** Flush pending edits and detach: no further snapshots are emitted. */
  dispose: () => void
}

/** Exact frontmatter bytes (may be empty) and the body that follows them. */
function splitDoc(content: string): { header: string; body: string } {
  const { body, bodyOffset } = splitFrontmatter(content)
  return { header: content.slice(0, bodyOffset), body }
}

/** Create the document session for one note. See the module doc for semantics. */
export function createNoteSession(options: NoteSessionOptions): NoteSession {
  const { io, classify, onSnapshot, applyContent, onContent } = options
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

  function save(): void {
    // A parked conflict pauses all saves: writing the buffer before the user
    // chooses Keep mine / Load theirs would clobber the external change and
    // defeat the non-destructive flow.
    if (io.write === null || !dirty || isProtected || conflict !== null) {
      return
    }
    const write = io.write
    saveChain = saveChain
      .then(async () => {
        // Re-check at execution time and take the freshest buffer — a queued
        // step can run behind a slow prior write, during which the user may
        // have reverted or kept typing. (After dispose the buffer is frozen, so
        // this same step doubles as the final flush.)
        if (!dirty || isProtected || conflict !== null) {
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
      })
      .catch((cause) => {
        console.error('failed to save note:', cause)
        error = errorMessage(cause)
        emit()
      })
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
      // Never clobber unsaved edits — park the external content and pause the
      // save pipeline (cancel any pending debounce) until the user chooses; a
      // save landing now would overwrite "theirs" first.
      cancelScheduledSave()
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
    missedChange = false
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
          if (missedChange) {
            missedChange = false
            void reconcileFromDisk()
          }
        }
      }
    })()
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
    header = splitDoc(upsertFrontmatter(header + buffer, yamlPatch(patch))).header
    dirty = header + buffer !== disk
    emit()
    if (dirty) {
      scheduleSave()
    }
    return true
  }

  async function commitFrontmatter(patch: FrontmatterPatch): Promise<boolean> {
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
    if (io.write !== null) {
      const patched = upsertFrontmatter(conflict, yamlPatch(patch))
      if (patched !== conflict) {
        await io.write(path, patched)
        conflict = patched
        disk = patched
        emit()
      }
    }
    return true
  }

  function dispose(): void {
    // Flush first: the queued save step reads the (now frozen) buffer, so
    // pending edits persist to this session's path even after the UI moves on.
    void flush()
    disposed = true
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
    keepMine,
    loadTheirs,
    content: () => header + buffer,
    updateFrontmatter,
    commitFrontmatter,
    dispose,
  }
}
