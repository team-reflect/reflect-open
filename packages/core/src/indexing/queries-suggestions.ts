import { sql } from 'kysely'
import {
  createExistingWikiTargetResolver,
  type ExistingWikiTargetResolver,
} from '../graph/resolve-existing-wiki-target'
import { foldTag, normalizeWikiTarget } from '../markdown'
import { generateDateSuggestions, type DateSuggestionContext } from './date-suggestions'
import { db, dbForGraphGeneration } from './db'
import { inClauseChunks, likeContains } from './query-utils'
import {
  mergeDateSuggestions,
  rankWikiSuggestions,
  type AliasCandidate,
  type TitleCandidate,
  type WikiSuggestion,
} from './suggest'

/** One `#tag` autocomplete candidate: display casing + how many notes carry it. */
export interface TagSuggestion {
  tag: string
  count: number
}

interface NoteKeyOwner {
  readonly notePath: string
  readonly priority: number
}

function pathQualifiedWikiTarget(path: string): string {
  const withoutExtension = path.endsWith('.md') ? path.slice(0, -3) : path
  return withoutExtension.includes('/') ? withoutExtension : `./${withoutExtension}`
}

/**
 * Make every indexed autocomplete target resolve back to the row the user
 * selected. Bare targets stay compact when the winning resolution tier has
 * one owner; collisions use the shortest vault-root-qualified spelling (the
 * graph-relative path without the optional `.md`).
 */
async function qualifyAmbiguousWikiSuggestions(
  suggestions: readonly WikiSuggestion[],
): Promise<WikiSuggestion[]> {
  const keys = [
    ...new Set(
      suggestions.flatMap((suggestion) =>
        suggestion.path === null ? [] : [normalizeWikiTarget(suggestion.target).key],
      ),
    ),
  ].filter((key) => key !== '')
  const ownersByKey = new Map<string, Map<string, number>>()
  for (const chunk of inClauseChunks(keys)) {
    const rows = await db
      .selectFrom('noteKeys')
      .where('key', 'in', chunk)
      .select(['key', 'notePath', 'priority'])
      .orderBy('key')
      .orderBy('priority')
      .orderBy('notePath')
      .execute()
    for (const row of rows) {
      if (row.key === null || row.notePath === null || row.priority === null) {
        continue
      }
      const owners = ownersByKey.get(row.key) ?? new Map<string, number>()
      const priority = Number(row.priority)
      owners.set(row.notePath, Math.min(owners.get(row.notePath) ?? priority, priority))
      ownersByKey.set(row.key, owners)
    }
  }

  return suggestions.map((suggestion) => {
    if (suggestion.path === null) {
      return suggestion
    }
    const key = normalizeWikiTarget(suggestion.target).key
    const owners: NoteKeyOwner[] = [...(ownersByKey.get(key) ?? [])].map(
      ([notePath, priority]) => ({ notePath, priority }),
    )
    const bestPriority = owners.reduce(
      (best, owner) => Math.min(best, owner.priority),
      Number.POSITIVE_INFINITY,
    )
    const winners = owners.filter((owner) => owner.priority === bestPriority)
    if (winners.length === 1 && winners[0]!.notePath === suggestion.path) {
      return suggestion
    }
    return {
      ...suggestion,
      target: pathQualifiedWikiTarget(suggestion.path),
      disambiguated: true,
    }
  })
}

async function qualifyLiveWikiSuggestionBatch(
  suggestions: readonly WikiSuggestion[],
  resolver: ExistingWikiTargetResolver,
): Promise<WikiSuggestion[]> {
  const indexed = suggestions.filter(
    (suggestion): suggestion is WikiSuggestion & { readonly path: string } =>
      suggestion.path !== null,
  )
  const targets = [...new Set(indexed.map((suggestion) => suggestion.target))]
  const resolutions = await resolver.resolve(targets)
  const resolutionByTarget = new Map(
    targets.map((target, index) => [target, resolutions[index]!] as const),
  )

  return suggestions.flatMap((suggestion) => {
    if (suggestion.path === null) {
      return [suggestion]
    }
    const resolution = resolutionByTarget.get(suggestion.target)
    if (resolution?.orphanedPaths?.includes(suggestion.path) === true) {
      return []
    }
    if (
      resolution?.kind === 'resolved' &&
      resolution.path === suggestion.path
    ) {
      return [suggestion]
    }
    return [{
      ...suggestion,
      target: pathQualifiedWikiTarget(suggestion.path),
      disambiguated: true,
    }]
  })
}

async function qualifyLiveWikiSuggestions(
  suggestions: readonly WikiSuggestion[],
  generation: number,
  limit: number,
): Promise<WikiSuggestion[]> {
  if (limit <= 0 || suggestions.length === 0) {
    return []
  }
  const qualified: WikiSuggestion[] = []
  const resolver = createExistingWikiTargetResolver(generation)
  // Keep live-resolution work proportional to the requested menu size. When
  // a leading indexed row is an orphan, advance through another bounded batch
  // instead of resolving every title and alias candidate for each keystroke.
  const batchSize = Math.max(1, Math.min(limit, 8))
  for (let offset = 0; offset < suggestions.length; offset += batchSize) {
    const batch = suggestions.slice(offset, offset + batchSize)
    qualified.push(...await qualifyLiveWikiSuggestionBatch(batch, resolver))
    if (qualified.length >= limit) {
      return qualified.slice(0, limit)
    }
  }
  return qualified
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
 * `[[` autocomplete candidates for `query` (Plan 07): date, authored-title,
 * alias, and filename-stem contains-matches ranked by
 * {@link rankWikiSuggestions}. With `dateGen`, fuzzy date suggestions are
 * merged ahead of index matches. Insertion surfaces pass `generation` so
 * uniqueness is rechecked against one live manifest/index delta; index-only
 * navigation surfaces may omit it because they already carry the chosen path.
 */
export async function suggestWikiTargets(
  query: string,
  limit = 8,
  dateGen?: DateSuggestionContext,
  generation?: number,
): Promise<WikiSuggestion[]> {
  const normalized = normalizeWikiTarget(query)
  const key = normalized.key
  const database = generation === undefined ? db : dbForGraphGeneration(generation)

  let titleQuery = database
    .selectFrom('notes')
    .where('kind', '!=', 'template')
    .select([
      'path',
      'title',
      'titleKey',
      'authoredTitleKey',
      'basenameKey',
      'dailyDate',
      'mtime',
    ])
    .orderBy('mtime', 'desc')
    .limit(50)
  if (key !== '') {
    titleQuery = titleQuery.where(({ or }) =>
      or([
        sql<boolean>`daily_date LIKE ${likeContains(key)} ESCAPE '\\'`,
        sql<boolean>`authored_title_key LIKE ${likeContains(key)} ESCAPE '\\'`,
        sql<boolean>`basename_key LIKE ${likeContains(key)} ESCAPE '\\'`,
      ]),
    )
  }
  const titles: TitleCandidate[] = await titleQuery.execute()

  let aliases: AliasCandidate[] = []
  if (key !== '') {
    aliases = await database
      .selectFrom('aliases')
      .innerJoin('notes', 'notes.path', 'aliases.notePath')
      .where('notes.kind', '!=', 'template')
      .where(sql<boolean>`alias_key LIKE ${likeContains(key)} ESCAPE '\\'`)
      .select([
        'notes.path',
        'notes.title',
        'notes.titleKey',
        'notes.authoredTitleKey',
        'notes.basenameKey',
        'notes.dailyDate',
        'notes.mtime',
        'aliases.alias',
        'aliases.aliasKey',
      ])
      .orderBy('notes.mtime', 'desc')
      .limit(50)
      .execute()
  }

  const candidates = rankWikiSuggestions(
    key,
    titles,
    aliases,
    titles.length + aliases.length,
  )
  const ranked = generation === undefined
    ? (await qualifyAmbiguousWikiSuggestions(candidates)).slice(0, limit)
    : await qualifyLiveWikiSuggestions(candidates, generation, limit)
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
