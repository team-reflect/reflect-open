import { describe, expect, it } from 'vitest'
import { generateDateSuggestions, type DateSuggestion } from './date-suggestions'
import type { DateFormat, WeekStartDay } from '../settings/schema'

/**
 * The V1 backlink-menu doc's worked examples are the spec here: today is
 * Wednesday, 1 January 2020, date format day/month (`dmy`) and a Monday week
 * start unless a case says otherwise. See `docs/reflect-v1-backlink-menu.md`.
 */
const TODAY = '2020-01-01'

function gen(
  query: string,
  dateFormat: DateFormat = 'dmy',
  weekStartDay: WeekStartDay = 'monday',
): DateSuggestion[] {
  return generateDateSuggestions(query, { today: TODAY, dateFormat, weekStartDay })
}

describe('generateDateSuggestions', () => {
  it('returns nothing for an empty or too-short query', () => {
    expect(gen('')).toEqual([])
    expect(gen('   ')).toEqual([])
    expect(gen('to')).toEqual([])
  })

  describe('relative offsets', () => {
    it('reads "3 days ago" as a single past-day offset', () => {
      expect(gen('3 days ago')).toEqual([{ date: '2019-12-29', phrase: '3 days ago' }])
    })

    it('treats spelled numbers one–ten as digits', () => {
      expect(gen('three days ago')).toEqual([{ date: '2019-12-29', phrase: '3 days ago' }])
    })

    it('offers future day/week/month for a bare number (top 3)', () => {
      expect(gen('1')).toEqual([
        { date: '2020-01-02', phrase: '1 day from now' },
        { date: '2020-01-08', phrase: '1 week from now' },
        { date: '2020-02-01', phrase: '1 month from now' },
      ])
    })

    it('shows both directions when a unit but no direction is given', () => {
      expect(gen('one day')).toEqual([
        { date: '2020-01-02', phrase: '1 day from now' },
        { date: '2019-12-31', phrase: '1 day ago' },
      ])
    })

    it('prefix-matches relative units as they are typed', () => {
      expect(gen('3 d')).toEqual([
        { date: '2020-01-04', phrase: '3 days from now' },
        { date: '2019-12-29', phrase: '3 days ago' },
      ])
      expect(gen('3 w')).toEqual([
        { date: '2020-01-22', phrase: '3 weeks from now' },
        { date: '2019-12-11', phrase: '3 weeks ago' },
      ])
    })

    it('drops offsets beyond the ~15-year sanity limit', () => {
      expect(gen('17 years')).toEqual([])
      expect(gen('1000 years')).toEqual([])
    })

    it('does not fire on a month-name day number ("December 2")', () => {
      // "2" must not become "2 days from now" — the month-name reading wins.
      expect(gen('December 2')).toEqual([{ date: '2020-12-02', phrase: 'December 2' }])
    })
  })

  describe('natural-language phrases', () => {
    it('resolves today / yesterday / tomorrow', () => {
      expect(gen('today')).toEqual([{ date: '2020-01-01', phrase: 'Today' }])
      expect(gen('yesterday')).toEqual([{ date: '2019-12-31', phrase: 'Yesterday' }])
      expect(gen('tomorrow')).toEqual([{ date: '2020-01-02', phrase: 'Tomorrow' }])
    })

    it('reads "this monday" as the upcoming Monday', () => {
      expect(gen('this monday')).toEqual([{ date: '2020-01-06', phrase: 'This Monday' }])
    })

    it('reads "next fri" as the Friday after the upcoming one', () => {
      expect(gen('next fri')).toEqual([{ date: '2020-01-10', phrase: 'Next Friday' }])
    })

    it('surfaces this/next/last for a bare weekday prefix', () => {
      expect(gen('mon')).toEqual([
        { date: '2020-01-06', phrase: 'This Monday' },
        { date: '2020-01-13', phrase: 'Next Monday' },
        { date: '2019-12-30', phrase: 'Last Monday' },
      ])
    })
  })

  describe('week-start preference', () => {
    // "this week" also prefix-matches "weekend", so the Week row leads and the
    // Weekend row follows — we assert the leading Week row's anchor date.
    it('anchors this/next week to a Monday start', () => {
      expect(gen('this week', 'dmy', 'monday')[0]).toEqual({ date: '2019-12-30', phrase: 'This Week' })
      expect(gen('next week', 'dmy', 'monday')[0]).toEqual({ date: '2020-01-06', phrase: 'Next Week' })
    })

    it('anchors this/next week to a Sunday start when configured', () => {
      expect(gen('this week', 'dmy', 'sunday')[0]).toEqual({ date: '2019-12-29', phrase: 'This Week' })
      expect(gen('next week', 'dmy', 'sunday')[0]).toEqual({ date: '2020-01-05', phrase: 'Next Week' })
    })

    it('leaves weekday phrases unaffected by the week start', () => {
      expect(gen('this monday', 'dmy', 'sunday')).toEqual([{ date: '2020-01-06', phrase: 'This Monday' }])
    })
  })

  describe('typed calendar dates', () => {
    it('parses a full ISO date with no phrase', () => {
      expect(gen('2026-06-19')).toEqual([{ date: '2026-06-19', phrase: null }])
    })

    it('rejects an impossible ISO date', () => {
      expect(gen('2026-02-31')).toEqual([])
    })

    it('offers both readings for ambiguous shorthand (current year for each)', () => {
      // V1 happened to mix years here; V2 defaults shorthand to the current year
      // for both readings, deliberately.
      expect(gen('12/10', 'dmy')).toEqual([
        { date: '2020-10-12', phrase: '12/10' },
        { date: '2020-12-10', phrase: '12/10' },
      ])
    })

    it('reads shorthand per the date-format preference', () => {
      expect(gen('12/25', 'mdy')).toEqual([{ date: '2020-12-25', phrase: '12/25' }])
      expect(gen('12/25', 'dmy')).toEqual([{ date: '2020-12-25', phrase: '12/25' }])
    })

    it('keeps month-day slash shorthand first for ISO display', () => {
      expect(gen('1/2', 'iso')).toEqual([
        { date: '2020-01-02', phrase: '1/2' },
        { date: '2020-02-01', phrase: '1/2' },
      ])
    })

    it('parses a full slash date and offers only the valid reading', () => {
      expect(gen('23/2/2023', 'dmy')).toEqual([{ date: '2023-02-23', phrase: '23/2/2023' }])
    })

    it('ignores a typed date whose explicit year is not four digits', () => {
      // "12/25/23" must not resolve to the year 0023.
      expect(gen('12/25/23', 'mdy')).toEqual([])
      expect(gen('1/2/99', 'dmy')).toEqual([])
    })
  })

  describe('month-name dates', () => {
    it('parses "December 2nd" with the current year', () => {
      expect(gen('December 2nd')).toEqual([{ date: '2020-12-02', phrase: 'December 2nd' }])
    })

    it('accepts either word order and abbreviations', () => {
      expect(gen('2nd December')).toEqual([{ date: '2020-12-02', phrase: '2nd December' }])
      expect(gen('Dec 2')).toEqual([{ date: '2020-12-02', phrase: 'Dec 2' }])
    })

    it('tolerates a malformed ordinal suffix', () => {
      expect(gen('31th December')).toEqual([{ date: '2020-12-31', phrase: '31th December' }])
    })

    it('honours an explicit year', () => {
      expect(gen('March 3 2024')).toEqual([{ date: '2024-03-03', phrase: 'March 3 2024' }])
    })

    it('needs both a month and a day', () => {
      expect(gen('December')).toEqual([])
    })
  })
})
