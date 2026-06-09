import { db, type Database } from '@reflect/db'
import { sql, type Selectable } from 'kysely'
import {
  normalizeWikiTarget,
  resolved,
  unresolved,
  type Resolution,
} from '../markdown'

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

/** Core columns of one note row: identity path, title, daily date, privacy flag. */
export type NoteRow = Pick<
  Selectable<Database['notes']>,
  'path' | 'title' | 'dailyDate' | 'isPrivate'
>

/** Fetch a single note's row by graph-relative path, or `undefined` if absent. */
export function getNote(path: string): Promise<NoteRow | undefined> {
  return db
    .selectFrom('notes')
    .where('path', '=', path)
    .select(['path', 'title', 'dailyDate', 'isPrivate'])
    .executeTakeFirst()
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
  const terms = query.trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) {
    return [] // FTS5 errors on an empty MATCH; nothing to search anyway.
  }
  // Quote each term so FTS5 operators in user input (e.g. `(`, `AND`, `*`) are
  // treated as literal text instead of throwing a query-syntax error.
  const match = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' ')
  return db
    .selectFrom('searchFts')
    .select(['path', 'title'])
    .where(sql<boolean>`search_fts MATCH ${match}`)
    .orderBy(sql`rank`)
    .limit(limit)
    .execute()
}

/** Stored `path → fileHash` map, for content-hash reconciliation on open. */
export async function getIndexedHashes(): Promise<Map<string, string>> {
  const rows = await db.selectFrom('notes').select(['path', 'fileHash']).execute()
  return new Map(rows.map((row) => [row.path, row.fileHash]))
}

/**
 * Resolve a `[[target]]` against the index (prefer daily-date, then title, then
 * alias), returning the note ref (its path). The DB-backed counterpart to the
 * pure {@link normalizeWikiTarget} rules in `markdown/resolve.ts`.
 */
export async function resolveWikiTarget(target: string): Promise<Resolution> {
  const { raw, key, date } = normalizeWikiTarget(target)

  // `orderBy` before `executeTakeFirst` so a title/alias/date collision resolves
  // to the same note every time (otherwise the row order is undefined).
  if (date) {
    const daily = await db
      .selectFrom('notes')
      .where('dailyDate', '=', date)
      .select('path')
      .orderBy('path')
      .executeTakeFirst()
    if (daily) {
      return resolved(daily.path)
    }
  }

  const byTitle = await db
    .selectFrom('notes')
    .where('titleKey', '=', key)
    .select('path')
    .orderBy('path')
    .executeTakeFirst()
  if (byTitle) {
    return resolved(byTitle.path)
  }

  const byAlias = await db
    .selectFrom('aliases')
    .where('aliasKey', '=', key)
    .select('notePath')
    .orderBy('notePath')
    .executeTakeFirst()
  if (byAlias) {
    return resolved(byAlias.notePath)
  }

  return unresolved(raw)
}
