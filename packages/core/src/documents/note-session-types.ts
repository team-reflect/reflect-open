import type { Store } from '../store.ts'
import type { Unlisten } from '../unlisten.ts'
import type { FrontmatterPatch } from './note-session-frontmatter.ts'
import type { RoundTripFidelity } from '@meowdown/markdown'

export type NoteSessionStatus = 'loading' | 'ready' | 'error'

/** The observable document state of a {@link NoteSession}. */
export interface NoteSessionSnapshot {
  /**
   * The session's path; a rename that retargets the session reports its new
   * one.
   */
  path: string
  status: NoteSessionStatus
  /**
   * The note's Markdown as of the last load or adopted file change: the body,
   * or the **full** file while `protected` (the read-only view shows a file we
   * refuse to touch, frontmatter included). It does not follow typing.
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
   * The document's `private: true` frontmatter flag, as the session holds it:
   * the loaded header, followed by frontmatter commits and external reloads.
   * True while loading, so nothing leaves the device before the header is
   * known.
   */
  isPrivate: boolean
  /**
   * True when the initial load found no file (the lazy-create contract): the
   * note exists only as this buffer until the first save lands.
   */
  missing: boolean
  error: string | null
}

/**
 * What a session needs from the editor that shows it.
 */
export interface NoteSessionEditor {
  /**
   * Returns the document as Markdown, after reconciling pending native input.
   * When that reconciliation changes the document, the editor reports it
   * through {@link NoteSession.editorChanged} synchronously before returning.
   */
  getMarkdown(this: void): string
  /**
   * Replaces the document without reporting a change. The editor's change
   * handler may still fire synchronously during this call; the session
   * recognizes the re-entry and does not treat it as a user edit.
   */
  setMarkdown(markdown: string): void
}

/** Why {@link NoteSessionOptions.onContent} fired. */
export type NoteContentOrigin = 'load' | 'external' | 'saved'

export interface NoteSessionOptions {
  /**
   * Graph-relative path of the note this session owns. Every write is pinned
   * to the generation of the graph open at creation, read at write time so a
   * reopen of that graph carries over.
   */
  path: string
  /**
   * {@link NoteSession.id}.
   */
  id: number
  /**
   * Round-trip fidelity check gating editability (meowdown's `checkRoundTrip`).
   */
  classify: (markdown: string) => RoundTripFidelity
  /**
   * Called when the session gets its first subscriber, with `true`, and when
   * it has had none for a microtask, with `false`.
   */
  onObservedChange?: ((observed: boolean) => void) | undefined
  /**
   * Called when {@link NoteSession.discard} runs.
   */
  onDiscard?: (() => void) | undefined
  /**
   * Receives the full document (frontmatter + body) whenever it transitions
   * to a known-on-disk state: the initial load, an adopted external change
   * (including a save that merged with a newer disk text), or a landed save.
   * `saved` is the only user-driven origin: the title-rename tracker
   * (Plan 07b) keys off it.
   */
  onContent?: ((content: string, origin: NoteContentOrigin) => void) | undefined
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
  saveDebounceMs?: number | undefined
}
/**
 * Rewrites the full text of a note. `revision` is the hash of `source` as the
 * note file holds it, or `null` when `source` holds unsaved edits or the note
 * has no file.
 */
export type NoteSourceTransform = (source: string, revision: string | null) => string

/**
 * What {@link NoteSession.commitSourceEdit} left on disk.
 */
export interface NoteSessionCommit {
  /**
   * The full note text on disk after the flush.
   */
  readonly content: string
  /**
   * Lowercase hex SHA-256 of `content`; `null` when the note has no file.
   */
  readonly revision: string | null
  /**
   * Whether `content` differs from the text the transform returned: the write
   * merged with a newer disk text, or keystrokes landed during the flush.
   */
  readonly merged: boolean
}

/**
 * One note in memory: its text, its save pipeline, and its state as a
 * `Store`. Get it from {@link NoteSessionService.sessionFor}. A subscriber is
 * a view of the note: the session follows the note file while it has one.
 */
export interface NoteSession extends Store<NoteSessionSnapshot> {
  /**
   * Identifies this session among the sessions of its service. A rename keeps it.
   */
  readonly id: number
  /** The graph-relative path this session is bound to. A note move changes it. */
  readonly path: string
  /**
   * The Markdown a mounting editor opens on: the current body, or `null` when
   * the note shows no editor (not `ready`, or `protected`).
   */
  editorSeed(): string | null
  /** Every editor document change enters the pipeline here. */
  editorChanged(markdown: string): void
  /**
   * Attach the editor that shows this session; returns the detach. One editor
   * at a time: a second attach replaces the first. The detach reconciles the
   * editor's pending input into the session first, so its last keystrokes
   * reach disk.
   */
  attachEditor(editor: NoteSessionEditor): Unlisten
  /**
   * Persist pending edits now (e.g. on window blur). Resolves once the
   * flushed write has settled — quit-time teardown awaits this so the webview
   * can't die before the bytes land.
   */
  flush(): Promise<void>
  /** The full current document (frontmatter + buffer), as a save would write it. */
  content(): string
  /**
   * The live document **only when the session has loaded** (`status` is
   * `ready`), else `null`. Distinguishes a genuinely-empty loaded note (return
   * `''` — authoritative) from one still loading (return `null` — the buffer
   * is `''` only because the read hasn't landed). Callers that read the live
   * buffer for an out-of-band use (e.g. sharing) fall back to disk on `null`
   * rather than treating the loading buffer's emptiness as the truth.
   */
  liveContent(): string | null
  /**
   * Whether the buffer holds unsaved edits right now. A pull accessor for
   * out-of-band consumers (the iCloud conflict sweep skips dirty notes,
   * Plan 21) — everything reactive should keep using snapshots.
   */
  isDirty(): boolean
  /**
   * Whether this lazy-created note still exists only in the editor session.
   * Returns false while loading, once a file is known to exist, or while a
   * first write is already in flight. An unpersisted session can be discarded
   * without issuing a filesystem delete.
   */
  isUnpersisted(): boolean
  /**
   * Pause new saves and wait for the initial load plus any write already in
   * flight before deletion chooses between local discard and filesystem
   * trash. Returns true when no backing file exists. The caller must finish
   * with {@link NoteSession.discard} on success or
   * {@link NoteSession.cancelDelete} when filesystem deletion fails.
   */
  prepareDelete(): Promise<boolean>
  /** Resume normal persistence after a prepared filesystem deletion fails. */
  cancelDelete(): void
  /**
   * Patch frontmatter keys (e.g. `aliases`, Plan 07b) without touching the
   * editor: the header is updated in place and saved through the normal
   * pipeline. Returns false (and does nothing) when the session can't take
   * the patch — disposed, protected, or not yet `ready`. All three mean the
   * same thing to a caller: this channel is unavailable, use the fallback
   * (a write to the note file, which a live session then reconciles like any
   * external change).
   */
  updateFrontmatter(patch: FrontmatterPatch): boolean
  /**
   * {@link NoteSession.updateFrontmatter}, but the patch **lands on disk now**
   * through a flush. Same gating and false-return as `updateFrontmatter`.
   */
  commitFrontmatter(patch: FrontmatterPatch): Promise<boolean>
  /**
   * Apply a synchronous full-source transform to the live buffer (so unsaved
   * edits survive), reflect it in the open editor, and flush now. The Tasks
   * view routes its edits here whenever the note is open: the buffer is read
   * synchronously, so there is no read/write race with the editor. A session
   * still loading waits for the load, then applies the edit to the loaded
   * buffer. Returns `null` when the session can't take it (failed to load,
   * protected, or disposed) so the caller refuses rather than clobber the
   * buffer; an error thrown by `transform` (a stale task locator) propagates
   * untouched, and a failed flush reverts the in-memory edit before
   * rethrowing.
   */
  commitSourceEdit(transform: NoteSourceTransform): Promise<NoteSessionCommit | null>
  /**
   * Detach **without** flushing — for deleting the note: a flush would rewrite
   * the buffer and recreate the file we are removing. Pending saves are
   * cancelled, no further snapshots are emitted, and the service forgets the
   * session.
   */
  discard(): void
}

/**
 * A {@link NoteSession} with the operations of its owner, the {@link NoteSessionService}.
 */
export interface ManagedNoteSession extends NoteSession {
  /**
   * Rebind the session to a renamed path (Plan 17). The *file* moved; the
   * document didn't: buffer, header, and dirtiness are all
   * untouched, and every subsequent read/write uses `to`. Call after flushing,
   * right before the file move lands, so a racing save can never resurrect
   * the old path.
   */
  retarget(to: string): void
  /** The watcher reported an on-disk change to this note; reconcile. */
  externalChanged(): void
  /**
   * Bring the session up to date with the note file. Resolves when the session
   * holds the result. A session that has not loaded, or failed to, loads. A
   * loaded clean session ends as a fresh load would, without passing through
   * `loading`; a dirty one reconciles as for
   * {@link ManagedNoteSession.externalChanged}.
   */
  revalidate(): Promise<void>
  /**
   * Whether a write is queued or in flight.
   */
  isSaving(): boolean
  /**
   * Flush pending edits and detach: no further snapshots are emitted. Resolves
   * once the flushed write has settled.
   */
  dispose(): Promise<void>
}

/**
 * The note sessions of the open graph, one per note path. A session lives
 * here, not in the view that shows it: a view that goes away leaves the
 * session, its text, and its pending writes in place.
 *
 * A session with a subscriber is **observed**: it reconciles with the note
 * file on every change. An unobserved session reads nothing; a change to its
 * file marks it stale, and it catches up when it is next observed or
 * committed to. When the last subscriber leaves, the session flushes and its
 * pending title rename settles. The service keeps a bounded number of
 * unobserved sessions and disposes the least recently observed clean ones.
 */
export interface NoteSessionService {
  /**
   * Returns the session of `path`. Creates it on first use, without reading the file.
   */
  sessionFor(path: string): NoteSession
  /**
   * Returns the session of `path` when one exists. It may be stale: use
   * {@link NoteSessionService.currentSessionFor} to read or commit through it.
   */
  existingSessionFor(path: string): NoteSession | null
  /**
   * Returns the session of `path` when one exists, after it has caught up with the note file.
   */
  currentSessionFor(path: string): Promise<NoteSession | null>
  /**
   * Starts the load of the session of `path` before a view needs it.
   */
  prefetch(path: string): void
  /**
   * Paths of sessions that hold unsaved edits right now. The iCloud conflict
   * sweep (Plan 21) defers these.
   */
  dirtyPaths(): string[]
  /**
   * The note file of `path` may have changed with no event: as for
   * {@link NoteSessionService.invalidateAll}, for the one session.
   */
  invalidate(path: string): void
  /**
   * The note files may have changed with no per-file event: observed sessions
   * reconcile now, the others when they are next observed. The index
   * lifecycle calls this after each completed reconcile pass. On iOS there is
   * no file watcher, so a resume reconcile is the only signal a remote edit
   * produces.
   */
  invalidateAll(): void
  /**
   * Carry the session of `from` to `to` (Plan 17): its later writes go to
   * `to`, and its title rename tracks `to`. A session already at `to` is
   * disposed. Returns the moved session, or `null` when `from` has none.
   */
  moveSession(from: string, to: string): NoteSession | null
  /**
   * Flush every buffer, fire each session's pending settle-time work, and
   * settle once all of it has landed. Failures are surfaced per session by the
   * save pipeline already; teardown must proceed past them, so rejections are
   * absorbed, never re-thrown.
   */
  flushAll(): Promise<void>
  /**
   * Flush and dispose every session: the graph they belong to is going away.
   */
  releaseAll(): void
}
