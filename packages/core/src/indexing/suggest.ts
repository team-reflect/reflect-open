/**
 * Pure ranking for `[[` autocomplete (Plan 07): merges date, authored-title,
 * alias, and filename-stem matches from the index into one ordered candidate
 * list. The SQL layer only guarantees "contains the query somewhere"; the
 * ordering policy — exact before prefix before substring, resolver precedence
 * within a match rank, recent before stale — lives here where it can be
 * unit-tested without a database.
 */

import { foldKey } from '../markdown/keys'
import type { DateSuggestion } from './date-suggestions'

/**
 * Marks a suggestion the date generator synthesised from a fuzzy query and
 * carries its menu label. The presence of this object — not a bare optional
 * field — is the explicit discriminator hosts branch on (suppress the "Create"
 * row, trail real notes in the palette); the `phrase` can never drift onto a
 * non-generated row.
 */
export interface GeneratedDate {
  /** Human label for the menu ("3 days ago", "Next Friday"). */
  phrase: string
}

/** A `[[` autocomplete candidate. */
export interface WikiSuggestion {
  /** What `[[…]]` should contain when chosen (the canonical title, or an ISO date). */
  target: string
  /** The note it resolves to — `null` for a daily whose file doesn't exist yet. */
  path: string | null
  /** Display title (for dailies this is the ISO date; hosts format it). */
  title: string
  /** Set when the match came in via an alias (display as "alias → title"). */
  alias: string | null
  /** Set on daily-note suggestions. */
  date: string | null
  /** Set only on rows the date generator synthesised; see {@link GeneratedDate}. */
  generated?: GeneratedDate
  /** True when duplicate owners require the path-qualified target and path detail. */
  disambiguated?: boolean
}

/** One `notes` row considered for suggestion (a note-key match or recency fill). */
export interface TitleCandidate {
  path: string
  title: string
  titleKey: string
  authoredTitleKey: string | null
  basenameKey: string
  dailyDate: string | null
  mtime: number
}

/** One `aliases ⋈ notes` row (an alias match). */
export interface AliasCandidate extends TitleCandidate {
  alias: string
  aliasKey: string
}

/** Lower ranks first: exact (0) < prefix (1) < substring (2); 3 = recency fill. */
function matchRank(key: string, candidateKey: string): number {
  if (key === '') {
    return 3
  }
  if (candidateKey === key) {
    return 0
  }
  return candidateKey.startsWith(key) ? 1 : 2
}

interface Scored {
  suggestion: WikiSuggestion
  score: number
  mtime: number
}

const MATCH_TIER_COUNT = 4

function basenameTarget(path: string): string {
  const filename = path.split('/').at(-1) ?? path
  return filename.endsWith('.md') ? filename.slice(0, -3) : filename
}

function candidateSuggestion(
  row: TitleCandidate,
  target: string,
  alias: string | null,
): WikiSuggestion {
  return {
    target,
    path: row.path,
    title: row.title,
    alias,
    date: row.dailyDate,
  }
}

function scoredCandidate(
  row: TitleCandidate,
  key: string,
  candidateKey: string,
  precedence: number,
  target: string,
  alias: string | null = null,
): Scored {
  return {
    suggestion: candidateSuggestion(row, target, alias),
    score: matchRank(key, candidateKey) * MATCH_TIER_COUNT + precedence,
    mtime: row.mtime,
  }
}

/**
 * Merge and order candidates for `key` (the case-folded query). Within an
 * equivalent match rank, candidates follow bare-wikilink resolution order:
 * daily date, authored title, alias, then filename stem. Ties break on file
 * recency, and a note appears once — its best-scoring entry wins.
 */
export function rankWikiSuggestions(
  key: string,
  titles: TitleCandidate[],
  aliases: AliasCandidate[],
  limit: number,
): WikiSuggestion[] {
  const scored: Scored[] = []

  for (const row of titles) {
    if (key === '') {
      scored.push({
        suggestion: candidateSuggestion(row, row.dailyDate ?? row.title, null),
        score: matchRank(key, row.titleKey) * MATCH_TIER_COUNT,
        mtime: row.mtime,
      })
      continue
    }

    if (row.dailyDate?.includes(key) === true) {
      scored.push(scoredCandidate(row, key, row.dailyDate, 0, row.dailyDate))
    }
    if (row.authoredTitleKey?.includes(key) === true) {
      scored.push(
        scoredCandidate(row, key, row.authoredTitleKey, 1, row.dailyDate ?? row.title),
      )
    }
    if (row.basenameKey.includes(key)) {
      scored.push(scoredCandidate(row, key, row.basenameKey, 3, basenameTarget(row.path)))
    }
  }

  for (const row of aliases) {
    scored.push(
      scoredCandidate(row, key, row.aliasKey, 2, row.dailyDate ?? row.title, row.alias),
    )
  }

  scored.sort(
    (a, b) =>
      a.score - b.score ||
      b.mtime - a.mtime ||
      a.suggestion.title.localeCompare(b.suggestion.title),
  )

  const seen = new Set<string>()
  const result: WikiSuggestion[] = []
  for (const { suggestion } of scored) {
    if (suggestion.path !== null && seen.has(suggestion.path)) {
      continue
    }
    if (suggestion.path !== null) {
      seen.add(suggestion.path)
    }
    result.push(suggestion)
    if (result.length >= limit) {
      break
    }
  }
  return result
}

/**
 * Fold generated date suggestions into the ranked index results for the `[[`
 * menu. Dates lead the list — except an exact title/alias match keeps the very
 * top slot, the way V1 lets a note literally titled "Today" outrank the
 * generated *Today*. When a generated day already exists as an indexed daily,
 * that real row is reused (so the link resolves to the existing file) but
 * carries the phrase, and a day never appears twice.
 *
 * Pure so the ordering policy is unit-testable without a database; the only
 * caller is {@link suggestWikiTargets}.
 */
export function mergeDateSuggestions(
  ranked: WikiSuggestion[],
  dates: readonly DateSuggestion[],
  options: { key: string; limit: number },
): WikiSuggestion[] {
  if (dates.length === 0) {
    return ranked.slice(0, options.limit)
  }
  const rankedByDate = new Map<string, WikiSuggestion>()
  for (const suggestion of ranked) {
    if (suggestion.date !== null) {
      rankedByDate.set(suggestion.date, suggestion)
    }
  }

  const reused = new Set<WikiSuggestion>()
  const dateRows: WikiSuggestion[] = dates.map(({ date, phrase }) => {
    // A bare ISO query has no friendlier phrase, so it stays a plain daily (no
    // `generated` marker) and behaves like an existing daily, not a synthesised one.
    const generated = phrase === null ? undefined : { phrase }
    const existing = rankedByDate.get(date)
    if (existing !== undefined) {
      reused.add(existing)
      return generated === undefined ? existing : { ...existing, generated }
    }
    return {
      target: date,
      path: null,
      title: date,
      alias: null,
      date,
      ...(generated === undefined ? {} : { generated }),
    }
  })

  const rest = ranked.filter((suggestion) => !reused.has(suggestion))
  const exactIndex = rest.findIndex(
    (suggestion) =>
      foldKey(suggestion.target) === options.key ||
      (suggestion.alias !== null && foldKey(suggestion.alias) === options.key),
  )
  const exact = exactIndex >= 0 ? rest[exactIndex] : undefined
  const ordered = exact
    ? [exact, ...dateRows, ...rest.filter((_, index) => index !== exactIndex)]
    : [...dateRows, ...rest]
  return ordered.slice(0, options.limit)
}
