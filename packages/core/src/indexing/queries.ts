import type { Database } from '@reflect/db'
import { sql, type Selectable } from 'kysely'
import { readNote } from '../graph/commands'
import {
  foldTag,
  normalizeWikiTarget,
  resolveWikiLinkAsync,
  type Resolution,
  type TaskMarker,
} from '../markdown'
import { generateDateSuggestions, type DateSuggestionContext } from './date-suggestions'
import { db } from './db'
import { buildFtsMatch } from './search-query'
import { lineSnippet } from './snippet'
import {
  mergeDateSuggestions,
  rankWikiSuggestions,
  type AliasCandidate,
  type TitleCandidate,
  type WikiSuggestion,
} from './suggest'

/**
 * Index read getters (Plan 04). Queries are built with Kysely and execute over
 * the IPC bridge (`@reflect/db`). Rows are our own projection — trusted, not
 * re-validated per row (see Plan 04 §2).
 */

export type Backlink = Pick<
  Selectable<Database['backlinks']>,
  'sourcePath' | 'targetRaw' | 'alias' | 'posFrom' | 'posTo'
>

/** Notes that link to `path` (resolved at query time via the `backlinks` view). */
export function getBacklinks(path: string): Promise<Backlink[]> {
  return db
    .selectFrom('backlinks')
    .where('targetPath', '=', path)
    .select(['sourcePath', 'targetRaw', 'alias', 'posFrom', 'posTo'])
    .orderBy('sourcePath')
    .execute()
}

/** One backlink with the context the panel renders (Plan 07). */
export interface BacklinkContext {
  sourcePath: string
  sourceTitle: string
  /** The line of the source around the link (empty when the file is unreadable). */
  snippet: string
  posFrom: number
}

/**
 * Backlinks of `path` with source titles and line snippets. One read per
 * distinct source; a source that vanished between query and read keeps its row
 * with an empty snippet (the index lags deletes only briefly).
 */
export async function getBacklinksWithContext(path: string): Promise<BacklinkContext[]> {
  const rows = await db
    .selectFrom('backlinks')
    .innerJoin('notes', 'notes.path', 'backlinks.sourcePath')
    .where('targetPath', '=', path)
    .select(['backlinks.sourcePath', 'backlinks.posFrom', 'notes.title as sourceTitle'])
    // The view's generated types are nullable (SQLite views lose NOT NULL),
    // but these columns come from NOT NULL `links` columns via an inner join.
    .$narrowType<{ sourcePath: string; posFrom: number }>()
    .orderBy('notes.title')
    .orderBy('backlinks.sourcePath')
    .orderBy('backlinks.posFrom')
    .execute()

  const contents = new Map<string, string | null>()
  await Promise.all(
    [...new Set(rows.map((row) => row.sourcePath))].map(async (sourcePath) => {
      try {
        contents.set(sourcePath, await readNote(sourcePath))
      } catch {
        contents.set(sourcePath, null)
      }
    }),
  )

  return rows.map((row) => {
    const content = contents.get(row.sourcePath)
    return {
      sourcePath: row.sourcePath,
      sourceTitle: row.sourceTitle,
      snippet: content == null ? '' : lineSnippet(content, row.posFrom),
      posFrom: row.posFrom,
    }
  })
}

/**
 * One open task plus the note context the Tasks view (Plan 18) groups and
 * renders by. The view buckets Current/Overdue/Upcoming off the task's
 * `dueDate` when it has one, else the source note's `dailyDate`;
 * `isPinned`/`pinnedOrder`/`updatedAt` order the per-note groups for tasks in
 * regular (dateless) notes.
 */
export interface OpenTask extends TaskMarker {
  notePath: string
  /** Whether the checkbox is ticked. Open lists are all `false`; the Tasks view's
   * "show archived" surfaces completed rows where this is `true`. */
  checked: boolean
  /** Display text, markdown stripped. */
  text: string
  noteTitle: string
  /** The task's explicit `[[YYYY-MM-DD]]` due date, or null — drives Overdue (V1). */
  dueDate: string | null
  /** ISO date for daily-note tasks; null for tasks in regular notes. */
  dailyDate: string | null
  /** Pin flag mapped to a real boolean at the read boundary (SQLite stores `0|1`). */
  isPinned: boolean
  pinnedOrder: number | null
  updatedAt: number
}

/** Task rows joined to their note context — the shared shape both task reads select. */
function taskRowsQuery() {
  return db
    .selectFrom('tasks')
    .innerJoin('notes', 'notes.path', 'tasks.notePath')
    .select([
      'tasks.notePath',
      'tasks.markerOffset',
      'tasks.raw',
      'tasks.text',
      'tasks.checked',
      'tasks.dueDate',
      'notes.title as noteTitle',
      'notes.dailyDate',
      'notes.isPinned',
      'notes.pinnedOrder',
      'notes.updatedAt',
    ])
}

/** Map the SQLite `0|1` flags to real booleans at the read boundary, like the
 * other note getters — so `groupTasks` and the view see booleans, not integers. */
function toTaskRow(row: {
  checked: number
  isPinned: number
}): { checked: boolean; isPinned: boolean } {
  return { ...row, checked: row.checked !== 0, isPinned: row.isPinned !== 0 }
}

/**
 * Every open checkbox across the graph, with note context, for the Tasks view.
 * `private: true` notes' tasks **are** included: the Tasks view is a local-only
 * surface that never sends content anywhere — exactly like local search and the
 * daily stream — so the `private` hard-block (content never leaves the device)
 * is unaffected. The ordering here is only for a deterministic result; the final
 * grouping and sort live in {@link groupTasks}, so this read just gathers the rows.
 */
export async function getOpenTasks(): Promise<OpenTask[]> {
  const rows = await taskRowsQuery()
    .where('tasks.checked', '=', 0)
    .orderBy('tasks.notePath')
    .orderBy('tasks.markerOffset')
    .execute()
  return rows.map((row) => ({ ...row, ...toTaskRow(row) }))
}

/**
 * Completed checkboxes across the graph, most-recently-edited note first — the
 * Tasks view's "show archived" surface. Same shape as {@link getOpenTasks}, so
 * the view groups and renders both the same way (completed rows struck through).
 */
export async function getCompletedTasks(): Promise<OpenTask[]> {
  const rows = await taskRowsQuery()
    .where('tasks.checked', '=', 1)
    .orderBy('notes.updatedAt', 'desc')
    .orderBy('tasks.markerOffset')
    .execute()
  return rows.map((row) => ({ ...row, ...toTaskRow(row) }))
}

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

/** Escape `%`/`_`/`\` so user text can't act as LIKE wildcards. */
function likeContains(key: string): string {
  return `%${key.replaceAll(/[\\%_]/g, (match) => `\\${match}`)}%`
}

/** One `#tag` autocomplete candidate: display casing + how many notes carry it. */
export interface TagSuggestion {
  tag: string
  count: number
}

/**
 * `#` autocomplete candidates for `query` (Plan 18): tags whose folded key
 * contains the query, most-used first, deduped on the stored `tag_key` so
 * `#Book`/`#book` are one row with one deterministic casing. An empty query
 * suggests the most-used tags. Mirrors how {@link suggestWikiTargets} feeds the
 * `[[` menu — the host ranks, the editor's menu does not re-sort.
 */
export async function suggestTags(query: string, limit = 8): Promise<TagSuggestion[]> {
  const key = foldTag(query.trim())
  let candidates = db
    .selectFrom('tags')
    .select([sql<string>`min(tags.tag)`.as('tag'), sql<number>`count(*)`.as('count')])
    .groupBy('tags.tagKey')
    .orderBy(sql`count(*)`, 'desc')
    .orderBy(sql`min(tags.tag)`)
    .limit(limit)
  if (key !== '') {
    candidates = candidates.where(sql<boolean>`tag_key LIKE ${likeContains(key)} ESCAPE '\\'`)
  }
  const rows = await candidates.execute()
  return rows.map((row) => ({ tag: row.tag, count: Number(row.count) }))
}

/**
 * `[[` autocomplete candidates for `query` (Plan 07): title and alias contains-
 * matches ranked by {@link rankWikiSuggestions} (exact < prefix < substring,
 * titles before aliases, recent first); an empty query suggests recent notes.
 * A full `YYYY-MM-DD` query always yields that daily as the first candidate —
 * dailies are valid targets before their file exists (created lazily on write).
 *
 * Pass `dateGen` (the clock + date-format preference) to also synthesise
 * date suggestions from fuzzy queries — "3 days ago", "next friday", "12/25",
 * "December 2nd" — via {@link generateDateSuggestions}, merged ahead of the
 * index matches. Omit it (e.g. legacy callers) to keep the plain title/alias
 * behaviour with only the full-ISO daily injection.
 */
export async function suggestWikiTargets(
  query: string,
  limit = 8,
  dateGen?: DateSuggestionContext,
): Promise<WikiSuggestion[]> {
  const normalized = normalizeWikiTarget(query)
  const key = normalized.key

  let titleQuery = db
    .selectFrom('notes')
    .select(['path', 'title', 'titleKey', 'dailyDate', 'mtime'])
    .orderBy('mtime', 'desc')
    .limit(50)
  if (key !== '') {
    titleQuery = titleQuery.where(
      sql<boolean>`title_key LIKE ${likeContains(key)} ESCAPE '\\'`,
    )
  }
  const titles: TitleCandidate[] = await titleQuery.execute()

  let aliases: AliasCandidate[] = []
  if (key !== '') {
    aliases = await db
      .selectFrom('aliases')
      .innerJoin('notes', 'notes.path', 'aliases.notePath')
      .where(sql<boolean>`alias_key LIKE ${likeContains(key)} ESCAPE '\\'`)
      .select([
        'notes.path',
        'notes.title',
        'notes.titleKey',
        'notes.dailyDate',
        'notes.mtime',
        'aliases.alias',
        'aliases.aliasKey',
      ])
      .orderBy('notes.mtime', 'desc')
      .limit(50)
      .execute()
  }

  const ranked = rankWikiSuggestions(key, titles, aliases, limit)

  // With a clock, the generator covers the full-ISO daily too (and more), so it
  // supersedes the bare injection below.
  if (dateGen !== undefined) {
    return mergeDateSuggestions(ranked, generateDateSuggestions(query, dateGen), { key, limit })
  }

  if (normalized.date !== undefined) {
    const date = normalized.date
    const existing = ranked.find((suggestion) => suggestion.date === date)
    const daily: WikiSuggestion = existing ?? {
      target: date,
      path: null,
      title: date,
      alias: null,
      date,
    }
    return [daily, ...ranked.filter((suggestion) => suggestion !== existing)].slice(0, limit)
  }
  return ranked
}

/** One pinned note, as the sidebar's Pinned section lists it. */
export interface PinnedNote {
  path: string
  title: string
  dailyDate: string | null
}

/**
 * Every pinned note, in shelf order: explicit `pinned: <n>` orders first
 * (ascending — what the future reorder UI writes), bare `pinned: true` after,
 * alphabetically by case-folded title (path as the tiebreak). Stable order is
 * the point of pinning: the list must not reshuffle as notes are edited.
 */
export async function getPinnedNotes(): Promise<PinnedNote[]> {
  return db
    .selectFrom('notes')
    .where('isPinned', '=', 1)
    .select(['path', 'title', 'dailyDate'])
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

/**
 * Bound variables per `IN (…)` clause. SQLite caps variables per statement
 * (999 on older builds), and callers like the reconcile pass can legitimately
 * present thousands of paths after a mass external move — chunking keeps
 * every statement comfortably inside the budget.
 */
const IN_CLAUSE_LIMIT = 500

/** Split `values` into `IN`-clause-sized chunks (no chunks for no values). */
function inClauseChunks<Value>(values: readonly Value[]): Value[][] {
  const chunks: Value[][] = []
  for (let start = 0; start < values.length; start += IN_CLAUSE_LIMIT) {
    chunks.push(values.slice(start, start + IN_CLAUSE_LIMIT))
  }
  return chunks
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
    .where('tagKey', '=', foldTag(tag))
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

/** A full-text search result: the note's path and title. */
export type SearchHit = Pick<Selectable<Database['searchFts']>, 'path' | 'title'>

/** Full-text search over title + body (FTS5 `MATCH`, ranked). */
export async function searchNotes(query: string, limit = 50): Promise<SearchHit[]> {
  const match = buildFtsMatch(query)
  if (match === null) {
    return [] // nothing to search (FTS5 also errors on an empty MATCH).
  }
  return db
    .selectFrom('searchFts')
    .select(['path', 'title'])
    .where(sql<boolean>`search_fts MATCH ${match}`)
    .orderBy(sql`rank`)
    .limit(limit)
    .execute()
}

/**
 * Stored `path → fileHash` map, for content-hash reconciliation on open. Loads
 * every note's hash into memory — fine at first-wave graph sizes; revisit with a
 * streamed/keyset scan if graphs grow large (tracked with the Plan 04b watcher).
 */
export async function getIndexedHashes(): Promise<Map<string, string>> {
  const rows = await db.selectFrom('notes').select(['path', 'fileHash']).execute()
  return new Map(rows.map((row) => [row.path, row.fileHash]))
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
          .select('path')
          .orderBy('path')
          .executeTakeFirst()
      )?.path,
    byAlias: async (key) =>
      (
        await db
          .selectFrom('aliases')
          .where('aliasKey', '=', key)
          .select('notePath')
          .orderBy('notePath')
          .executeTakeFirst()
      )?.notePath,
  })
}
