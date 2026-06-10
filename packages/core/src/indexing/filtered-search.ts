import { sql } from 'kysely'
import { db } from './db'
import type { ParsedSearchQuery } from './filter-query'
import { resolveWikiTarget } from './queries'
import { HIGHLIGHT_END, HIGHLIGHT_START } from './search'
import { buildFtsMatch } from './search-query'

/**
 * The one palette search (Plan 08): parsed filter tokens become composable
 * predicates on `notes` (EXISTS subqueries against `tags` and the `backlinks`
 * view), with free text constraining and ranking through FTS (title-boosted
 * bm25, highlighted snippets). Filters may be empty — plain text search is the
 * degenerate case, so there is exactly one search path to keep correct.
 * Without text, results order by recency — a (possibly filtered) recall feed.
 */

export interface FilteredSearchHit {
  path: string
  title: string
  dailyDate: string | null
  /** Highlighted body snippet when free text was searched, else null. */
  snippet: string | null
}

export async function searchWithFilters(
  parsed: ParsedSearchQuery,
  limit = 12,
): Promise<FilteredSearchHit[]> {
  const { filters } = parsed

  // Link filters name a note by title/alias/date; resolve it once up front.
  // An unresolvable target matches nothing (the filter is explicit — silently
  // ignoring it would show results the user just excluded).
  let linksToPath: string | null = null
  if (filters.linksTo !== null) {
    const resolution = await resolveWikiTarget(filters.linksTo)
    if (resolution.kind !== 'resolved') {
      return []
    }
    linksToPath = resolution.ref
  }
  let linkedFromPath: string | null = null
  if (filters.linkedFrom !== null) {
    const resolution = await resolveWikiTarget(filters.linkedFrom)
    if (resolution.kind !== 'resolved') {
      return []
    }
    linkedFromPath = resolution.ref
  }

  const match = buildFtsMatch(parsed.text)

  let query = db
    .selectFrom('notes')
    .select(['notes.path', 'notes.title', 'notes.dailyDate'])
    .limit(limit)

  // `filters.tags` are folded keys (filter-query) matched against the stored
  // `tag_key` — folded in JS at index time, since SQLite's lower() is
  // ASCII-only and would miss non-ASCII casings.
  for (const tag of filters.tags) {
    query = query.where(({ exists, selectFrom }) =>
      exists(
        selectFrom('tags')
          .select(sql<number>`1`.as('one'))
          .whereRef('tags.notePath', '=', 'notes.path')
          .where('tags.tagKey', '=', tag),
      ),
    )
  }
  if (filters.dailyOnly) {
    query = query.where('notes.dailyDate', 'is not', null)
  }
  if (filters.pinnedOnly) {
    query = query.where('notes.isPinned', '=', 1)
  }
  if (linksToPath !== null) {
    const target = linksToPath
    query = query.where(({ exists, selectFrom }) =>
      exists(
        selectFrom('backlinks')
          .select(sql<number>`1`.as('one'))
          .whereRef('backlinks.sourcePath', '=', 'notes.path')
          .where('backlinks.targetPath', '=', target),
      ),
    )
  }
  if (linkedFromPath !== null) {
    const source = linkedFromPath
    query = query.where(({ exists, selectFrom }) =>
      exists(
        selectFrom('backlinks')
          .select(sql<number>`1`.as('one'))
          .whereRef('backlinks.targetPath', '=', 'notes.path')
          .where('backlinks.sourcePath', '=', source),
      ),
    )
  }
  if (filters.updatedAfterMs !== null) {
    query = query.where('notes.mtime', '>=', filters.updatedAfterMs)
  }
  if (filters.updatedBeforeMs !== null) {
    query = query.where('notes.mtime', '<', filters.updatedBeforeMs)
  }

  if (match === null) {
    // No free text: a filtered recall feed, newest first.
    const rows = await query.orderBy('notes.mtime', 'desc').execute()
    return rows.map((row) => ({ ...row, snippet: null }))
  }

  // Free text: constrain + rank + snippet through FTS (title-boosted bm25,
  // same weights as the unfiltered palette search).
  const rows = await query
    .innerJoin('searchFts', 'searchFts.path', 'notes.path')
    .select(
      sql<string>`snippet(search_fts, 2, ${HIGHLIGHT_START}, ${HIGHLIGHT_END}, '…', 10)`.as(
        'snippet',
      ),
    )
    .where(sql<boolean>`search_fts MATCH ${match}`)
    .orderBy(sql`bm25(search_fts, 0, 10.0, 1.0)`)
    .execute()
  return rows
}
