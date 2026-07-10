/**
 * Pure ranking for `[[` autocomplete (Plan 07): merges title and alias matches
 * from the index into one ordered candidate list. The SQL layer (`queries.ts`)
 * only guarantees "contains the query somewhere"; the ordering policy — exact
 * before prefix before substring, titles before aliases, recent before stale —
 * lives here where it can be unit-tested without a database.
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
  /** Canonical resolution target (a note title, or an ISO date). */
  target: string
  /** The note it resolves to — `null` for a daily whose file doesn't exist yet. */
  path: string | null
  /** Display title (for dailies this is the ISO date; hosts format it). */
  title: string
  /** Set for an alias hit; shown in the menu and preserved as the link's display text. */
  alias: string | null
  /** Set on daily-note suggestions. */
  date: string | null
  /** Set only on rows the date generator synthesised; see {@link GeneratedDate}. */
  generated?: GeneratedDate
}

/**
 * The exact text to insert inside `[[…]]` for a suggestion. Alias hits retain
 * the canonical target for unambiguous resolution while displaying the alias
 * the user searched for: `Tim MacCaw // Dad|Dad`. Title and date hits remain
 * bare targets.
 */
export function wikiSuggestionInsertText(suggestion: WikiSuggestion): string {
  return suggestion.alias === null
    ? suggestion.target
    : `${suggestion.target}|${suggestion.alias}`
}

/** One `notes` row considered for suggestion (a title match or recency fill). */
export interface TitleCandidate {
  path: string
  title: string
  titleKey: string
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

/**
 * Merge and order candidates for `key` (the case-folded query). Alias hits
 * rank just behind the equivalent title hit, ties break on file recency, and a
 * note appears once — its best-scoring entry wins (so a note whose title *and*
 * alias both match shows as the plain title row).
 */
export function rankWikiSuggestions(
  key: string,
  titles: TitleCandidate[],
  aliases: AliasCandidate[],
  limit: number,
): WikiSuggestion[] {
  const scored: Scored[] = [
    ...titles.map((row) => ({
      suggestion: {
        target: row.dailyDate ?? row.title,
        path: row.path,
        title: row.title,
        alias: null,
        date: row.dailyDate,
      },
      // ×2 leaves room for the alias penalty between match ranks.
      score: matchRank(key, row.titleKey) * 2,
      mtime: row.mtime,
    })),
    ...aliases.map((row) => ({
      suggestion: {
        target: row.dailyDate ?? row.title,
        path: row.path,
        title: row.title,
        alias: row.alias,
        date: row.dailyDate,
      },
      score: matchRank(key, row.aliasKey) * 2 + 1,
      mtime: row.mtime,
    })),
  ]

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
