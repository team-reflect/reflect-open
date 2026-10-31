import { getIsoDateFromParts, getYear } from '@reflect/utils'
import type { DateSuggestion, DateSuggestionContext } from './date-suggestion-types.ts'

const MIN_PHRASE_CHARS = 3

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

export function monthNameSuggestions(
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
  const iso = getIsoDateFromParts(year ?? getYear(context.today), month, day)
  return iso === null ? [] : [{ date: iso, phrase: rawQuery }]
}
