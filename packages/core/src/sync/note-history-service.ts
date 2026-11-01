import type { NoteDocumentService } from '../documents/note-document-service.ts'
import { AppError } from '../errors.ts'
import type { GraphSessionSource } from '../graph/graph-session.ts'
import type { PersistenceFlushService } from '../graph/persistence-flush-service.ts'
import { splitFrontmatter } from '../markdown/frontmatter.ts'
import type {
  GitRepositoryService,
  NoteHistoryPage,
  NoteRevision,
} from './git-repository-service.ts'

/**
 * Revisions per {@link NoteHistoryService.revisions} page.
 */
export const NOTE_HISTORY_PAGE_SIZE = 50

/**
 * A note's past versions, read from the graph's git repository: the backup
 * commits (or, without a remote, the local-history commits) that changed it.
 */
export interface NoteHistoryService {
  /**
   * A page of the note's revisions, newest first, following renames. `after`
   * is the previous page's `nextCursor`.
   */
  revisions(path: string, after: string | null): Promise<NoteHistoryPage>
  /**
   * The note's full text at `revision`.
   */
  revisionText(revision: NoteRevision): Promise<string>
  /**
   * Replace the body of the note at `path` with `revision`'s, in place. The
   * current frontmatter stays: the id, the `private` flag, pins and gist
   * metadata describe the note now, and an old block could silently unlock a
   * private note. Pending edits are saved and committed first, so the text
   * being replaced stays in history and the restore can itself be undone;
   * when that commit didn't land, nothing is restored.
   */
  restore(path: string, revision: NoteRevision): Promise<void>
}

export interface NoteHistoryServiceDeps {
  readonly gitRepository: GitRepositoryService
  readonly noteDocuments: NoteDocumentService
  readonly persistenceFlush: PersistenceFlushService
  readonly graphSession: GraphSessionSource
}

class NoteHistoryServiceImpl implements NoteHistoryService {
  readonly #deps: NoteHistoryServiceDeps

  constructor(deps: NoteHistoryServiceDeps) {
    this.#deps = deps
  }

  async revisions(path: string, after: string | null): Promise<NoteHistoryPage> {
    return await this.#deps.gitRepository.noteHistory(
      path,
      after,
      NOTE_HISTORY_PAGE_SIZE,
      this.#generation(),
    )
  }

  async revisionText(revision: NoteRevision): Promise<string> {
    return await this.#deps.gitRepository.noteRevision(revision, this.#generation())
  }

  async restore(path: string, revision: NoteRevision): Promise<void> {
    const { gitRepository, noteDocuments, persistenceFlush } = this.#deps
    const generation = this.#generation()
    const text = await gitRepository.noteRevision(revision, generation)
    await persistenceFlush.flushAll()
    // The flush never rejects, so check its outcome: the text being replaced
    // must be the note at HEAD, or it would be lost from history.
    const committed = await gitRepository.noteRevision(
      { ...revision, oid: 'HEAD', path },
      generation,
    )
    const { body } = splitFrontmatter(text)
    await noteDocuments.commitSourceEdit(
      path,
      (current) => {
        if (current !== committed) {
          throw new AppError('io', 'Couldn’t save the current version to history first')
        }
        return current.slice(0, splitFrontmatter(current).bodyOffset) + body
      },
      { generation },
    )
  }

  #generation(): number {
    const session = this.#deps.graphSession.getState().session
    if (session === null) {
      throw new AppError('noGraph', 'No graph is open')
    }
    return session.generation
  }
}

export function createNoteHistoryService(deps: NoteHistoryServiceDeps): NoteHistoryService {
  return new NoteHistoryServiceImpl(deps)
}
