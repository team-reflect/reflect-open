import { foldKey } from '../markdown/index.ts'
import { displayNoteTitle } from '../markdown/note-title.ts'
import type { DatabaseService } from './database-service.ts'
import type { ParsedSearchQuery } from './filter-query.ts'
import { HIGHLIGHT_START } from './search.ts'
import { highlightTitle } from './title-highlight.ts'
import type { WikiResolverService } from './wiki-resolver-service.ts'

/**
 * The one palette search (Plan 08): parsed filter tokens become composable
 * predicates on `notes` (EXISTS subqueries against `tags` and the `backlinks`
 * view), with free text constraining and ranking through FTS plus folded
 * title recall. Title recall matches each query term at a title word start —
 * except terms in unsegmented scripts such as Japanese, which match anywhere:
 * FTS5's default `unicode61` tokenizer treats an uninterrupted title as one
 * token, so a shorter title query can never match it lexically
 * (`buildTitleMatchSql`). Free-text ranking promotes exact, prefix, then
 * all-terms title matches ahead of body hits, followed by title-boosted bm25,
 * pinned, and recency. Filters may be empty — plain text search is the
 * degenerate case, so there is exactly one search path to keep correct.
 * Without text, results order by recency — a (possibly filtered) recall feed.
 * The mobile All tab reuses that recall feed as its filtered list via
 * {@link FilteredSearchOptions}.
 */

export interface FilteredSearchHit {
  path: string
  title: string
  /**
   * The title's display form (a `//` subject reduced to its first segment)
   * with search matches marked; plain when the title did not match.
   */
  highlightedTitle: string
  dailyDate: string | null
  /**
   * Highlighted body snippet when free text was searched, else null.
   */
  snippet: string | null
  /**
   * The indexed row preview — the no-text feed's row snippet.
   */
  preview: string
  /**
   * File modification time (epoch ms) — drives the row's recency label.
   */
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

/**
 * The columns every hit carries besides the FTS snippet.
 */
export interface SearchServiceDeps {
  readonly database: DatabaseService
  readonly wikiResolver: WikiResolverService
}

/**
 * The palette's full-text search with filters.
 */
export interface SearchService {
  /**
   * Search the graph with parsed filters (see {@link FilteredSearchOptions}).
   */
  searchWithFilters(
    parsed: ParsedSearchQuery,
    options?: FilteredSearchOptions,
  ): Promise<FilteredSearchHit[]>
}

class SearchServiceImpl implements SearchService {
  readonly #deps: SearchServiceDeps

  constructor(deps: SearchServiceDeps) {
    this.#deps = deps
  }

  async searchWithFilters(
    parsed: ParsedSearchQuery,
    options: FilteredSearchOptions = {},
  ): Promise<FilteredSearchHit[]> {
    const { wikiResolver } = this.#deps
    const { filters } = parsed
    const limit = options.limit === undefined ? 12 : options.limit

    // Link filters name a note by title/alias/date; resolve it once up front.
    // An unresolvable target matches nothing (the filter is explicit — silently
    // ignoring it would show results the user just excluded). Picker-set exact
    // paths skip resolution entirely — the caller already holds the note, and
    // resolving its title could land on a duplicate.
    let linksToPath: string | null = filters.linksToPath ?? null
    if (linksToPath === null && filters.linksTo !== null) {
      const resolution = await wikiResolver.resolveWikiTarget(filters.linksTo)
      if (resolution.kind !== 'resolved') {
        return []
      }
      linksToPath = resolution.ref
    }
    let linkedFromPath: string | null = filters.linkedFromPath ?? null
    if (linkedFromPath === null && filters.linkedFrom !== null) {
      const resolution = await wikiResolver.resolveWikiTarget(filters.linkedFrom)
      if (resolution.kind !== 'resolved') {
        return []
      }
      linkedFromPath = resolution.ref
    }

    const rows = await this.#deps.database.read('index_search', {
      request: {
        text: parsed.text,
        titleKey: foldKey(parsed.text),
        tagKeys: filters.tags,
        dailyOnly: filters.dailyOnly,
        notesOnly: options.notesOnly === true,
        pinnedOnly: filters.pinnedOnly,
        linksToPath,
        linkedFromPath,
        updatedAfterMs: filters.updatedAfterMs,
        updatedBeforeMs: filters.updatedBeforeMs,
        pinnedFirst: options.pinnedFirst === true,
        limit,
      },
    })
    // Without free text the result is a recall feed: nothing to highlight.
    const hasText = parsed.text.trim() !== ''
    return rows.map(({ ftsHighlightedTitle, snippet, ...row }) => ({
      ...row,
      // SQLite returns an unmarked body fragment when only the title matched.
      // That is not a search snippet and would be misleading in the result row.
      snippet: snippet?.includes(HIGHLIGHT_START) === true ? snippet : null,
      // The FTS markers describe the complete title; the same display
      // derivation keeps them aligned with the shortened title they highlight.
      highlightedTitle: hasText
        ? highlightTitle(
            displayNoteTitle(row.title),
            parsed.text,
            ftsHighlightedTitle === null ? null : displayNoteTitle(ftsHighlightedTitle),
          )
        : displayNoteTitle(row.title),
    }))
  }
}

export function createSearchService(deps: SearchServiceDeps): SearchService {
  return new SearchServiceImpl(deps)
}
