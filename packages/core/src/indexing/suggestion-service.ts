import type { MaybePromise } from '@reflect/utils'
import type { Database } from '@reflect/db'
import { sql, type Kysely } from 'kysely'
import { foldTag, normalizeWikiTarget } from '../markdown/index.ts'
import type { DatabaseService } from './database-service.ts'
import type { DateSuggestionContext } from './date-suggestion-types.ts'
import { generateDateSuggestions } from './date-suggestions.ts'
import { likeContains } from './query-utils.ts'
import { buildFtsTitlePrefixMatch } from './search-query.ts'
import { verifyWikiSuggestionAddresses, type WikiLinkSuggestionResult } from './queries-shared.ts'
import {
  mergeDateSuggestions,
  rankWikiSuggestions,
  type AliasCandidate,
  type TitleCandidate,
  type WikiSuggestion,
} from './suggest.ts'

/**
 * How many ranked-in-SQL rows each candidate query hands to the in-memory ranker.
 */
const WIKI_CANDIDATE_LIMIT = 200

/**
 * A note's usage signal: how many links in the graph name a spelling the note
 * claims. Both joins stay inside covering indexes (`note_claims_note`,
 * `links_target_key`), so counting never reads a `links` row.
 */
function selectLinkCount() {
  return sql<number>`(
    SELECT count(*) FROM note_claims
    JOIN links ON links.target_key = note_claims.key
    WHERE note_claims.note_path = notes.path
  )`.as('linkCount')
}

/**
 * One `#tag` autocomplete candidate: display casing + how many notes carry it.
 */
export interface TagSuggestion {
  tag: string
  count: number
}

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
    const { db } = this.#deps.database
    const key = foldTag(query.trim())
    let candidates = db
      .selectFrom('tags')
      .innerJoin('notes', 'notes.path', 'tags.notePath')
      .where('notes.kind', '!=', 'template')
      .select([sql<string>`min(tags.tag)`.as('tag'), sql<number>`count(*)`.as('count')])
      .groupBy('tags.tagKey')
      .orderBy(sql`count(*)`, 'desc')
      .orderBy(sql`min(tags.tag)`)
      .limit(limit)
    if (key !== '') {
      candidates = candidates.where(sql<boolean>`tag_key LIKE ${likeContains(key)} ESCAPE '\\'`)
    }
    const rows = await candidates.execute()
    return rows.map((row) => ({ tag: row.tag, count: row.count }))
  }

  async suggestWikiTargets(
    query: string,
    limit = 8,
    dateGen?: DateSuggestionContext,
  ): Promise<WikiSuggestion[]> {
    const { db } = this.#deps.database
    if (limit <= 0) {
      return []
    }
    const result = await queryWikiTargetCandidates(db, query, dateGen)
    return result.candidates.slice(0, limit)
  }

  async suggestWikiLinkTargets(
    query: string,
    limit = 8,
    dateGen?: DateSuggestionContext,
  ): Promise<WikiLinkSuggestionResult> {
    const { db } = this.#deps.database
    if (limit <= 0) {
      return { suggestions: [], claimedTargetKeys: [], queryReadsAsDate: false }
    }
    const result = await queryWikiTargetCandidates(db, query, dateGen)
    return await verifyWikiSuggestionAddresses(
      db,
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
  db: Kysely<Database>,
  query: string,
  dateGen?: DateSuggestionContext,
): Promise<WikiTargetCandidateResult> {
  const normalized = normalizeWikiTarget(query)
  const key = normalized.key

  // The pool is cut by usage before recency: a much-linked note stays in it
  // however long ago its file was last edited. An exact hit is always kept.
  // The search index also admits titles that differ only in accents (`elisk`
  // finds `Eliška`); those rank below spelled hits, so spelled hits fill the
  // pool first.
  const contains = sql<boolean>`title_key LIKE ${likeContains(key)} ESCAPE '\\'`
  const ftsMatch = buildFtsTitlePrefixMatch(key)
  let titleQuery = db
    .selectFrom('notes')
    .where('kind', '!=', 'template')
    .select(['path', 'title', 'titleKey', 'dailyDate', 'mtime', selectLinkCount()])
    .orderBy(sql`title_key = ${key}`, 'desc')
    .orderBy(contains, 'desc')
    .orderBy(sql`link_count`, 'desc')
    .orderBy('mtime', 'desc')
    .limit(WIKI_CANDIDATE_LIMIT)
  if (key === '') {
    // Days come from the date generator; the unqueried list is for notes.
    titleQuery = titleQuery.where('dailyDate', 'is', null)
  } else if (ftsMatch === null) {
    titleQuery = titleQuery.where(contains)
  } else {
    titleQuery = titleQuery.where(
      sql<boolean>`(${contains} OR path IN (SELECT path FROM search_fts WHERE search_fts MATCH ${ftsMatch}))`,
    )
  }
  const titles: TitleCandidate[] = await titleQuery.execute()

  let aliases: AliasCandidate[] = []
  if (key !== '') {
    aliases = await db
      .selectFrom('aliases')
      .innerJoin('notes', 'notes.path', 'aliases.notePath')
      .where('notes.kind', '!=', 'template')
      .where(sql<boolean>`alias_key LIKE ${likeContains(key)} ESCAPE '\\'`)
      .select([
        'notes.path',
        'notes.title',
        'notes.titleKey',
        'notes.dailyDate',
        'notes.mtime',
        'aliases.alias',
        'aliases.aliasKey',
        selectLinkCount(),
      ])
      .orderBy(sql`alias_key = ${key}`, 'desc')
      .orderBy(sql`link_count`, 'desc')
      .orderBy('notes.mtime', 'desc')
      .limit(WIKI_CANDIDATE_LIMIT)
      .execute()
  }

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
