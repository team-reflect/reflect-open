import { sql } from 'kysely'
import {
  foldEmail,
  foldTag,
  resolveWikiLinkAsync,
  type Resolution,
} from '../markdown'
import { db } from './db'
import { inClauseChunks } from './query-utils'
export {
  getBacklinks,
  getBacklinksWithContext,
  type Backlink,
  type BacklinkContext,
} from './queries-backlinks'
export { getCompletedTasks, getOpenTasks, type OpenTask } from './queries-tasks'
export {
  suggestTags,
  suggestWikiTargets,
  type TagSuggestion,
} from './queries-suggestions'

/**
 * Index read getters (Plan 04). Queries are built with Kysely and execute over
 * the IPC bridge (`@reflect/db`). Rows are our own projection — trusted, not
 * re-validated per row (see Plan 04 §2).
 */

/** Distinct source paths of links whose folded target key is `targetKey`. */
export async function getLinkSources(targetKey: string): Promise<string[]> {
  const rows = await db
    .selectFrom('links')
    .where('targetKey', '=', targetKey)
    .select('sourcePath')
    .distinct()
    .orderBy('sourcePath')
    .execute()
  return rows.map((row) => row.sourcePath)
}

/** One pinned note, as the sidebar's Pinned section lists it. */
export interface PinnedNote {
  path: string
  title: string
  dailyDate: string | null
  pinnedOrder?: number | null
}

/**
 * Every pinned note, in shelf order: explicit `pinned: <n>` orders first
 * (ascending — what pinned shelf reorder writes), bare `pinned: true` after,
 * alphabetically by case-folded title (path as the tiebreak). Stable order is
 * the point of pinning: the list must not reshuffle as notes are edited.
 */
export async function getPinnedNotes(): Promise<PinnedNote[]> {
  return db
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

/** Core fields of one note row: identity path, title, daily date, privacy flag. */
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
  /** The file carries sync conflict markers (Plan 12) — surface `Needs review`. */
  hasConflict: boolean
  /** The published gist's html url, or null when the note has none. */
  gistUrl: string | null
  /** The body changed since it was last published — the "Republish" nudge. */
  gistStale: boolean
}

/** Fetch a single note's row by graph-relative path, or `undefined` if absent. */
export async function getNote(path: string): Promise<NoteRow | undefined> {
  const row = await db
    .selectFrom('notes')
    .where('path', '=', path)
    .select(['path', 'title', 'dailyDate', 'isPrivate', 'hasConflict', 'gistUrl', 'gistStale'])
    .executeTakeFirst()
  return row
    ? {
        ...row,
        isPrivate: row.isPrivate !== 0,
        hasConflict: row.hasConflict !== 0,
        gistStale: row.gistStale !== 0,
      }
    : undefined
}

/** A note flagged `Needs review`: its file carries sync conflict markers. */
export interface ConflictedNote {
  path: string
  title: string
}

/** Every note whose file carries sync conflict markers, ordered by path. */
export async function getConflictedNotes(): Promise<ConflictedNote[]> {
  return db
    .selectFrom('notes')
    .where('hasConflict', '=', 1)
    .select(['path', 'title'])
    .orderBy('path')
    .execute()
}

/** Notes sharing one frontmatter `id` — a sync fork (Plan 17). */
export interface DuplicateIdGroup {
  id: string
  /** Every path claiming the id, ordered (the first is resolution's winner). */
  paths: string[]
}

/**
 * Frontmatter `id`s claimed by more than one note. Two files claiming one
 * identity means a sync fork (e.g. rename/rename divergence) — surfaced for
 * review like conflicts; repair is deliberately not automatic.
 */
export async function getDuplicateNoteIds(): Promise<DuplicateIdGroup[]> {
  const duplicated = await db
    .selectFrom('notes')
    .where('id', 'is not', null)
    .select('id')
    .groupBy('id')
    .having(sql<number>`count(*)`, '>', 1)
    .execute()
  // Sorted before chunking so group order stays deterministic across chunks.
  const ids = duplicated.flatMap((row) => (row.id === null ? [] : [row.id])).sort()
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
  return [...groups.entries()].map(([id, paths]) => ({ id, paths }))
}

/**
 * ISO dates within `[start, end]` (inclusive) that have an indexed daily note,
 * ascending. Daily files are created lazily on first write, so an indexed row
 * means the day has real content — this powers the calendar's day markers.
 */
export async function dailyDatesInRange(start: string, end: string): Promise<string[]> {
  const rows = await db
    .selectFrom('notes')
    .where('dailyDate', 'is not', null)
    .where('dailyDate', '>=', start)
    .where('dailyDate', '<=', end)
    .select('dailyDate')
    .orderBy('dailyDate')
    .execute()
  return rows.flatMap((row) => (row.dailyDate === null ? [] : [row.dailyDate]))
}

/** One daily-note row of a date-ranged listing (the AI chat's daily tool). */
export interface DailyNoteRow {
  path: string
  title: string
  dailyDate: string
  /** The indexed row preview (`buildIndexedNote`; may be empty). */
  preview: string
  /** File modification time (epoch ms). */
  mtime: number
  isPrivate: boolean
}

export interface DailyNotesRange {
  /** First day, inclusive (ISO `YYYY-MM-DD`). */
  start: string
  /** Last day, inclusive (ISO `YYYY-MM-DD`). */
  end: string
  /** Row cap — the most recent days in range win. */
  limit: number
}

/**
 * Daily notes within `[start, end]` (inclusive), most recent first, capped at
 * `limit`. Daily files are created lazily on first write, so a row means the
 * day has real content. Private dailies are excluded in SQL so they don't
 * consume cap slots — the AI privacy gate still re-checks every row live.
 */
export async function listDailyNotes(range: DailyNotesRange): Promise<DailyNoteRow[]> {
  const rows = await db
    .selectFrom('notes')
    .where('dailyDate', 'is not', null)
    .where('dailyDate', '>=', range.start)
    .where('dailyDate', '<=', range.end)
    .where('isPrivate', '=', 0)
    .select(['path', 'title', 'dailyDate', 'preview', 'mtime', 'isPrivate'])
    .orderBy('dailyDate', 'desc')
    .limit(range.limit)
    .execute()
  return rows.flatMap((row) =>
    row.dailyDate === null ? [] : [{ ...row, dailyDate: row.dailyDate, isPrivate: row.isPrivate !== 0 }],
  )
}

/** Graph-relative paths of every note carrying `tag` (case-insensitive), ordered by path. */
export async function getNotesByTag(tag: string): Promise<string[]> {
  const rows = await db
    .selectFrom('tags')
    .innerJoin('notes', 'notes.path', 'tags.notePath')
    .where('tagKey', '=', foldTag(tag))
    .where('notes.kind', '!=', 'template')
    .select('notePath')
    .orderBy('notePath')
    .execute()
  return rows.map((row) => row.notePath)
}

/** One `index_meta` value, or `null` when the key has never been written. */
export async function getIndexMeta(key: string): Promise<string | null> {
  const row = await db
    .selectFrom('indexMeta')
    .where('key', '=', key)
    .select('value')
    .executeTakeFirst()
  return row?.value ?? null
}

/** What a pass knows about an indexed note without reading its file. */
export interface IndexedFileFacts {
  /** Content hash the row was built from — the authority for "changed". */
  readonly fileHash: string
  /** The mtime stamped on the row — lets a pass skip reading untouched files. */
  readonly mtime: number
}

/**
 * Stored `path → {fileHash, mtime}` map, for reconciliation on open. Loads
 * every note's facts into memory — fine at first-wave graph sizes; revisit with
 * a streamed/keyset scan if graphs grow large (tracked with the Plan 04b
 * watcher).
 */
export async function getIndexedFileFacts(): Promise<Map<string, IndexedFileFacts>> {
  const rows = await db.selectFrom('notes').select(['path', 'fileHash', 'mtime']).execute()
  return new Map(rows.map((row) => [row.path, { fileHash: row.fileHash, mtime: row.mtime }]))
}

/**
 * {@link getIndexedFileFacts} for a specific path set — the live watcher-batch
 * variant, so applying a large `index:changed` batch (e.g. the metadata
 * query's initial gather) can skip already-indexed files without a full-table
 * load. Chunked past SQLite's bound-variable budget.
 */
export async function getIndexedFileFactsByPath(
  paths: string[],
): Promise<Map<string, IndexedFileFacts>> {
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

/**
 * Frontmatter `id`s of the given indexed paths (a path with no row is simply
 * absent; a row without an id maps to `null`). The move-detection input: both
 * the reconcile pass and the watcher batch handler pair vanished rows with
 * appeared files through this. Chunked — a mass external move can orphan
 * thousands of paths at once, beyond SQLite's bound-variable budget.
 */
export async function getNoteIdsByPath(paths: string[]): Promise<Map<string, string | null>> {
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

/** The folded tag key marking person notes (`- Type: #person`, v1's typing). */
const PERSON_TAG_KEY = 'person'

/**
 * The title of the note that owns `email` through a `- Email:` contact-field
 * bullet (the `note_emails` projection), or null. Only `#person`-tagged
 * regular notes qualify: a daily note, template, or non-person note quoting
 * an address must never become a `[[Person]]` link target — the projection
 * records every field bullet, and this query is where the ownership policy
 * lives. Several notes claiming one address resolve to the first path
 * alphabetically, the resolver's rule everywhere else.
 */
export async function noteTitleOwningEmail(email: string): Promise<string | null> {
  const key = foldEmail(email)
  if (key === '') {
    return null
  }
  const owner = await db
    .selectFrom('noteEmails')
    .innerJoin('notes', 'notes.path', 'noteEmails.notePath')
    .innerJoin('tags', 'tags.notePath', 'notes.path')
    .where('noteEmails.emailKey', '=', key)
    .where('tags.tagKey', '=', PERSON_TAG_KEY)
    .where('notes.kind', '=', 'note')
    .select('notes.title as title')
    .orderBy('notes.path')
    .executeTakeFirst()
  return owner?.title ?? null
}

/**
 * Resolve a `[[target]]` against the index, returning the note ref (its path).
 * The resolution *policy* (prefer daily-date, then title, then alias) lives once
 * in {@link resolveWikiLinkAsync}; this is only the DB-backed data access.
 *
 * Each lookup `orderBy`s before taking the first row so a title/alias/date
 * collision resolves to the same note every time (otherwise the row order is
 * undefined).
 */
export function resolveWikiTarget(target: string): Promise<Resolution> {
  // Templates are excluded from every lookup, mirroring the `note_keys` view:
  // a `[[target]]` must never resolve to a template.
  return resolveWikiLinkAsync(target, {
    byDate: async (date) =>
      (
        await db
          .selectFrom('notes')
          .where('dailyDate', '=', date)
          .select('path')
          .orderBy('path')
          .executeTakeFirst()
      )?.path,
    byTitle: async (key) =>
      (
        await db
          .selectFrom('notes')
          .where('titleKey', '=', key)
          .where('kind', '!=', 'template')
          .select('path')
          .orderBy('path')
          .executeTakeFirst()
      )?.path,
    byAlias: async (key) =>
      (
        await db
          .selectFrom('aliases')
          .innerJoin('notes', 'notes.path', 'aliases.notePath')
          .where('aliasKey', '=', key)
          .where('notes.kind', '!=', 'template')
          .select('notePath')
          .orderBy('notePath')
          .executeTakeFirst()
      )?.notePath,
  })
}
