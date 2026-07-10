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
  return (await queryWikiTargetCandidates(query, dateGen)).slice(0, limit)
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
): Promise<WikiLinkSuggestion[]> {
  if (limit <= 0) {
    return []
  }
  return verifyWikiSuggestionAddresses(
    await queryWikiTargetCandidates(query, dateGen),
    limit,
  )
}

async function queryWikiTargetCandidates(
  query: string,
  dateGen?: DateSuggestionContext,
): Promise<WikiSuggestion[]> {
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
  let candidates: WikiSuggestion[]
  if (dateGen !== undefined) {
    const dates = generateDateSuggestions(query, dateGen)
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

  return candidates
}

/**
 * Turn ranked candidates into selectable suggestions using `note_keys` as the
 * authoritative one-winner-per-key address map. The canonical title is the
 * preferred target for alias rows; if that title lost a collision but the
 * selected alias itself resolves to the note, the alias remains a truthful
 * fallback address. Candidates with no safe textual address are omitted.
 */
async function verifyWikiSuggestionAddresses(
  candidates: readonly WikiSuggestion[],
  limit: number,
): Promise<WikiLinkSuggestion[]> {
  const keys = new Set<string>()
  for (const candidate of candidates) {
    keys.add(normalizeWikiTarget(candidate.target).key)
    if (candidate.alias !== null) {
      keys.add(normalizeWikiTarget(candidate.alias).key)
    }
  }
  keys.delete('')

  const winners = new Map<string, string>()
  for (const chunk of inClauseChunks([...keys])) {
    const rows = await db
      .selectFrom('noteKeys')
      .where('key', 'in', chunk)
      .select(['key', 'notePath'])
      .execute()
    for (const row of rows) {
      if (row.key !== null && row.notePath !== null) {
        winners.set(row.key, row.notePath)
      }
    }
  }

  const verified: WikiLinkSuggestion[] = []
  for (const candidate of candidates) {
    const canonicalKey = normalizeWikiTarget(candidate.target).key
    if (candidate.path === null) {
      const insertText =
        winners.has(canonicalKey)
          ? null
          : serializeWikiSuggestionAddress(candidate.target, candidate.alias)
      if (insertText !== null) {
        verified.push({ ...candidate, insertText })
      }
    } else {
      const canonicalInsert = serializeWikiSuggestionAddress(
        candidate.target,
        candidate.alias,
      )
      if (winners.get(canonicalKey) === candidate.path && canonicalInsert !== null) {
        verified.push({ ...candidate, insertText: canonicalInsert })
      } else if (candidate.alias !== null) {
        const aliasKey = normalizeWikiTarget(candidate.alias).key
        const aliasInsert = serializeWikiSuggestionAddress(candidate.alias, null)
        if (winners.get(aliasKey) === candidate.path && aliasInsert !== null) {
          verified.push({ ...candidate, insertText: aliasInsert })
        }
      }
    }

    if (verified.length >= limit) {
      break
    }
  }
  return verified
}
