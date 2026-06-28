/**
 * Date-suggestion generator for the `[[` autocomplete and the command palette:
 * synthesises daily-note targets from a fuzzy query the way the original Reflect
 * did. It interprets the query four ways at once — relative offsets
 * ("3 days ago"), natural-language dates ("next friday", "tomorrow"), typed
 * calendar dates ("12/25", "2026-06-19"), and month-name dates ("December 2nd")
 * — then merges them, de-duplicating by resolved day. See
 * `docs/reflect-v1-backlink-menu.md` for the behaviour this ports.
 *
 * Pure: the clock is injected as `today` (an ISO `YYYY-MM-DD` *local* date,
 * computed at the UI edge) and the calendar arithmetic comes from
 * `@reflect/utils`, which works in UTC so DST can never skip or repeat a day.
 * Each result is an ISO `YYYY-MM-DD` — the canonical daily-note form — paired
 * with the human `phrase` to show in the menu (`null` for a bare ISO query,
 * which needs no friendlier label than the date itself).
 */

import { addDaysIso, addMonthsIso, isCalendarDate, isoFromParts, weekdayIso } from '@reflect/utils'
import type { DateFormat, WeekStartDay } from '../settings/schema'

/** One synthesised daily-note target: the resolved day plus its menu label. */
export interface DateSuggestion {
  /** Resolved daily-note date, ISO `YYYY-MM-DD`. */
  date: string
  /** Human label for the menu ("3 days ago", "Next Friday"); `null` for a bare ISO query. */
  phrase: string | null
}

/** What the generator needs from its caller: the local clock and display preferences. */
export interface DateSuggestionContext {
  /** Today's local calendar date, ISO `YYYY-MM-DD`. */
  today: string
  /**
   * Reading order for ambiguous typed slash-dates (`mdy` → M/D, `dmy` → D/M).
   * `iso` has no slash-date order, so it keeps the default M/D reading.
   */
  dateFormat: DateFormat
  /** Which day "this/next/last week" (and weekend) anchor to. */
  weekStartDay: WeekStartDay
}

/** At most this many date suggestions survive into the menu. */
const MAX_RESULTS = 3
/** Relative offsets beyond this many years from today are treated as nonsense. */
const MAX_RELATIVE_YEARS = 15
/** Natural-language phrases need at least this many typed characters to appear. */
const MIN_PHRASE_CHARS = 3

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Is `iso` within {@link MAX_RELATIVE_YEARS} of `today`? ISO strings sort chronologically. */
function withinRelativeLimit(iso: string, today: string): boolean {
  return (
    iso >= addMonthsIso(today, -12 * MAX_RELATIVE_YEARS) &&
    iso <= addMonthsIso(today, 12 * MAX_RELATIVE_YEARS)
  )
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

// --- Relative offsets ("3 days ago", "2 weeks from now", "1") ---

type Unit = 'day' | 'week' | 'month' | 'year'
const UNITS: readonly Unit[] = ['day', 'week', 'month', 'year']
type Direction = 'future' | 'past'
const DIRECTIONS: readonly Direction[] = ['future', 'past']

const SPELLED_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
}

function extractNumber(tokens: readonly string[]): number | null {
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      return Number(token)
    }
    const spelled = SPELLED_NUMBERS[token]
    if (spelled !== undefined) {
      return spelled
    }
  }
  return null
}

function extractUnit(tokens: readonly string[]): Unit | null {
  for (const token of tokens) {
    const unit = UNITS.find((candidate) => candidate.startsWith(token) || `${candidate}s`.startsWith(token))
    if (unit !== undefined) {
      return unit
    }
  }
  return null
}

function extractDirection(tokens: readonly string[]): Direction | null {
  const hasPast = tokens.includes('ago')
  const hasFuture = tokens.some(
    (token) =>
      token === 'from' || token === 'now' || token === 'later' || token === 'in' || token === 'hence',
  )
  if (hasPast && !hasFuture) {
    return 'past'
  }
  if (hasFuture && !hasPast) {
    return 'future'
  }
  return null
}

function shiftByUnit(today: string, unit: Unit, amount: number): string {
  switch (unit) {
    case 'day':
      return addDaysIso(today, amount)
    case 'week':
      return addDaysIso(today, amount * 7)
    case 'month':
      return addMonthsIso(today, amount)
    case 'year':
      return addMonthsIso(today, amount * 12)
  }
}

function relativeSuggestions(tokens: readonly string[], context: DateSuggestionContext): DateSuggestion[] {
  const amount = extractNumber(tokens)
  if (amount === null) {
    return []
  }
  const unitFilter = extractUnit(tokens)
  const directionFilter = extractDirection(tokens)
  // A bare number ("1") offers offsets in every unit; otherwise a unit or
  // direction word must anchor the query, so "december 2" never becomes
  // "2 days from now".
  const isBareNumber = tokens.length === 1
  if (!isBareNumber && unitFilter === null && directionFilter === null) {
    return []
  }
  const results: DateSuggestion[] = []
  for (const direction of DIRECTIONS) {
    if (directionFilter !== null && direction !== directionFilter) {
      continue
    }
    for (const unit of UNITS) {
      if (unitFilter !== null && unit !== unitFilter) {
        continue
      }
      const date = shiftByUnit(context.today, unit, direction === 'future' ? amount : -amount)
      if (!withinRelativeLimit(date, context.today)) {
        continue
      }
      const plural = amount === 1 ? '' : 's'
      const phrase =
        direction === 'future' ? `${amount} ${unit}${plural} from now` : `${amount} ${unit}${plural} ago`
      results.push({ date, phrase })
    }
  }
  return results
}

// --- Natural-language phrases ("tomorrow", "next friday", "this week") ---

type Modifier = 'this' | 'next' | 'last'
const MODIFIERS: readonly Modifier[] = ['this', 'next', 'last']

// Weekdays in display order (Monday first), paired with their JS `getUTCDay`
// index (Sunday = 0). One table avoids an unchecked name→index lookup.
const WEEKDAYS: readonly { word: string; dow: number }[] = [
  { word: 'monday', dow: 1 },
  { word: 'tuesday', dow: 2 },
  { word: 'wednesday', dow: 3 },
  { word: 'thursday', dow: 4 },
  { word: 'friday', dow: 5 },
  { word: 'saturday', dow: 6 },
  { word: 'sunday', dow: 0 },
]

/** The smallest date on or after `today` whose weekday is `target` (today counts). */
function upcomingWeekday(today: string, target: number): string {
  return addDaysIso(today, (target - weekdayIso(today) + 7) % 7)
}

/** The first day of `today`'s week, honouring the user's week-start preference. */
function firstOfWeek(today: string, weekStartDay: WeekStartDay): string {
  const startDow = weekStartDay === 'sunday' ? 0 : 1
  return addDaysIso(today, -((weekdayIso(today) - startDow + 7) % 7))
}

/** The Saturday of `today`'s week (the same week the week-start preference defines). */
function weekendOf(today: string, weekStartDay: WeekStartDay): string {
  const startDow = weekStartDay === 'sunday' ? 0 : 1
  return addDaysIso(firstOfWeek(today, weekStartDay), (6 - startDow + 7) % 7)
}

function resolveWeekday(today: string, target: number, modifier: Modifier): string {
  const upcoming = upcomingWeekday(today, target)
  if (modifier === 'this') {
    return upcoming
  }
  return addDaysIso(upcoming, modifier === 'next' ? 7 : -7)
}

function resolveFromAnchor(anchor: string, modifier: Modifier, stepDays: number): string {
  if (modifier === 'this') {
    return anchor
  }
  return addDaysIso(anchor, modifier === 'next' ? stepDays : -stepDays)
}

interface NlUnit {
  /** The unit word a single-token query prefix-matches ("monday", "week", "month"). */
  word: string
  /** Capitalised display name for the phrase ("Monday", "Week"). */
  display: string
  /** Sort weight within a modifier: weekdays (0–6) before week/weekend/month. */
  order: number
  resolve: (context: DateSuggestionContext, modifier: Modifier) => string
}

// Built once at module load — the resolvers take all runtime state as arguments.
const NL_UNITS: readonly NlUnit[] = [
  ...WEEKDAYS.map(
    ({ word, dow }, index): NlUnit => ({
      word,
      display: titleCase(word),
      order: index,
      resolve: (context, modifier) => resolveWeekday(context.today, dow, modifier),
    }),
  ),
  {
    word: 'week',
    display: 'Week',
    order: 7,
    resolve: (context, modifier) =>
      resolveFromAnchor(firstOfWeek(context.today, context.weekStartDay), modifier, 7),
  },
  {
    word: 'weekend',
    display: 'Weekend',
    order: 8,
    resolve: (context, modifier) =>
      resolveFromAnchor(weekendOf(context.today, context.weekStartDay), modifier, 7),
  },
  {
    word: 'month',
    display: 'Month',
    order: 9,
    resolve: (context, modifier) => {
      const [year, month] = context.today.split('-').map(Number) as [number, number]
      const first = isoFromParts(year, month, 1)
      return modifier === 'this' ? first : addMonthsIso(first, modifier === 'next' ? 1 : -1)
    },
  },
]

interface NlCandidate {
  phrase: string
  date: string
  modifier: Modifier | null
  unitWord: string
  sort: number
}

/**
 * Does the query match this phrase? A one-token query prefix-matches the unit
 * word (`mon` → *…Monday*, `yest` → *Yesterday*); a two-token query matches the
 * modifier then the unit (`next fri` → *Next Friday*).
 */
function phraseMatches(tokens: readonly string[], modifier: Modifier | null, unitWord: string): boolean {
  const [first, second] = tokens
  if (tokens.length === 1 && first !== undefined) {
    return unitWord.startsWith(first)
  }
  if (tokens.length === 2 && first !== undefined && second !== undefined) {
    return modifier !== null && modifier.startsWith(first) && unitWord.startsWith(second)
  }
  return false
}

function naturalLanguageSuggestions(
  query: string,
  tokens: readonly string[],
  context: DateSuggestionContext,
): DateSuggestion[] {
  if (query.length < MIN_PHRASE_CHARS) {
    return []
  }
  const candidates: NlCandidate[] = [
    { phrase: 'Today', date: context.today, modifier: null, unitWord: 'today', sort: 0 },
    { phrase: 'Yesterday', date: addDaysIso(context.today, -1), modifier: null, unitWord: 'yesterday', sort: 1 },
    { phrase: 'Tomorrow', date: addDaysIso(context.today, 1), modifier: null, unitWord: 'tomorrow', sort: 2 },
  ]
  MODIFIERS.forEach((modifier, modifierIndex) => {
    for (const unit of NL_UNITS) {
      candidates.push({
        phrase: `${titleCase(modifier)} ${unit.display}`,
        date: unit.resolve(context, modifier),
        modifier,
        unitWord: unit.word,
        // Sort by unit first (so `mon` yields the three Mondays before Months),
        // then modifier (this < next < last). Offset keeps standalone words first.
        sort: 10 + unit.order * MODIFIERS.length + modifierIndex,
      })
    }
  })
  return candidates
    .filter((candidate) => phraseMatches(tokens, candidate.modifier, candidate.unitWord))
    .sort((left, right) => left.sort - right.sort)
    .map((candidate) => ({ date: candidate.date, phrase: candidate.phrase }))
}

// --- Typed calendar dates ("2026-06-19", "12/25", "23/2/2023") ---

function typedDateSuggestions(
  lower: string,
  rawQuery: string,
  context: DateSuggestionContext,
): DateSuggestion[] {
  if (ISO_DATE_RE.test(lower)) {
    return isCalendarDate(lower) ? [{ date: lower, phrase: null }] : []
  }
  if (!lower.includes('/')) {
    return []
  }
  const parts = lower.split('/').map((part) => part.trim())
  if (parts.length < 2 || parts.length > 3 || !parts.every((part) => /^\d+$/.test(part))) {
    return []
  }
  const [firstPart, secondPart, yearPart] = parts
  if (firstPart === undefined || secondPart === undefined) {
    return []
  }
  // An explicit year must be four digits — "12/25/23" must resolve to nothing,
  // not the year 23. We don't guess a century for a two-digit year.
  if (yearPart !== undefined && yearPart.length !== 4) {
    return []
  }
  const first = Number(firstPart)
  const second = Number(secondPart)
  const year = yearPart !== undefined ? Number(yearPart) : Number(context.today.slice(0, 4))
  // The preferred reading follows the date-format setting; ISO display has no
  // slash-date order, so it keeps the default M/D reading. The swapped reading
  // is offered only for bare shorthand, where "12/10" is genuinely ambiguous.
  const readings =
    context.dateFormat === 'dmy'
      ? [
          { day: first, month: second },
          { day: second, month: first },
        ]
      : [
          { month: first, day: second },
          { month: second, day: first },
        ]
  const allowSwap = yearPart === undefined
  const seen = new Set<string>()
  const results: DateSuggestion[] = []
  readings.forEach((reading, index) => {
    if (index === 1 && !allowSwap) {
      return
    }
    if (reading.month < 1 || reading.month > 12) {
      return
    }
    const iso = isoFromParts(year, reading.month, reading.day)
    if (!isCalendarDate(iso) || seen.has(iso)) {
      return
    }
    seen.add(iso)
    results.push({ date: iso, phrase: rawQuery })
  })
  return results
}

// --- Month-name dates ("December 2nd", "2 Dec", "Mar 3 2024") ---

const MONTH_ABBREVIATIONS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
}
const MONTH_NAMES: readonly string[] = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

function matchMonth(token: string): number | null {
  if (token.length < 3) {
    return null
  }
  const abbreviation = MONTH_ABBREVIATIONS[token]
  if (abbreviation !== undefined) {
    return abbreviation
  }
  const index = MONTH_NAMES.findIndex((name) => name.startsWith(token))
  return index === -1 ? null : index + 1
}

function matchDay(token: string): number | null {
  const match = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(token)
  if (match === null) {
    return null
  }
  const day = Number(match[1])
  return day >= 1 && day <= 31 ? day : null
}

function monthNameSuggestions(
  query: string,
  tokens: readonly string[],
  rawQuery: string,
  context: DateSuggestionContext,
): DateSuggestion[] {
  if (query.length < MIN_PHRASE_CHARS) {
    return []
  }
  let month: number | null = null
  let day: number | null = null
  let year: number | null = null
  for (const token of tokens) {
    const matchedMonth = matchMonth(token)
    if (month === null && matchedMonth !== null) {
      month = matchedMonth
      continue
    }
    if (year === null && /^\d{4}$/.test(token)) {
      year = Number(token)
      continue
    }
    const matchedDay = matchDay(token)
    if (day === null && matchedDay !== null) {
      day = matchedDay
    }
  }
  if (month === null || day === null) {
    return []
  }
  const iso = isoFromParts(year ?? Number(context.today.slice(0, 4)), month, day)
  return isCalendarDate(iso) ? [{ date: iso, phrase: rawQuery }] : []
}

/**
 * Synthesise up to {@link MAX_RESULTS} daily-note targets from `query`, merging
 * the four interpretations and keeping one entry per resolved day (the most
 * specific phrasing wins). Returns `[]` for an empty query or one no
 * interpretation recognises.
 */
export function generateDateSuggestions(query: string, context: DateSuggestionContext): DateSuggestion[] {
  const trimmed = query.trim()
  if (trimmed === '') {
    return []
  }
  const lower = trimmed.toLowerCase()
  const tokens = lower.split(/\s+/).filter(Boolean)

  const collected: DateSuggestion[] = [
    ...typedDateSuggestions(lower, trimmed, context),
    ...monthNameSuggestions(lower, tokens, trimmed, context),
    ...relativeSuggestions(tokens, context),
    ...naturalLanguageSuggestions(lower, tokens, context),
  ]

  const seen = new Set<string>()
  const result: DateSuggestion[] = []
  for (const suggestion of collected) {
    if (seen.has(suggestion.date)) {
      continue
    }
    seen.add(suggestion.date)
    result.push(suggestion)
    if (result.length >= MAX_RESULTS) {
      break
    }
  }
  return result
}
