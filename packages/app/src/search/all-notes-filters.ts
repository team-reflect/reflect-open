import { addDaysToIsoDate, parseIsoDate } from '@reflect/utils'
import {
  foldTag,
  formatMonthDay,
  parseSearchQuery,
  type DateFormat,
  type FilteredSearchOptions,
  type ParsedSearchQuery,
  type UpdatedFilter,
} from '@reflect/core'

/**
 * The All tab's badge-filter model (Plan 19, V1 parity): AND-composed filters
 * that ride alongside the free-text search. V2 vocabulary drops V1's
 * *Published* (publishing has no v2 meaning) and *Created at* (the index has
 * no creation time — markdown carries none, and file birthtimes don't survive
 * Git/iCloud sync); everything else maps onto {@link ParsedSearchQuery}'s
 * existing filter dimensions, so the badges and typed `#tag`/`is:` tokens are
 * one search path.
 */

/**
 * A note chosen in a link-filter picker.
 */
export interface NoteFilterRef {
  /**
   * The picked note's exact path — what the link filter targets, so a duplicated title can never retarget it.
   */
  path: string
  /**
   * The note's title — the chip's label.
   */
  title: string
}

/**
 * Every badge on the All tab's filter row.
 */
export interface AllNotesFilters {
  pinned: boolean
  daily: boolean
  /**
   * Folded tag keys (multi-select; results carry every one).
   */
  tags: string[]
  /**
   * Results must link **to** this note.
   */
  linkedTo: NoteFilterRef | null
  /**
   * Results must be linked **from** this note.
   */
  linkedBy: NoteFilterRef | null
  updated: UpdatedFilter | null
}

export const EMPTY_ALL_NOTES_FILTERS: AllNotesFilters = {
  pinned: false,
  daily: false,
  tags: [],
  linkedTo: null,
  linkedBy: null,
  updated: null,
}

/**
 * True when any badge is active — shows the Reset control.
 */
export function hasActiveFilters(filters: AllNotesFilters): boolean {
  return (
    filters.pinned ||
    filters.daily ||
    filters.tags.length > 0 ||
    filters.linkedTo !== null ||
    filters.linkedBy !== null ||
    filters.updated !== null
  )
}

/**
 * Mirrors the indexed tag grammar (a `#`, then letters/numbers/slash/
 * underscore/dash) at the **end** of the query: the tag the user is mid-typing.
 */
const PENDING_TAG_RE = /(?:^|\s)#([\p{L}\p{N}/_-]*)$/u

export interface PendingTag {
  /**
   * The query with the trailing `#…` token removed.
   */
  rest: string
  /**
   * What follows the `#` so far (may be empty — bare `#` lists every tag).
   */
  partial: string
}

/**
 * A trailing `#…` token switches search into tag matching (V1): the token is
 * held out of the search text and drives tag suggestions instead, so a
 * half-typed tag never becomes a zero-result hard filter.
 */
export function pendingTagToken(query: string): PendingTag | null {
  const match = PENDING_TAG_RE.exec(query)
  if (match === null) {
    return null
  }
  return { rest: query.slice(0, match.index).trimEnd(), partial: match[1] ?? '' }
}

/**
 * The later of two inclusive lower bounds (AND semantics), null-tolerant.
 */
function laterBound(first: number | null, second: number | null): number | null {
  if (first === null) {
    return second
  }
  return second === null ? first : Math.max(first, second)
}

/**
 * The earlier of two exclusive upper bounds (AND semantics), null-tolerant.
 */
function earlierBound(first: number | null, second: number | null): number | null {
  if (first === null) {
    return second
  }
  return second === null ? first : Math.min(first, second)
}

/**
 * Compose the live query into the one search input: typed tokens parse first
 * (`parseSearchQuery`), then the badges and the route's tag AND in on top —
 * typed filters win where the two name the same single-value dimension. A
 * trailing `#…` token is excluded (it is a suggestion, not a filter yet).
 */
export function buildAllNotesSearch(
  query: string,
  filters: AllNotesFilters,
  routeTag: string | null,
): ParsedSearchQuery {
  const pending = pendingTagToken(query)
  const parsed = parseSearchQuery(pending === null ? query : pending.rest)

  const tags = [...parsed.filters.tags]
  const extraTags = routeTag === null ? filters.tags : [...filters.tags, foldTag(routeTag)]
  for (const key of extraTags) {
    if (!tags.includes(key)) {
      tags.push(key)
    }
  }

  const merged: ParsedSearchQuery = {
    text: parsed.text,
    filtered: parsed.filtered || routeTag !== null || hasActiveFilters(filters),
    filters: {
      tags,
      dailyOnly: parsed.filters.dailyOnly || filters.daily,
      pinnedOnly: parsed.filters.pinnedOnly || filters.pinned,
      // Badges carry the picked note's exact path (a typed token still wins
      // the dimension); titles resolve, and duplicates could retarget.
      linksTo: parsed.filters.linksTo,
      linksToPath: parsed.filters.linksTo === null ? (filters.linkedTo?.path ?? null) : null,
      linkedFrom: parsed.filters.linkedFrom,
      linkedFromPath: parsed.filters.linkedFrom === null ? (filters.linkedBy?.path ?? null) : null,
      updatedAfterMs: laterBound(parsed.filters.updatedAfterMs, filters.updated?.afterMs ?? null),
      updatedBeforeMs: earlierBound(
        parsed.filters.updatedBeforeMs,
        filters.updated?.beforeMs ?? null,
      ),
    },
  }
  return merged
}

/**
 * Free-text searches cap at the same row budget V1's list search used.
 */
const SEARCH_LIMIT = 50

/**
 * How the All tab runs a composed query: free text is a ranked, capped
 * search; without text the query is the list itself — uncapped (the screen
 * virtualizes), notes-only (dailies live in the stream unless the Daily
 * filter asks for them), pinned first (V1's list order).
 */
export function searchPlanFor(parsed: ParsedSearchQuery): FilteredSearchOptions {
  return parsed.text !== ''
    ? { limit: SEARCH_LIMIT }
    : { limit: null, pinnedFirst: true, notesOnly: true }
}

/**
 * Resolve a custom range from the two date inputs (`''` = unbounded side).
 * The end date is inclusive — its bound is the start of the following day.
 * Returns null when both sides are empty (no constraint was formed).
 */
export function updatedRangeFilter(
  fromIso: string,
  toIso: string,
  dateFormat: DateFormat,
): UpdatedFilter | null {
  const from = fromIso === '' ? null : fromIso
  const to = toIso === '' ? null : toIso
  if (from === null && to === null) {
    return null
  }
  const dayLabel = (iso: string): string => formatMonthDay(iso, dateFormat)
  const label =
    from !== null && to !== null
      ? `${dayLabel(from)} – ${dayLabel(to)}`
      : from !== null
        ? `Since ${dayLabel(from)}`
        : // The empty-both case returned above, so `to` is set here.
          `Until ${dayLabel(to!)}`
  return {
    label,
    afterMs: from === null ? null : parseIsoDate(from).getTime(),
    beforeMs: to === null ? null : parseIsoDate(addDaysToIsoDate(to, 1)).getTime(),
  }
}
