import type { TaskMarker } from '@reflect/core'
import type { FrontmatterPatch } from './note-session-frontmatter'
import type { RoundTripFidelity } from './roundtrip'

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
  onContent?: ((content: string, origin: NoteContentOrigin) => void) | undefined
  /**
   * Push content into the live editor (external reload / "load theirs"). The
   * editor's change handler may fire synchronously during this call; the
   * session recognizes the re-entry and won't treat it as a user edit.
   */
  applyContent: (markdown: string) => void
  /**
   * Ask the live editor to reconcile native input immediately before
   * persistence. Meowdown synchronously emits `onDocChange` only when that
   * reconciliation changes the document, which updates the session buffer
   * without treating a normalized but unchanged snapshot as a user edit.
   */
  reconcileEditorInput?: () => void
  /**
   * Treat a missing file as an empty note on load instead of an error; the
   * file is then created by the first save — Plan 06's lazy daily-note
   * contract: opening a day never litters the graph, writing does. Applies
   * only to the initial load: a note deleted mid-session still reconciles to
   * a no-op rather than silently emptying the editor.
   */
  createIfMissing?: boolean | undefined
  /**
   * Markdown to seed a **missing** note's buffer with (only meaningful with
   * `createIfMissing`) — the new-note title template. The seed is adopted as
   * the clean dirty-comparison baseline, so opening still writes nothing: the
   * file is created only once the user edits, lazy contract intact. The
   * rename tracker baselines on the real (empty) disk content, so the first
   * authored title stays a birth, not a rename.
   */
  missingSeed?: string | undefined
  saveDebounceMs?: number
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
   * The live document **only when the session has loaded** (`status` is
   * `ready`), else `null`. Distinguishes a genuinely-empty loaded note (return
   * `''` — authoritative) from one still loading (return `null` — the buffer
   * is `''` only because the read hasn't landed). Callers that read the live
   * buffer for an out-of-band use (e.g. sharing) fall back to disk on `null`
   * rather than treating the loading buffer's emptiness as the truth.
   */
  liveContent: () => string | null
  /**
   * Whether the buffer holds unsaved edits right now. A pull accessor for
   * out-of-band consumers (the iCloud conflict sweep skips dirty notes,
   * Plan 21) — everything reactive should keep using snapshots.
   */
  isDirty: () => boolean
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
  /**
   * Toggle a GFM checkbox in the body from the Tasks view (Plan 18), applied to
   * the live buffer so unsaved edits survive, then flushed now. The caller routes
   * here whenever the note is open — the buffer is read synchronously, so there
   * is no read/write race with the editor. Returns false when the session can't
   * take it (loading, protected, disposed, or a parked conflict) so the caller
   * refuses rather than clobber the buffer, and propagates `TaskStaleError` when
   * the marker can't be located, like the disk path. An open note's toggle rides
   * the editor, so a normalizing-fidelity note normalizes like any edit (an
   * exact-fidelity note stays byte-identical apart from the marker).
   */
  commitTaskToggle: (task: TaskMarker) => Promise<boolean>
  /**
   * Replace a task's text from the inline Tasks editor (Plan 18): rewrites the
   * marker's content line in the live buffer (preserving the marker and so the
   * checked state), reflects it in the open editor, and flushes now. Same gating,
   * `false`-when-busy, transactional revert, and `TaskStaleError` propagation as
   * {@link commitTaskToggle}. `content` is one line of markdown.
   */
  commitTaskEdit: (task: TaskMarker, content: string) => Promise<boolean>
  /**
   * Delete a task's whole line from the Tasks view (Plan 18) — the ⌫/⌘⌫ path.
   * Removes the physical line from the live buffer and flushes now; same gating,
   * `false`-when-busy, transactional revert, and `TaskStaleError` propagation as
   * {@link commitTaskToggle}.
   */
  commitTaskRemove: (task: TaskMarker) => Promise<boolean>
  /**
   * Demote a task to a plain bullet from the Tasks view — the "Convert to bullet"
   * path (Plan 18 follow-up). Strips just the marker from the line in the live
   * buffer (keeping its content) so the item leaves the Tasks projection while
   * staying in the note, then flushes now; same gating, `false`-when-busy,
   * transactional revert, and `TaskStaleError` propagation as {@link commitTaskToggle}.
   */
  commitTaskToBullet: (task: TaskMarker) => Promise<boolean>
  /**
   * Append a markdown block to the end of the body (own paragraph, blank-line
   * separated — `appendBlock`) from an out-of-editor action like the
   * suggested-contact card's Add, applied to the live buffer so unsaved edits
   * survive, reflected in the open editor, and flushed now. Same gating,
   * `false`-when-busy, and transactional revert as {@link commitTaskToggle}.
   * A blank block is refused (`false`) — there is nothing to write.
   */
  commitBodyAppend: (block: string) => Promise<boolean>
  /** Flush pending edits and detach: no further snapshots are emitted. */
  dispose: () => void
  /**
   * Detach **without** flushing — for deleting the note: a final flush (which
   * `dispose` performs) would rewrite the buffer and recreate the file we are
   * removing. After `discard`, a later `dispose` (e.g. on the pane's unmount)
   * is a no-op. Pending saves are cancelled.
   */
  discard: () => void
}
