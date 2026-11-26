import { NoteEditError } from './note-edit-error.ts'
import { requireGraphSession, type GraphSessionSource } from '../graph/graph-session.ts'
import { isAppError } from '../errors.ts'
import type { NoteRead, WritableNoteFileService } from '../graph/note-file-service.ts'
import type { IndexLifecycleService } from '../indexing/index-lifecycle-service.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import { splitFrontmatter, upsertFrontmatter } from '../markdown/frontmatter.ts'
import { frontmatterPatchToYaml, type FrontmatterPatch } from './note-session-frontmatter.ts'
import type {
  NoteSessionCommit,
  NoteSessionService,
  NoteSourceTransform,
} from './note-session-types.ts'
import { noop } from '@ocavue/utils'

/**
 * The single safe way to read and write a note from an in-app action (pin,
 * private, gist publish): the note's session when it has one, otherwise the
 * disk. A session that followed no file changes catches up with the note file
 * first. A note with no session gets none: a bulk edit reads and writes the
 * files directly. It handles two sharp edges:
 *
 * - **Reads** prefer the session's *loaded* buffer, never a still-loading
 *   one. A loading session reports `liveContent() === null` (its empty buffer
 *   isn't the truth yet), so we fall back to disk rather than act on a
 *   placeholder — the trap behind empty publishes and mis-read toggle states.
 * - **Writes** go through the session when it can take the patch (so our own
 *   write never races a dirty buffer), else a read-patch-write
 *   on disk that the session reconciles like any external edit.
 *   Both encode the flag through {@link frontmatterPatchToYaml}, so a value
 *   lands identically whichever channel wins.
 */
export interface NoteDocumentService {
  /**
   * The note's current source, read from the freshest authoritative place: the
   * session's loaded buffer, or disk when no session has it loaded. A
   * missing file reads as an empty note.
   */
  readSource(path: string): Promise<string>
  /**
   * Read an existing note without disturbing its editor session.
   *
   * A session's live buffer is newer than disk and can be read without
   * reconciling pending native input (unlike `NoteEditorHandle.getMarkdown`). A
   * note with no session falls back to a generation-pinned read so a graph switch cannot
   * return content from the newly active graph.
   */
  readExisting(path: string, generation: number): Promise<string>
  /**
   * Land `patch` on the note's frontmatter, returning once it has persisted.
   * Routes through the live session when one can take the patch; otherwise
   * patches the file, and creates a missing one, with the disk rules of
   * {@link NoteDocumentService.commitSourceEdit}. A patch that changes
   * nothing is a no-op. The index holds the patched note before the promise
   * resolves. A {@link FrontmatterPatcher} makes the patch from
   * the text it lands on.
   */
  commitFrontmatter(
    path: string,
    patch: FrontmatterPatch | FrontmatterPatcher,
    generation: number,
  ): Promise<void>
  /**
   * Apply a synchronous full-source `transform` ({@link NoteSourceTransform}) to the note and persist it,
   * routing the same way every time: when the note has a **session**, through
   * it, which transforms its in-memory buffer synchronously, so
   * unsaved edits survive and there's no read-then-write gap for a concurrent
   * keystroke. The session declines only when it can't persist now (failed
   * to load, protected, or disposed); a session still loading waits
   * for its load instead. A decline of a session with unsaved edits is
   * surfaced as `notWritable` {@link NoteEditError}. When the note has **no**
   * session, or its session declined and holds no unsaved edits, disk is the
   * source of truth: read, transform, and write only while
   * the file still holds the text that was read. A file that changed in
   * between runs `transform` again on its new text, and
   * `conflict` {@link NoteEditError} is thrown after three attempts. A `transform`
   * that returns its input writes nothing.
   *
   * The index holds the committed text before the result resolves.
   *
   * Edits to one path are serialized: the next only reads after the previous
   * has written, whether that one resolved or rejected. An error thrown by
   * `transform` propagates untouched and nothing is written.
   */
  commitSourceEdit(
    path: string,
    transform: NoteSourceTransform,
    options: CommitSourceEditOptions,
  ): Promise<NoteCommitResult>
  /**
   * {@link isOstensiblyEmptyNoteSource}.
   */
  isOstensiblyEmpty(source: string): boolean
}

/**
 * The frontmatter patch for a note that holds `source`, or `null` to leave
 * the note as it is. `source` is `null` for a note with no file.
 */
export type FrontmatterPatcher = (source: string | null) => FrontmatterPatch | null

/**
 * How many times a disk commit runs its transform against a file that keeps changing.
 */
const COMMIT_ATTEMPT_LIMIT = 3

/**
 * What {@link NoteDocumentService.commitSourceEdit} left on disk.
 */
export interface NoteCommitResult extends NoteSessionCommit {
  /**
   * The seq of an index commit that holds `content`. `null` when the commit
   * wrote nothing, the index is closed or suspended, or the index write failed.
   */
  readonly indexSeq: number | null
}

export interface CommitSourceEditOptions {
  /**
   * The graph generation the disk write carries.
   */
  readonly generation: number
  /**
   * Treat a missing note as empty: the edit creates it (today's daily).
   */
  readonly createIfMissing?: boolean | undefined
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
  readonly noteSessions: NoteSessionService
  readonly noteFile: WritableNoteFileService
  readonly graphSession: GraphSessionSource
  readonly indexLifecycle: IndexLifecycleService
  readonly logger: LoggerService
}

class NoteDocumentServiceImpl implements NoteDocumentService {
  readonly #deps: NoteDocumentServiceDeps
  /**
   * One pending-write chain per note path. Source edits read-modify-write a
   * note, so two firing at once on the same note (two checkbox clicks, a bulk
   * delete racing a checkbox) could each read the pre-write source and clobber.
   * Routing every edit through the path's chain serializes them — the next only
   * reads after the previous has written. (The session path is already
   * serialized by the session's save chain; this closes the disk path and any
   * gap between the two.)
   */
  readonly #writeChains = new Map<string, Promise<unknown>>()

  constructor(deps: NoteDocumentServiceDeps) {
    this.#deps = deps
  }

  async readSource(path: string): Promise<string> {
    const { noteSessions, graphSession } = this.#deps
    const { generation } = requireGraphSession(graphSession)
    const session = await noteSessions.currentSessionFor(path)
    return session?.liveContent() ?? (await this.#readOrEmpty(path, generation))
  }

  async readExisting(path: string, generation: number): Promise<string> {
    const { noteSessions, noteFile } = this.#deps
    const session = await noteSessions.currentSessionFor(path)
    if (session !== null) {
      const liveContent = session.liveContent()
      if (liveContent !== null) {
        // The index and the session can briefly outlive an external
        // delete or iCloud eviction. Prove the generation-pinned file is still
        // locally readable before publishing a live buffer.
        await noteFile.read(path, generation)
        return liveContent
      }
    }
    return await noteFile.read(path, generation)
  }

  commitFrontmatter(
    path: string,
    patch: FrontmatterPatch | FrontmatterPatcher,
    generation: number,
  ): Promise<void> {
    const { noteSessions } = this.#deps
    const patchOf = typeof patch === 'function' ? patch : () => patch
    return this.#serializeByPath(path, async () => {
      const owner = await noteSessions.currentSessionFor(path)
      // Only a patcher reads the buffer of the session.
      const live = typeof patch === 'function' ? (owner?.liveContent() ?? null) : ''
      if (owner !== null && live !== null) {
        const livePatch = patchOf(live)
        if (livePatch === null) {
          return
        }
        if (await owner.commitFrontmatter(livePatch)) {
          await this.#indexCommit(path, generation, undefined)
          return
        }
      }
      await this.#commitToDisk(
        path,
        (source) => {
          const diskPatch = patchOf(source)
          return diskPatch === null
            ? (source ?? '')
            : upsertFrontmatter(source ?? '', frontmatterPatchToYaml(diskPatch))
        },
        generation,
        true,
      )
    })
  }

  commitSourceEdit(
    path: string,
    transform: NoteSourceTransform,
    options: CommitSourceEditOptions,
  ): Promise<NoteCommitResult> {
    const { noteSessions } = this.#deps
    // Serialize per note: a concurrent change to the same note must not read the
    // pre-write source and clobber this one.
    return this.#serializeByPath(path, async (): Promise<NoteCommitResult> => {
      const owner = await noteSessions.currentSessionFor(path)
      if (owner !== null) {
        const commit = await owner.commitSourceEdit(transform)
        if (commit !== null) {
          const indexSeq =
            commit.revision === null
              ? null
              : await this.#indexCommit(path, options.generation, {
                  content: commit.content,
                  hash: commit.revision,
                })
          return { ...commit, indexSeq }
        }
        if (owner.isDirty()) {
          throw new NoteEditError(
            'notWritable',
            'This note can’t be updated right now — try again in a moment.',
          )
        }
      }
      return await this.#commitToDisk(
        path,
        (source, revision) => transform(source ?? '', revision),
        options.generation,
        options.createIfMissing === true,
      )
    })
  }

  isOstensiblyEmpty(source: string): boolean {
    return isOstensiblyEmptyNoteSource(source)
  }

  /**
   * The note's content, where a missing file reads as an empty note.
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

  /**
   * Read the note file, apply `transform`, and write only while the file
   * still holds the text that was read; a file that changed runs `transform`
   * again on its new text. `transform` takes `null` for a missing note, which
   * the write creates when `createIfMissing` is set.
   */
  async #commitToDisk(
    path: string,
    transform: (source: string | null, revision: string | null) => string,
    generation: number,
    createIfMissing: boolean,
  ): Promise<NoteCommitResult> {
    const { noteFile } = this.#deps
    let source = await this.#readForEdit(path, createIfMissing, generation)
    for (let attempt = 0; attempt < COMMIT_ATTEMPT_LIMIT; attempt += 1) {
      const content = transform(source?.content ?? null, source?.hash ?? null)
      if (content === (source?.content ?? '')) {
        return { content, revision: source?.hash ?? null, merged: false, indexSeq: null }
      }
      const written = await noteFile.write(
        path,
        content,
        generation,
        source?.content ?? null,
        'reject',
      )
      if (written.merged === null) {
        const indexSeq = await this.#indexCommit(
          path,
          generation,
          { content, hash: written.hash },
          written.modifiedMs,
        )
        return { content, revision: written.hash, merged: false, indexSeq }
      }
      source = { content: written.merged, hash: written.hash }
    }
    throw new NoteEditError('conflict', `${path} kept changing on disk; the edit was not saved.`)
  }

  #serializeByPath<T>(path: string, op: () => Promise<T>): Promise<T> {
    const previous = this.#writeChains.get(path) ?? Promise.resolve()
    // Run `op` whether the previous write resolved or rejected — one failure must
    // not wedge the chain for the note.
    const result = previous.then(op, op)
    const settled = result.then(noop, noop)
    this.#writeChains.set(path, settled)
    void settled.then(() => {
      // Drop the entry once the chain goes idle, so the map can't grow unbounded.
      if (this.#writeChains.get(path) === settled) {
        this.#writeChains.delete(path)
      }
    })
    return result
  }

  /**
   * Write the text a commit left in the note file to the index of the graph
   * session that `generation` belongs to. `note` is that text, or `undefined`
   * to read it from the file.
   */
  async #indexCommit(
    path: string,
    generation: number,
    note: NoteRead | undefined,
    mtime?: number,
  ): Promise<number | null> {
    const { graphSession, indexLifecycle, logger } = this.#deps
    const { session } = graphSession.get()
    if (session === null || session.generation !== generation || session.indexGeneration === null) {
      return null
    }
    try {
      return await indexLifecycle.indexNote(path, {
        generation: session.indexGeneration,
        fileGeneration: generation,
        note,
        mtime,
      })
    } catch (error) {
      logger.error(`failed to index the commit of ${path}:`, error)
      return null
    }
  }

  /**
   * The note's text, or `null` for a missing note that the edit may create.
   */
  async #readForEdit(
    path: string,
    createIfMissing: boolean,
    generation: number,
  ): Promise<NoteRead | null> {
    try {
      return await this.#deps.noteFile.readWithHash(path, generation)
    } catch (cause) {
      if (createIfMissing && isAppError(cause) && cause.kind === 'notFound') {
        return null
      }
      throw cause
    }
  }
}

export function createNoteDocumentService(deps: NoteDocumentServiceDeps): NoteDocumentService {
  return new NoteDocumentServiceImpl(deps)
}
