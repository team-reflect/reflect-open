import type { TagFacet as TagSuggestion } from '@reflect/types'
import type { MaybePromise } from '@reflect/utils'
import { foldTag, normalizeWikiTarget } from '../markdown/index.ts'
import type { DatabaseService } from './database-service.ts'
import type { DateSuggestionContext } from './date-suggestion-types.ts'
import { generateDateSuggestions } from './date-suggestions.ts'
import { verifyWikiSuggestionAddresses, type WikiLinkSuggestionResult } from './queries-shared.ts'
import { mergeDateSuggestions, rankWikiSuggestions, type WikiSuggestion } from './suggest.ts'

/**
 * How many ranked-in-SQL rows each candidate query hands to the in-memory ranker.
 */
export type { TagSuggestion }

interface WikiTargetCandidateResult {
  readonly candidates: readonly WikiSuggestion[]
  readonly candidateTargetKeys: readonly string[]
  readonly queryReadsAsDate: boolean
}

export interface SuggestionServiceDeps {
  readonly database: DatabaseService
}

/**
 * Autocomplete candidates for `#` tags and `[[` wiki targets.
 */
export interface SuggestionService {
  /**
   * `#` autocomplete candidates for `query` (Plan 18): tags whose folded key
   * contains the query, most-used first, deduped on the stored `tag_key`.
   */
  suggestTags(query: string, limit?: number): MaybePromise<TagSuggestion[]>
  /**
   * `[[` autocomplete candidates for `query` (Plan 07): title and alias contains-
   * matches ranked by {@link rankWikiSuggestions}. With `dateGen`, fuzzy date
   * suggestions are merged ahead of index matches.
   */
  suggestWikiTargets(
    query: string,
    limit?: number,
    dateGen?: DateSuggestionContext,
  ): MaybePromise<WikiSuggestion[]>
  /**
   * `[[` autocomplete candidates whose serialized target is safe and verified to
   * resolve to the selected path. Navigation-only surfaces should use
   * {@link suggestWikiTargets}; they can navigate collision losers directly by
   * path and must not lose them merely because markdown cannot address them.
   */
  suggestWikiLinkTargets(
    query: string,
    limit?: number,
    dateGen?: DateSuggestionContext,
  ): MaybePromise<WikiLinkSuggestionResult>
}

class SuggestionServiceImpl implements SuggestionService {
  readonly #deps: SuggestionServiceDeps

  constructor(deps: SuggestionServiceDeps) {
    this.#deps = deps
  }

  async suggestTags(query: string, limit = 8): Promise<TagSuggestion[]> {
    if (limit <= 0) {
      return []
    }
    return await this.#deps.database.read('index_suggest_tags', {
      tagKey: foldTag(query.trim()),
      limit,
    })
  }

  async suggestWikiTargets(
    query: string,
    limit = 8,
    dateGen?: DateSuggestionContext,
  ): Promise<WikiSuggestion[]> {
    if (limit <= 0) {
      return []
    }
    const result = await queryWikiTargetCandidates(this.#deps.database, query, dateGen)
    return result.candidates.slice(0, limit)
  }

  async suggestWikiLinkTargets(
    query: string,
    limit = 8,
    dateGen?: DateSuggestionContext,
  ): Promise<WikiLinkSuggestionResult> {
    const { database } = this.#deps
    if (limit <= 0) {
      return { suggestions: [], claimedTargetKeys: [], queryReadsAsDate: false }
    }
    const result = await queryWikiTargetCandidates(database, query, dateGen)
    return await verifyWikiSuggestionAddresses(
      database,
      result.candidates,
      result.candidateTargetKeys,
      limit,
      normalizeWikiTarget(query).key,
      result.queryReadsAsDate,
    )
  }
}

export function createSuggestionService(deps: SuggestionServiceDeps): SuggestionService {
  return new SuggestionServiceImpl(deps)
}

async function queryWikiTargetCandidates(
  database: DatabaseService,
  query: string,
  dateGen?: DateSuggestionContext,
): Promise<WikiTargetCandidateResult> {
  const normalized = normalizeWikiTarget(query)
  const key = normalized.key

  const { titles, aliases } = await database.read('index_wiki_candidates', { key })

  // Rank the full bounded candidate set before address verification. Filtering
  // a collision loser must not prevent a lower-ranked, addressable note from
  // filling the requested menu capacity.
  const ranked = rankWikiSuggestions(key, titles, aliases, titles.length + aliases.length)
  const dates = dateGen === undefined ? [] : generateDateSuggestions(query, dateGen)
  const candidateTargetKeys = new Set<string>()
  for (const title of titles) {
    candidateTargetKeys.add(title.titleKey)
  }
  for (const alias of aliases) {
    candidateTargetKeys.add(alias.titleKey)
    candidateTargetKeys.add(alias.aliasKey)
  }
  for (const date of dates) {
    candidateTargetKeys.add(normalizeWikiTarget(date.date).key)
  }
  candidateTargetKeys.delete('')
  let candidates: WikiSuggestion[]
  if (dateGen !== undefined) {
    candidates = mergeDateSuggestions(ranked, dates, {
      key,
      limit: ranked.length + dates.length,
    })
  } else if (normalized.date !== undefined) {
    const date = normalized.date
    const existing = ranked.find((suggestion) => suggestion.date === date)
    const daily: WikiSuggestion = existing ?? {
      target: date,
      path: null,
      title: date,
      alias: null,
      date,
    }
    candidates = [daily, ...ranked.filter((suggestion) => suggestion !== existing)]
  } else {
    candidates = ranked
  }

  return {
    candidates,
    candidateTargetKeys: [...candidateTargetKeys],
    queryReadsAsDate: dates.length > 0,
  }
}
