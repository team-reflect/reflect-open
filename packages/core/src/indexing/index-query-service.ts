import type { PinnedNoteRow as PinnedNote, NoteRow, TemplateEntry } from '@reflect/types'
import type { MaybePromise } from '@reflect/utils'
import { isIsoDate } from '@reflect/utils'
import { dailyPath } from '../graph/paths.ts'
import { foldKey } from '../markdown/index.ts'
import type { DatabaseService } from './database-service.ts'

export type { PinnedNote }

export type { NoteRow }

/**
 * What a pass knows about an indexed note without reading its file.
 */
export interface IndexedFileFacts {
  /**
   * Content hash the row was built from — the authority for "changed".
   */
  readonly fileHash: string
  /**
   * The mtime stamped on the row — lets a pass skip reading untouched files.
   */
  readonly mtime: number
}

export type { TemplateEntry }

export interface IndexQueryServiceDeps {
  readonly database: DatabaseService
}

/**
 * Row lookups over the index's `notes` and `aliases` tables.
 */
export interface IndexQueryService {
  /**
   * Fetch a single note's row by graph-relative path, or `undefined` if absent.
   */
  getNote(path: string): Promise<NoteRow | undefined>
  /**
   * Every pinned note, in shelf order: explicit `pinned: <n>` orders first
   * (ascending — what pinned shelf reorder writes), bare `pinned: true` after,
   * alphabetically by case-folded title (path as the tiebreak). Stable order is
   * the point of pinning: the list must not reshuffle as notes are edited.
   */
  getPinnedNotes(): Promise<PinnedNote[]>
  /**
   * Every template in the graph (`templates/*.md`), A→Z by folded title
   * (matching v1's menu order). Templates are indexed like notes but carry
   * `kind = 'template'`, which every note surface excludes — this listing is
   * the one query that *selects* them.
   */
  listTemplates(): MaybePromise<TemplateEntry[]>
  /**
   * Stored `path → {fileHash, mtime}` facts for a specific path set, so
   * applying a large `index:changed` batch can skip already-indexed files
   * without a full-table load. One query takes any number of paths.
   */
  getIndexedFileFactsByPath(paths: string[]): Promise<Map<string, IndexedFileFacts>>
  /**
   * Frontmatter `id`s of the given indexed paths (a path with no row is
   * simply absent; a row without an id maps to `null`). The move-detection
   * input. One query takes any number of paths: a mass external move can
   * orphan thousands at once.
   */
  getNoteIdsByPath(paths: string[]): Promise<Map<string, string | null>>
  /**
   * A uniformly random note path, or null on an empty graph (Plan 08 command).
   */
  randomNotePath(): Promise<string | null>
  /**
   * Resolve a free-form note target — a deep link's `reflect://note/<target>`
   * argument — to a graph-relative path, or null when nothing matches.
   *
   * The order mirrors the CLI's `<note>` argument, with the frontmatter `id`
   * first because it is the one form that survives renames (the reason ids
   * exist, Plan 17):
   *
   * 1. frontmatter `id` — exact match on `notes.id`;
   * 2. a calendar-valid ISO date — the daily path, whether or not the file
   *    exists yet (dailies are created lazily, same as in-app navigation);
   * 3. an explicit graph-relative path;
   * 4. a title match (case-folded like wiki-link resolution);
   * 5. an alias match (`aliases:` frontmatter or a derived v1 subject alias —
   *    a `//` segment of the title — same folding).
   *
   * Ambiguity (two paths claiming one id after a sync fork, duplicate titles)
   * resolves to the first path alphabetically — the CLI's rule. Private notes
   * resolve like any other: a deep link is local navigation, the same act as
   * clicking the note in-app, not an export surface like the CLI.
   */
  resolveNoteTarget(target: string): Promise<string | null>
}

class IndexQueryServiceImpl implements IndexQueryService {
  readonly #deps: IndexQueryServiceDeps

  constructor(deps: IndexQueryServiceDeps) {
    this.#deps = deps
  }

  async getNote(path: string): Promise<NoteRow | undefined> {
    return (await this.#deps.database.read('index_note', { path })) ?? undefined
  }

  async getPinnedNotes(): Promise<PinnedNote[]> {
    return await this.#deps.database.read('index_pinned_notes', {})
  }

  async listTemplates(): Promise<TemplateEntry[]> {
    return await this.#deps.database.read('index_templates', {})
  }

  async getIndexedFileFactsByPath(paths: string[]): Promise<Map<string, IndexedFileFacts>> {
    const rows = await this.#deps.database.read('index_file_facts', { paths })
    return new Map(rows.map(({ path, fileHash, mtime }) => [path, { fileHash, mtime }]))
  }

  async getNoteIdsByPath(paths: string[]): Promise<Map<string, string | null>> {
    const rows = await this.#deps.database.read('index_note_ids', { paths })
    return new Map(rows.map(({ path, id }) => [path, id]))
  }

  async randomNotePath(): Promise<string | null> {
    return await this.#deps.database.read('index_random_note', {})
  }

  async resolveNoteTarget(target: string): Promise<string | null> {
    return await this.#deps.database.read('index_resolve_target', {
      target,
      dailyPath: isIsoDate(target) ? dailyPath(target) : null,
      key: foldKey(target),
    })
  }
}

export function createIndexQueryService(deps: IndexQueryServiceDeps): IndexQueryService {
  return new IndexQueryServiceImpl(deps)
}
