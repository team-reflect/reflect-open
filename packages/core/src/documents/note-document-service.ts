import { requireGraphSession, type GraphSessionSource } from '../graph/graph-session.ts'
import { isAppError } from '../errors.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { splitFrontmatter, upsertFrontmatter } from '../markdown/frontmatter.ts'
import { frontmatterPatchToYaml, type FrontmatterPatch } from './note-session-frontmatter.ts'
import type { OpenDocumentsService } from './open-documents-service.ts'

/**
 * The single safe way to read and write a note from an in-app action (pin,
 * private, gist publish): the open session when there is one, otherwise the
 * disk. Each action used to hand-roll the same session-or-disk dance; the two
 * sharp edges live here once:
 *
 * - **Reads** prefer the open session's *loaded* buffer, never a still-loading
 *   one. A loading session reports `liveContent() === null` (its empty buffer
 *   isn't the truth yet), so we fall back to disk rather than act on a
 *   placeholder — the trap behind empty publishes and mis-read toggle states.
 * - **Writes** go through the session when it can take the patch (so our own
 *   write never races a dirty buffer), else a read-patch-write
 *   on disk that a loading/clean session reconciles like any external edit.
 *   Both encode the flag through {@link frontmatterPatchToYaml}, so a value
 *   lands identically whichever channel wins.
 */
export interface NoteDocumentService {
  /**
   * The note's current source, read from the freshest authoritative place: the
   * open session's loaded buffer, or disk when no session has it loaded. A
   * missing file reads as an empty note.
   */
  readSource(path: string): Promise<string>
  /**
   * Read an existing note without disturbing its editor session.
   *
   * An open session's live buffer is newer than disk and can be read without
   * reconciling pending native input (unlike `NoteEditorHandle.getMarkdown`). A
   * closed note falls back to a generation-pinned read so a graph switch cannot
   * return content from the newly active graph.
   */
  readExisting(path: string, generation: number): Promise<string>
  /**
   * Land `patch` on the note's frontmatter, returning once it has persisted.
   * Routes through the live session when one can take the patch; otherwise
   * patches disk directly. A patch that changes nothing is a no-op.
   */
  commitFrontmatter(path: string, patch: FrontmatterPatch, generation: number): Promise<void>
  /**
   * Apply a synchronous full-source `transform` to the note and persist it,
   * routing the same way every time: when the note is **open**, through its
   * live session, which transforms its in-memory buffer synchronously, so
   * unsaved edits survive and there's no read-then-write gap for a concurrent
   * keystroke. The session declines (and we refuse rather than clobber via
   * disk) only when it can't persist now (failed to load, protected/read-only,
   * or disposed); a session still loading waits for its load instead.
   * A decline is surfaced as {@link NoteBusyError}. When the note is **not**
   * open, disk is the source of truth: read, transform, write.
   *
   * Edits to one path are serialized: the next only reads after the previous
   * has written, whether that one resolved or rejected. An error thrown by
   * `transform` propagates untouched and nothing is written.
   */
  commitSourceEdit(
    path: string,
    transform: (source: string) => string,
    options: CommitSourceEditOptions,
  ): Promise<void>
  /**
   * {@link isOstensiblyEmptyNoteSource}.
   */
  isOstensiblyEmpty(source: string): boolean
}

export interface CommitSourceEditOptions {
  /**
   * The index generation the disk write carries.
   */
  readonly generation: number
  /**
   * Treat a missing note as empty: the edit creates it (today's daily).
   */
  readonly createIfMissing?: boolean | undefined
}

/**
 * A note couldn't be written because it is open with unsaved edits that
 * the session can't persist right now: it's read-only/protected or disposed.
 * Distinct from `TaskStaleError` (a stale index): the
 * recovery is "save or resolve the note", not "reindex". We refuse rather than
 * write to disk, which would clobber the live buffer.
 */
export class NoteBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoteBusyError'
  }
}

/**
 * Whether a note's visible markdown body has no authored content. Frontmatter
 * is metadata and does not count; a bare unordered-list marker is also empty
 * because daily notes can open on a starter bullet before the user types.
 */
export function isOstensiblyEmptyNoteSource(source: string): boolean {
  const { body } = splitFrontmatter(source)
  return body.replaceAll(/[-+*#>[\]\s]/g, '') === ''
}

export interface NoteDocumentServiceDeps {
  readonly openDocuments: OpenDocumentsService
  readonly noteFile: NoteFileService
  readonly graphSession: GraphSessionSource
}

class NoteDocumentServiceImpl implements NoteDocumentService {
  readonly #deps: NoteDocumentServiceDeps
  /**
   * One pending-write chain per note path. Source edits read-modify-write a
   * note, so two firing at once on the same note (two checkbox clicks, a bulk
   * delete racing a checkbox) could each read the pre-write source and clobber.
   * Routing every edit through the path's chain serializes them — the next only
   * reads after the previous has written. (The open-note path is already
   * serialized by the session's save chain; this closes the disk path and any
   * open↔closed gap.)
   */
  readonly #writeChains = new Map<string, Promise<unknown>>()

  constructor(deps: NoteDocumentServiceDeps) {
    this.#deps = deps
  }

  async readSource(path: string): Promise<string> {
    const { openDocuments, graphSession } = this.#deps
    const { generation } = requireGraphSession(graphSession)
    return (
      openDocuments.sessionFor(path)?.liveContent() ?? (await this.#readOrEmpty(path, generation))
    )
  }

  async readExisting(path: string, generation: number): Promise<string> {
    const { openDocuments, noteFile } = this.#deps
    const session = openDocuments.sessionFor(path)
    if (session !== null) {
      const liveContent = session.liveContent()
      if (liveContent !== null) {
        // The index and open-document registry can briefly outlive an external
        // delete or iCloud eviction. Prove the generation-pinned file is still
        // locally readable before publishing a live buffer; the already-mounted
        // watcher guards changes that race this read.
        await noteFile.read(path, generation)
        return liveContent
      }
    }
    return await noteFile.read(path, generation)
  }

  async commitFrontmatter(
    path: string,
    patch: FrontmatterPatch,
    generation: number,
  ): Promise<void> {
    const { openDocuments, noteFile } = this.#deps
    const owner = openDocuments.sessionFor(path)
    if (owner !== null && (await owner.commitFrontmatter(patch))) {
      return
    }
    const onDisk = await this.#readOrEmpty(path, generation)
    const patched = upsertFrontmatter(onDisk, frontmatterPatchToYaml(patch))
    if (patched !== onDisk) {
      await noteFile.write(path, patched, generation)
    }
  }

  commitSourceEdit(
    path: string,
    transform: (source: string) => string,
    options: CommitSourceEditOptions,
  ): Promise<void> {
    const { openDocuments, noteFile } = this.#deps
    // Serialize per note: a concurrent change to the same note must not read the
    // pre-write source and clobber this one.
    return this.#serializeByPath(path, async (): Promise<void> => {
      const owner = openDocuments.sessionFor(path)
      if (owner !== null) {
        const applied = await owner.commitSourceEdit(transform)
        if (!applied) {
          throw new NoteBusyError('This note can’t be updated right now — try again in a moment.')
        }
        return
      }
      const source = await this.#readForEdit(
        path,
        options.createIfMissing === true,
        options.generation,
      )
      await noteFile.write(path, transform(source), options.generation)
    })
  }

  isOstensiblyEmpty(source: string): boolean {
    return isOstensiblyEmptyNoteSource(source)
  }

  /**
   * The note's content, where a missing file reads as an empty note — the lazy
   * contract: dailies (and ⌘N notes) are valid frontmatter-toggle targets before
   * their file exists, and the toggle's write is what creates the file. Covers
   * the gap where the pane's session exists but can't take patches yet (still
   * loading) — its post-load reconcile then adopts our write like any external
   * change.
   */
  async #readOrEmpty(path: string, generation: number): Promise<string> {
    try {
      return await this.#deps.noteFile.read(path, generation)
    } catch (cause) {
      if (isAppError(cause) && cause.kind === 'notFound') {
        return ''
      }
      throw cause
    }
  }

  #serializeByPath<T>(path: string, op: () => Promise<T>): Promise<T> {
    const previous = this.#writeChains.get(path) ?? Promise.resolve()
    // Run `op` whether the previous write resolved or rejected — one failure must
    // not wedge the chain for the note.
    const result = previous.then(op, op)
    const settled = result.then(
      () => {},
      () => {},
    )
    this.#writeChains.set(path, settled)
    void settled.then(() => {
      // Drop the entry once the chain goes idle, so the map can't grow unbounded.
      if (this.#writeChains.get(path) === settled) {
        this.#writeChains.delete(path)
      }
    })
    return result
  }

  async #readForEdit(path: string, createIfMissing: boolean, generation: number): Promise<string> {
    try {
      return await this.#deps.noteFile.read(path, generation)
    } catch (cause) {
      if (createIfMissing && isAppError(cause) && cause.kind === 'notFound') {
        return ''
      }
      throw cause
    }
  }
}

export function createNoteDocumentService(deps: NoteDocumentServiceDeps): NoteDocumentService {
  return new NoteDocumentServiceImpl(deps)
}
