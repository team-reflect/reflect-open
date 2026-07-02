import { sql, type RawBuilder } from 'kysely'
import { foldKey } from '../markdown'
import { db } from './db'
import type { ParsedSearchQuery } from './filter-query'
import { resolveWikiTarget } from './queries'
import { HIGHLIGHT_END, HIGHLIGHT_START } from './search'
import { buildFtsMatch } from './search-query'

/**
 * The one palette search (Plan 08): parsed filter tokens become composable
 * predicates on `notes` (EXISTS subqueries against `tags` and the `backlinks`
 * view), with free text constraining and ranking through FTS. Free-text
 * ranking promotes an exact title match (V1's strongest jump-to-note signal)
 * ahead of every body hit, then orders by title-boosted bm25, with pinned and
 * recency as deterministic tiebreakers. Filters may be empty — plain text
 * search is the degenerate case, so there is exactly one search path to keep
 * correct. Without text, results order by recency — a (possibly filtered)
 * recall feed. The mobile All tab reuses that recall feed as its filtered
 * list via {@link FilteredSearchOptions}.
 */

export interface FilteredSearchHit {
  path: string
  title: string
  dailyDate: string | null
  /** Highlighted body snippet when free text was searched, else null. */
  snippet: string | null
  /** The indexed row preview — the no-text feed's row snippet. */
  preview: string
  /** File modification time (epoch ms) — drives the row's recency label. */
  mtime: number
  isPinned: boolean
}

export interface FilteredSearchOptions {
  /**
   * Result cap (default 12, the palette's row budget). `null` removes the cap
   * — only sensible for the no-text recall feed behind a virtualized list;
   * free-text callers should keep one.
   */
  limit?: number | null
  /**
   * Order the no-text recall feed pinned-first (explicit pin order, then
   * unordered pins), then by recency — the All list's V1 order. Free-text
   * results keep relevance ranking regardless.
   */
  pinnedFirst?: boolean
  /**
   * Restrict the population to regular notes (`kind = 'note'`), matching the
   * All list. An explicit `is:daily` filter wins over this — the two would
   * otherwise contradict to an always-empty result.
   */
  notesOnly?: boolean
}

/** The columns every hit carries besides the FTS snippet. */
const HIT_COLUMNS = [
  'notes.path',
  'notes.title',
  'notes.dailyDate',
  'notes.preview',
  'notes.mtime',
  'notes.isPinned',
] as const

/**
 * The recall-feed ordering, shared with `listNotes` so the two "V1 list
 * order" implementations can't drift: optionally pinned-first (explicit pin
 * order, then unordered pins), then recency, then path as the stable
 * tiebreaker. Raw fragments because Kysely's typed `orderBy` can't resolve
 * `notes.*` refs across differently-rooted queries.
 */
export function recallOrder(pinnedFirst: boolean): RawBuilder<unknown>[] {
  const pinned = [
    sql`"notes"."is_pinned" desc`,
    sql`"notes"."pinned_order" is null`,
    sql`"notes"."pinned_order"`,
  ]
  return [...(pinnedFirst ? pinned : []), sql`"notes"."mtime" desc`, sql`"notes"."path"`]
}

/** Search the graph with parsed filters (see {@link FilteredSearchOptions}). */
export async function searchWithFilters(
  parsed: ParsedSearchQuery,
  options: FilteredSearchOptions = {},
): Promise<FilteredSearchHit[]> {
  const { filters } = parsed
  const limit = options.limit === undefined ? 12 : options.limit

  // Link filters name a note by title/alias/date; resolve it once up front.
  // An unresolvable target matches nothing (the filter is explicit — silently
  // ignoring it would show results the user just excluded). Picker-set exact
  // paths skip resolution entirely — the caller already holds the note, and
  // resolving its title could land on a duplicate.
  let linksToPath: string | null = filters.linksToPath ?? null
  if (linksToPath === null && filters.linksTo !== null) {
    const resolution = await resolveWikiTarget(filters.linksTo)
    if (resolution.kind !== 'resolved') {
      return []
    }
    linksToPath = resolution.ref
  }
  let linkedFromPath: string | null = filters.linkedFromPath ?? null
  if (linkedFromPath === null && filters.linkedFrom !== null) {
    const resolution = await resolveWikiTarget(filters.linkedFrom)
    if (resolution.kind !== 'resolved') {
      return []
    }
    linkedFromPath = resolution.ref
  }

  const match = buildFtsMatch(parsed.text)
  // An explicit daily filter and the notes-only population contradict; the
  // filter is the user's latest word, so it wins.
  const notesOnly = options.notesOnly === true && !filters.dailyOnly

  if (match === null && filters.tags.length > 0) {
    const [primaryTag, ...remainingTags] = filters.tags
    let taggedQuery = db
      .selectFrom('tags')
      .innerJoin('notes', 'notes.path', 'tags.notePath')
      .select(HIT_COLUMNS)
      // The length guard above guarantees a primary tag.
      .where('tags.tagKey', '=', primaryTag!)
      .where('notes.kind', '!=', 'template')
      .distinct()

    for (const tag of remainingTags) {
      taggedQuery = taggedQuery.where(({ exists, selectFrom }) =>
        exists(
          selectFrom('tags as filterTags')
            .select(sql<number>`1`.as('one'))
            .whereRef('filterTags.notePath', '=', 'notes.path')
            .where('filterTags.tagKey', '=', tag),
        ),
      )
    }
    if (filters.dailyOnly) {
      taggedQuery = taggedQuery.where('notes.dailyDate', 'is not', null)
    }
    if (notesOnly) {
      taggedQuery = taggedQuery.where('notes.kind', '=', 'note')
    }
    if (filters.pinnedOnly) {
      taggedQuery = taggedQuery.where('notes.isPinned', '=', 1)
    }
    if (linksToPath !== null) {
      const target = linksToPath
      taggedQuery = taggedQuery.where(({ exists, selectFrom }) =>
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
      taggedQuery = taggedQuery.where(({ exists, selectFrom }) =>
        exists(
          selectFrom('backlinks')
            .select(sql<number>`1`.as('one'))
            .whereRef('backlinks.targetPath', '=', 'notes.path')
            .where('backlinks.sourcePath', '=', source),
        ),
      )
    }
    if (filters.updatedAfterMs !== null) {
      taggedQuery = taggedQuery.where('notes.mtime', '>=', filters.updatedAfterMs)
    }
    if (filters.updatedBeforeMs !== null) {
      taggedQuery = taggedQuery.where('notes.mtime', '<', filters.updatedBeforeMs)
    }
    if (limit !== null) {
      taggedQuery = taggedQuery.limit(limit)
    }

    for (const order of recallOrder(options.pinnedFirst === true)) {
      taggedQuery = taggedQuery.orderBy(order)
    }
    const rows = await taggedQuery.execute()
    return rows.map((row) => ({ ...row, snippet: null, isPinned: row.isPinned !== 0 }))
  }

  // Templates never surface in search — they are boilerplate, not notes.
  let query = db.selectFrom('notes').select(HIT_COLUMNS).where('notes.kind', '!=', 'template')

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
  if (notesOnly) {
    query = query.where('notes.kind', '=', 'note')
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
  if (limit !== null) {
    query = query.limit(limit)
  }

  if (match === null) {
    // No free text: a filtered recall feed, newest first.
    let recallQuery = query
    for (const order of recallOrder(options.pinnedFirst === true)) {
      recallQuery = recallQuery.orderBy(order)
    }
    const rows = await recallQuery.execute()
    return rows.map((row) => ({ ...row, snippet: null, isPinned: row.isPinned !== 0 }))
  }

  // Free text: constrain + rank + snippet through FTS. An exact title match
  // leads (title-rank 0); within a rank class, title-boosted bm25 orders (same
  // weights as the unfiltered palette search), then pinned and recency break
  // ties, with `path` as the stable final fallback. The exact-title key is
  // folded the same way titles were at index time, so it can never drift from
  // the stored `notes.title_key`.
  const titleKey = foldKey(parsed.text)
  const rows = await query
    .innerJoin('searchFts', 'searchFts.path', 'notes.path')
    .select(
      sql<string>`snippet(search_fts, 2, ${HIGHLIGHT_START}, ${HIGHLIGHT_END}, '…', 10)`.as(
        'snippet',
      ),
    )
    .where(sql<boolean>`search_fts MATCH ${match}`)
    .orderBy(sql`case when "notes"."title_key" = ${titleKey} then 0 else 1 end`)
    .orderBy(sql`bm25(search_fts, 0, 10.0, 1.0)`)
    .orderBy('notes.isPinned', 'desc')
    .orderBy('notes.mtime', 'desc')
    .orderBy('notes.path', 'asc')
    .execute()
  return rows.map((row) => ({ ...row, isPinned: row.isPinned !== 0 }))
}
