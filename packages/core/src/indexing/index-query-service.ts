import type { MaybePromise } from '@reflect/utils'
import { isNotNullish } from '@ocavue/utils'
import { isIsoDate } from '@reflect/utils'
import { sql } from 'kysely'
import { dailyPath } from '../graph/paths.ts'
import { foldKey } from '../markdown/index.ts'
import type { DatabaseService } from './database-service.ts'
import { inClauseChunks } from './query-utils.ts'

/**
 * One pinned note, as the sidebar's Pinned section lists it.
 */
export interface PinnedNote {
  path: string
  title: string
  dailyDate: string | null
  pinnedOrder?: number | null | undefined
}

/**
 * Core fields of one note row: identity path, title, daily date, privacy flag.
 */
export interface NoteRow {
  path: string
  title: string
  dailyDate: string | null
  /**
   * The `private: true` frontmatter flag — a hard block on sending content to
   * external services. SQLite stores it as `0|1`; this getter maps it to a real
   * boolean at the read boundary so privacy checks can't be tripped up by a
   * truthy number.
   */
  isPrivate: boolean
  /**
   * The published gist's html url, or null when the note has none.
   */
  gistUrl: string | null
  /**
   * The body changed since it was last published — the "Republish" nudge.
   */
  gistStale: boolean
}

/**
 * Notes sharing one frontmatter `id` — a sync fork (Plan 17).
 */
export interface DuplicateIdGroup {
  id: string
  /**
   * Every path claiming the id, ordered (the first is resolution's winner).
   */
  paths: string[]
}

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

/**
 * One template: its file and its display name (H1 or filename-derived title).
 */
export interface TemplateEntry {
  path: string
  title: string
  /**
   * File modification time (epoch ms).
   */
  mtime: number
}

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
   * Frontmatter `id`s claimed by more than one note. Two files claiming one
   * identity means a sync fork (e.g. rename/rename divergence). No UI shows
   * forks; the user sees two notes, merges any differing edits, and deletes one.
   */
  getDuplicateNoteIds(): Promise<DuplicateIdGroup[]>
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
   * without a full-table load. Chunked past SQLite's bound-variable budget.
   */
  getIndexedFileFactsByPath(paths: string[]): Promise<Map<string, IndexedFileFacts>>
  /**
   * Frontmatter `id`s of the given indexed paths (a path with no row is
   * simply absent; a row without an id maps to `null`). The move-detection
   * input. Chunked — a mass external move can orphan thousands of paths at
   * once, beyond SQLite's bound-variable budget.
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
    const { db } = this.#deps.database
    const row = await db
      .selectFrom('notes')
      .where('path', '=', path)
      .select(['path', 'title', 'dailyDate', 'isPrivate', 'gistUrl', 'gistStale'])
      .executeTakeFirst()
    return row
      ? {
          ...row,
          isPrivate: row.isPrivate !== 0,
          gistStale: row.gistStale !== 0,
        }
      : undefined
  }

  async getPinnedNotes(): Promise<PinnedNote[]> {
    const { db } = this.#deps.database
    return await db
      .selectFrom('notes')
      .where('isPinned', '=', 1)
      .where('kind', '!=', 'template')
      .select(['path', 'title', 'dailyDate', 'pinnedOrder'])
      .orderBy(sql`pinned_order IS NULL`)
      .orderBy('pinnedOrder')
      .orderBy('titleKey')
      .orderBy('path')
      .execute()
  }

  async getDuplicateNoteIds(): Promise<DuplicateIdGroup[]> {
    const { db } = this.#deps.database
    const duplicated = await db
      .selectFrom('notes')
      .where('id', 'is not', null)
      .select('id')
      .groupBy('id')
      .having(sql<number>`count(*)`, '>', 1)
      .execute()
    // Sorted before chunking so group order stays deterministic across chunks.
    const ids = duplicated
      .map((row) => row.id)
      .filter(isNotNullish)
      .sort()
    const groups = new Map<string, string[]>()
    for (const chunk of inClauseChunks(ids)) {
      const rows = await db
        .selectFrom('notes')
        .where('id', 'in', chunk)
        .select(['id', 'path'])
        .orderBy('id')
        .orderBy('path')
        .execute()
      for (const row of rows) {
        if (row.id === null) {
          continue
        }
        const paths = groups.get(row.id) ?? []
        paths.push(row.path)
        groups.set(row.id, paths)
      }
    }
    return [...groups].map(([id, paths]) => ({ id, paths }))
  }

  async listTemplates(): Promise<TemplateEntry[]> {
    const { db } = this.#deps.database
    return await db
      .selectFrom('notes')
      .where('kind', '=', 'template')
      .select(['path', 'title', 'mtime'])
      .orderBy('titleKey')
      .orderBy('path')
      .execute()
  }

  async getIndexedFileFactsByPath(paths: string[]): Promise<Map<string, IndexedFileFacts>> {
    const { db } = this.#deps.database
    const facts = new Map<string, IndexedFileFacts>()
    for (const chunk of inClauseChunks(paths)) {
      const rows = await db
        .selectFrom('notes')
        .where('path', 'in', chunk)
        .select(['path', 'fileHash', 'mtime'])
        .execute()
      for (const row of rows) {
        facts.set(row.path, { fileHash: row.fileHash, mtime: row.mtime })
      }
    }
    return facts
  }

  async getNoteIdsByPath(paths: string[]): Promise<Map<string, string | null>> {
    const { db } = this.#deps.database
    const ids = new Map<string, string | null>()
    for (const chunk of inClauseChunks(paths)) {
      const rows = await db
        .selectFrom('notes')
        .where('path', 'in', chunk)
        .select(['path', 'id'])
        .execute()
      for (const row of rows) {
        ids.set(row.path, row.id)
      }
    }
    return ids
  }

  async randomNotePath(): Promise<string | null> {
    const { db } = this.#deps.database
    const result = await sql<{ path: string }>`
      SELECT path FROM notes ORDER BY random() LIMIT 1
    `.execute(db)
    return result.rows[0]?.path ?? null
  }

  async resolveNoteTarget(target: string): Promise<string | null> {
    const { db } = this.#deps.database
    const byId = await db
      .selectFrom('notes')
      .where('id', '=', target)
      .select('path')
      .orderBy('path')
      .executeTakeFirst()
    if (byId !== undefined) {
      return byId.path
    }

    if (isIsoDate(target)) {
      return dailyPath(target)
    }

    const byPath = await db
      .selectFrom('notes')
      .where('path', '=', target)
      .select('path')
      .executeTakeFirst()
    if (byPath !== undefined) {
      return byPath.path
    }

    const key = foldKey(target)
    const byTitle = await db
      .selectFrom('notes')
      .where('titleKey', '=', key)
      .select('path')
      .orderBy('path')
      .executeTakeFirst()
    if (byTitle !== undefined) {
      return byTitle.path
    }

    const byAlias = await db
      .selectFrom('aliases')
      .where('aliasKey', '=', key)
      .select('notePath')
      .orderBy('notePath')
      .executeTakeFirst()
    return byAlias?.notePath ?? null
  }
}

export function createIndexQueryService(deps: IndexQueryServiceDeps): IndexQueryService {
  return new IndexQueryServiceImpl(deps)
}
