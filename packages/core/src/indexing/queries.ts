import type { Database } from '@reflect/db'
import { sql, type Selectable } from 'kysely'
import { readNote } from '../graph/commands'
import { normalizeWikiTarget, resolveWikiLinkAsync, type Resolution } from '../markdown'
import { db } from './db'
import { buildFtsMatch } from './search-query'
import { lineSnippet } from './snippet'
import {
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

/** Escape `%`/`_`/`\` so user text can't act as LIKE wildcards. */
function likeContains(key: string): string {
  return `%${key.replaceAll(/[\\%_]/g, (match) => `\\${match}`)}%`
}

/**
 * `[[` autocomplete candidates for `query` (Plan 07): title and alias contains-
 * matches ranked by {@link rankWikiSuggestions} (exact < prefix < substring,
 * titles before aliases, recent first); an empty query suggests recent notes.
 * A full `YYYY-MM-DD` query always yields that daily as the first candidate —
 * dailies are valid targets before their file exists (created lazily on write).
 */
export async function suggestWikiTargets(query: string, limit = 8): Promise<WikiSuggestion[]> {
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
}

/** Fetch a single note's row by graph-relative path, or `undefined` if absent. */
export async function getNote(path: string): Promise<NoteRow | undefined> {
  const row = await db
    .selectFrom('notes')
    .where('path', '=', path)
    .select(['path', 'title', 'dailyDate', 'isPrivate'])
    .executeTakeFirst()
  return row ? { ...row, isPrivate: row.isPrivate !== 0 } : undefined
}

/** Graph-relative paths of every note carrying `tag`, ordered by path. */
export async function getNotesByTag(tag: string): Promise<string[]> {
  const rows = await db
    .selectFrom('tags')
    .where('tag', '=', tag)
    .select('notePath')
    .orderBy('notePath')
    .execute()
  return rows.map((row) => row.notePath)
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
