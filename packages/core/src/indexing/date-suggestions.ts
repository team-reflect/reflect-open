/**
 * Date-suggestion generator for the `[[` autocomplete and the command palette:
 * synthesises daily-note targets from a fuzzy query the way the original Reflect
 * did. It interprets the query four ways at once — relative offsets
 * ("3 days ago"), natural-language dates ("next friday", "tomorrow"), typed
 * calendar dates ("12/25", "2026-06-19"), and month-name dates ("December 2nd")
 * — then merges them, de-duplicating by resolved day. See
 * `docs/reflect-v1-backlink-menu.md` for the behaviour this ports.
 *
 * Pure and dependency-free: the clock is injected as `today` (an ISO
 * `YYYY-MM-DD` *local* date, computed at the UI edge) and every offset is
 * computed in UTC on the ISO string, so DST can never skip or repeat a day.
 * Each result is an ISO `YYYY-MM-DD` — the canonical daily-note form — paired
 * with the human `phrase` to show in the menu (`null` for a bare ISO query,
 * which needs no friendlier label than the date itself).
 */

import { isCalendarDate } from '../markdown/resolve'
import type { DateFormat } from '../settings/schema'

/** One synthesised daily-note target: the resolved day plus its menu label. */
export interface DateSuggestion {
  /** Resolved daily-note date, ISO `YYYY-MM-DD`. */
  date: string
  /** Human label for the menu ("3 days ago", "Next Friday"); `null` for a bare ISO query. */
  phrase: string | null
}

/** What the generator needs from its caller: the local clock and the slash-date order. */
export interface DateSuggestionContext {
  /** Today's local calendar date, ISO `YYYY-MM-DD`. */
  today: string
  /** Reading order for ambiguous typed slash-dates (`mdy` → M/D, `dmy` → D/M). */
  dateFormat: DateFormat
}

/** At most this many date suggestions survive into the menu. */
const MAX_RESULTS = 3
/** Relative offsets beyond this many years from today are treated as nonsense. */
const MAX_RELATIVE_YEARS = 15
/** Natural-language phrases need at least this many typed characters to appear. */
const MIN_PHRASE_CHARS = 3

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// --- UTC date arithmetic (no date-fns in core; UTC sidesteps DST entirely) ---

function parseUtc(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

function toIso(date: Date): string {
  return fromParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

function fromParts(year: number, month: number, day: number): string {
  const pad = (value: number, width: number): string => String(value).padStart(width, '0')
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
}

function addDays(iso: string, days: number): string {
  const date = parseUtc(iso)
  date.setUTCDate(date.getUTCDate() + days)
  return toIso(date)
}

/** Add months with end-of-month clamping (date-fns semantics): Jan 31 + 1mo → Feb 28. */
function addMonths(iso: string, months: number): string {
  const [year, month, day] = iso.split('-').map(Number)
  const zeroBased = month - 1 + months
  const targetYear = year + Math.floor(zeroBased / 12)
  const targetMonth = ((zeroBased % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  return fromParts(targetYear, targetMonth + 1, Math.min(day, lastDay))
}

/** Day of week for an ISO date: 0 = Sunday … 6 = Saturday. */
function weekday(iso: string): number {
  return parseUtc(iso).getUTCDay()
}

/** Is `iso` within {@link MAX_RELATIVE_YEARS} of `today`? ISO strings sort chronologically. */
function withinRelativeLimit(iso: string, today: string): boolean {
  return iso >= addMonths(today, -12 * MAX_RELATIVE_YEARS) && iso <= addMonths(today, 12 * MAX_RELATIVE_YEARS)
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

const UNIT_WORDS: Record<string, Unit> = {
  day: 'day',
  days: 'day',
  week: 'week',
  weeks: 'week',
  month: 'month',
  months: 'month',
  year: 'year',
  years: 'year',
}

function extractNumber(tokens: readonly string[]): number | null {
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      return Number(token)
    }
    if (token in SPELLED_NUMBERS) {
      return SPELLED_NUMBERS[token]
    }
  }
  return null
}

function extractUnit(tokens: readonly string[]): Unit | null {
  for (const token of tokens) {
    if (token in UNIT_WORDS) {
      return UNIT_WORDS[token]
    }
  }
  return null
}

function extractDirection(tokens: readonly string[]): Direction | null {
  const hasPast = tokens.includes('ago')
  const hasFuture = tokens.some(
    (token) => token === 'from' || token === 'now' || token === 'later' || token === 'in' || token === 'hence',
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
      return addDays(today, amount)
    case 'week':
      return addDays(today, amount * 7)
    case 'month':
      return addMonths(today, amount)
    case 'year':
      return addMonths(today, amount * 12)
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

const WEEKDAY_ORDER: readonly string[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]
const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
}

/** The smallest date on or after `today` whose weekday is `target` (today counts). */
function upcomingWeekday(today: string, target: number): string {
  return addDays(today, (target - weekday(today) + 7) % 7)
}

/** Monday of `today`'s week — a fixed Monday start, independent of any week-start preference. */
function mondayOfWeek(today: string): string {
  return addDays(today, -((weekday(today) + 6) % 7))
}

function resolveWeekday(today: string, target: number, modifier: Modifier): string {
  const upcoming = upcomingWeekday(today, target)
  if (modifier === 'this') {
    return upcoming
  }
  return addDays(upcoming, modifier === 'next' ? 7 : -7)
}

function resolveFromAnchor(anchor: string, modifier: Modifier, stepDays: number): string {
  if (modifier === 'this') {
    return anchor
  }
  return addDays(anchor, modifier === 'next' ? stepDays : -stepDays)
}

interface NlUnit {
  /** The unit word a single-token query prefix-matches ("monday", "week", "month"). */
  word: string
  /** Capitalised display name for the phrase ("Monday", "Week"). */
  display: string
  /** Sort weight within a modifier: weekdays (0–6) before week/weekend/month. */
  order: number
  resolve: (today: string, modifier: Modifier) => string
}

function nlUnits(): NlUnit[] {
  const weekdays: NlUnit[] = WEEKDAY_ORDER.map((name, index) => ({
    word: name,
    display: titleCase(name),
    order: index,
    resolve: (today, modifier) => resolveWeekday(today, WEEKDAY_INDEX[name], modifier),
  }))
  return [
    ...weekdays,
    {
      word: 'week',
      display: 'Week',
      order: 7,
      resolve: (today, modifier) => resolveFromAnchor(mondayOfWeek(today), modifier, 7),
    },
    {
      word: 'weekend',
      display: 'Weekend',
      order: 8,
      resolve: (today, modifier) => resolveFromAnchor(addDays(mondayOfWeek(today), 5), modifier, 7),
    },
    {
      word: 'month',
      display: 'Month',
      order: 9,
      resolve: (today, modifier) => {
        const [year, month] = today.split('-').map(Number)
        const first = fromParts(year, month, 1)
        return modifier === 'this' ? first : addMonths(first, modifier === 'next' ? 1 : -1)
      },
    },
  ]
}

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
  if (tokens.length === 1) {
    return unitWord.startsWith(tokens[0])
  }
  if (tokens.length === 2) {
    return modifier !== null && modifier.startsWith(tokens[0]) && unitWord.startsWith(tokens[1])
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
    { phrase: 'Yesterday', date: addDays(context.today, -1), modifier: null, unitWord: 'yesterday', sort: 1 },
    { phrase: 'Tomorrow', date: addDays(context.today, 1), modifier: null, unitWord: 'tomorrow', sort: 2 },
  ]
  const units = nlUnits()
  MODIFIERS.forEach((modifier, modifierIndex) => {
    for (const unit of units) {
      candidates.push({
        phrase: `${titleCase(modifier)} ${unit.display}`,
        date: unit.resolve(context.today, modifier),
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
  echo: string,
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
  const [first, second] = parts.map(Number)
  const year = parts.length === 3 ? Number(parts[2]) : Number(context.today.slice(0, 4))
  // The preferred reading follows the date-format setting; the swapped reading
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
  const allowSwap = parts.length === 2
  const seen = new Set<string>()
  const results: DateSuggestion[] = []
  readings.forEach((reading, index) => {
    if (index === 1 && !allowSwap) {
      return
    }
    if (reading.month < 1 || reading.month > 12) {
      return
    }
    const iso = fromParts(year, reading.month, reading.day)
    if (!isCalendarDate(iso) || seen.has(iso)) {
      return
    }
    seen.add(iso)
    results.push({ date: iso, phrase: echo })
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
  if (token in MONTH_ABBREVIATIONS) {
    return MONTH_ABBREVIATIONS[token]
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
  echo: string,
  context: DateSuggestionContext,
): DateSuggestion[] {
  if (query.length < MIN_PHRASE_CHARS) {
    return []
  }
  let month: number | null = null
  let day: number | null = null
  let year: number | null = null
  for (const token of tokens) {
    if (month === null && matchMonth(token) !== null) {
      month = matchMonth(token)
      continue
    }
    if (year === null && /^\d{4}$/.test(token)) {
      year = Number(token)
      continue
    }
    if (day === null && matchDay(token) !== null) {
      day = matchDay(token)
    }
  }
  if (month === null || day === null) {
    return []
  }
  const iso = fromParts(year ?? Number(context.today.slice(0, 4)), month, day)
  return isCalendarDate(iso) ? [{ date: iso, phrase: echo }] : []
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
