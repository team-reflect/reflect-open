import { sql } from 'kysely'
import { foldTag, normalizeWikiTarget } from '../markdown'
import { generateDateSuggestions, type DateSuggestionContext } from './date-suggestions'
import { db } from './db'
import { inClauseChunks, likeContains } from './query-utils'
import {
  mergeDateSuggestions,
  rankWikiSuggestions,
  serializeWikiSuggestionAddress,
  type AliasCandidate,
  type TitleCandidate,
  type WikiLinkSuggestion,
  type WikiSuggestion,
} from './suggest'

/** One `#tag` autocomplete candidate: display casing + how many notes carry it. */
export interface TagSuggestion {
  tag: string
  count: number
}

/** Verified editor rows plus facts that remain true when rows are filtered. */
export interface WikiLinkSuggestionResult {
  readonly suggestions: readonly WikiLinkSuggestion[]
  /**
   * Folded candidate/query keys owned in `note_keys`, including ambiguous or
   * unsafe claims that could not become selectable rows.
   */
  readonly claimedTargetKeys: readonly string[]
  /** Whether the raw query produced at least one generated date candidate. */
  readonly queryReadsAsDate: boolean
}

interface WikiTargetCandidateResult {
  readonly candidates: readonly WikiSuggestion[]
  readonly candidateTargetKeys: readonly string[]
  readonly queryReadsAsDate: boolean
}

/**
 * `#` autocomplete candidates for `query` (Plan 18): tags whose folded key
 * contains the query, most-used first, deduped on the stored `tag_key`.
 */
export async function suggestTags(query: string, limit = 8): Promise<TagSuggestion[]> {
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
  return rows.map((row) => ({ tag: row.tag, count: Number(row.count) }))
}

/**
 * `[[` autocomplete candidates for `query` (Plan 07): title and alias contains-
 * matches ranked by {@link rankWikiSuggestions}. With `dateGen`, fuzzy date
 * suggestions are merged ahead of index matches.
 */
export async function suggestWikiTargets(
  query: string,
  limit = 8,
  dateGen?: DateSuggestionContext,
): Promise<WikiSuggestion[]> {
  if (limit <= 0) {
    return []
  }
  const result = await queryWikiTargetCandidates(query, dateGen)
  return result.candidates.slice(0, limit)
}

/**
 * `[[` autocomplete candidates whose serialized target is safe and verified to
 * resolve to the selected path. Navigation-only surfaces should use
 * {@link suggestWikiTargets}; they can navigate collision losers directly by
 * path and must not lose them merely because markdown cannot address them.
 */
export async function suggestWikiLinkTargets(
  query: string,
  limit = 8,
  dateGen?: DateSuggestionContext,
): Promise<WikiLinkSuggestionResult> {
  if (limit <= 0) {
    return { suggestions: [], claimedTargetKeys: [], queryReadsAsDate: false }
  }
  const result = await queryWikiTargetCandidates(query, dateGen)
  return verifyWikiSuggestionAddresses(
    result.candidates,
    result.candidateTargetKeys,
    limit,
    normalizeWikiTarget(query).key,
    result.queryReadsAsDate,
  )
}

async function queryWikiTargetCandidates(
  query: string,
  dateGen?: DateSuggestionContext,
): Promise<WikiTargetCandidateResult> {
  const normalized = normalizeWikiTarget(query)
  const key = normalized.key

  let titleQuery = db
    .selectFrom('notes')
    .where('kind', '!=', 'template')
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
      ])
      .orderBy('notes.mtime', 'desc')
      .limit(50)
      .execute()
  }

  // Rank the full bounded candidate set before address verification. Filtering
  // a collision loser must not prevent a lower-ranked, addressable note from
  // filling the requested menu capacity.
  const ranked = rankWikiSuggestions(key, titles, aliases, titles.length + aliases.length)
  const dates =
    dateGen === undefined ? [] : generateDateSuggestions(query, dateGen)
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

/**
 * Turn ranked candidates into selectable suggestions using `note_keys` as the
 * authoritative one-winner-per-key address map. Every target must also have
 * exactly one claimant in its winning tier, matching the ambiguity guard that
 * writable navigation applies to date-shaped and ordinary spellings alike.
 * The canonical title is preferred for alias rows; when it is ambiguous or
 * lost, a unique alias can rescue the note. A pathless generated date is
 * reattached to an existing daily even when its custom title kept it out of
 * the search rows. Candidates with no safe textual address are omitted.
 */
interface WikiAddressWinner {
  path: string
  dailyDate: string | null
  claimCount: number
}

function winnerAddressesPath(
  path: string,
  winner: WikiAddressWinner | undefined,
): boolean {
  return winner?.path === path && winner.claimCount === 1
}

/**
 * The verified suggestion for an existing note using only its ranked
 * spellings (canonical target, then the matched alias), or `null` when
 * neither is a safe winning address for `candidate.path`. The display half
 * of `target|display` is cosmetic: when the matched alias cannot ride along
 * in wiki-link syntax (`Dad|Junior`), the bare canonical address still opens
 * the same note, which beats hiding the note from the menu.
 */
function addressableAsRanked(
  candidate: WikiSuggestion,
  winners: ReadonlyMap<string, WikiAddressWinner>,
): WikiLinkSuggestion | null {
  if (candidate.path === null) {
    return null
  }
  const canonicalWinner = winners.get(normalizeWikiTarget(candidate.target).key)
  const canonicalInsert =
    serializeWikiSuggestionAddress(candidate.target, candidate.alias) ??
    serializeWikiSuggestionAddress(candidate.target, null)
  if (
    winnerAddressesPath(candidate.path, canonicalWinner) &&
    canonicalInsert !== null
  ) {
    return { ...candidate, insertText: canonicalInsert }
  }
  if (candidate.alias !== null) {
    const aliasKey = normalizeWikiTarget(candidate.alias).key
    const aliasInsert = serializeWikiSuggestionAddress(candidate.alias, null)
    if (
      winnerAddressesPath(candidate.path, winners.get(aliasKey)) &&
      aliasInsert !== null
    ) {
      return { ...candidate, insertText: aliasInsert }
    }
  }
  return null
}

/**
 * For each path, the aliases (declaration order) that safely address the note:
 * the note wins `note_keys` and the alias is uniquely claimed in its winning
 * tier. These rescue notes whose ranked spellings are ambiguous, lost, or
 * cannot be serialized.
 */
async function winningAliasesByPath(
  paths: ReadonlySet<string>,
): Promise<Map<string, string[]>> {
  const winning = new Map<string, string[]>()
  for (const chunk of inClauseChunks([...paths])) {
    const rows = await db
      .selectFrom('aliases')
      .innerJoin('noteKeys', (join) =>
        join
          .onRef('noteKeys.key', '=', 'aliases.aliasKey')
          .onRef('noteKeys.notePath', '=', 'aliases.notePath'),
      )
      .where('aliases.notePath', 'in', chunk)
      .select(['aliases.notePath', 'aliases.alias', 'noteKeys.claimCount'])
      .orderBy(sql`"aliases"."rowid"`)
      .execute()
    for (const row of rows) {
      if (Number(row.claimCount) !== 1) {
        continue
      }
      const aliases = winning.get(row.notePath) ?? []
      aliases.push(row.alias)
      winning.set(row.notePath, aliases)
    }
  }
  return winning
}

async function verifyWikiSuggestionAddresses(
  candidates: readonly WikiSuggestion[],
  candidateTargetKeys: readonly string[],
  limit: number,
  queryKey: string,
  queryReadsAsDate: boolean,
): Promise<WikiLinkSuggestionResult> {
  const keys = new Set(candidateTargetKeys)
  keys.add(queryKey)
  for (const candidate of candidates) {
    keys.add(normalizeWikiTarget(candidate.target).key)
    if (candidate.alias !== null) {
      keys.add(normalizeWikiTarget(candidate.alias).key)
    }
  }
  keys.delete('')

  const winners = new Map<string, WikiAddressWinner>()
  for (const chunk of inClauseChunks([...keys])) {
    const rows = await db
      .selectFrom('noteKeys')
      .innerJoin('notes', 'notes.path', 'noteKeys.notePath')
      .where('key', 'in', chunk)
      .select(['key', 'notePath', 'notes.dailyDate', 'noteKeys.claimCount'])
      .execute()
    for (const row of rows) {
      if (row.key !== null && row.notePath !== null) {
        winners.set(row.key, {
          path: row.notePath,
          dailyDate: row.dailyDate,
          claimCount: Number(row.claimCount),
        })
      }
    }
  }

  const unaddressedPaths = new Set<string>()
  for (const candidate of candidates) {
    if (candidate.path !== null && addressableAsRanked(candidate, winners) === null) {
      unaddressedPaths.add(candidate.path)
    }
  }
  const rescueAliases =
    unaddressedPaths.size > 0
      ? await winningAliasesByPath(unaddressedPaths)
      : new Map<string, string[]>()
  const claimedTargetKeys = new Set(winners.keys())
  for (const aliases of rescueAliases.values()) {
    for (const alias of aliases) {
      claimedTargetKeys.add(normalizeWikiTarget(alias).key)
    }
  }

  const verified: WikiLinkSuggestion[] = []
  for (const candidate of candidates) {
    if (candidate.path === null) {
      const canonicalWinner = winners.get(normalizeWikiTarget(candidate.target).key)
      const insertText = serializeWikiSuggestionAddress(
        candidate.target,
        candidate.alias,
      )
      if (insertText !== null) {
        if (canonicalWinner === undefined) {
          verified.push({ ...candidate, insertText })
        } else if (
          candidate.date !== null &&
          canonicalWinner.dailyDate === candidate.date &&
          canonicalWinner.claimCount === 1
        ) {
          verified.push({
            ...candidate,
            path: canonicalWinner.path,
            insertText,
          })
        }
      }
    } else {
      const ranked = addressableAsRanked(candidate, winners)
      if (ranked !== null) {
        verified.push(ranked)
      } else {
        for (const alias of rescueAliases.get(candidate.path) ?? []) {
          const insertText = serializeWikiSuggestionAddress(alias, null)
          if (insertText !== null) {
            verified.push({ ...candidate, alias, insertText })
            break
          }
        }
      }
    }

    if (verified.length >= limit) {
      break
    }
  }
  return {
    suggestions: verified,
    claimedTargetKeys: [...claimedTargetKeys].sort(),
    queryReadsAsDate,
  }
}
