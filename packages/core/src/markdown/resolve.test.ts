import { describe, expect, it } from 'vitest'
import { normalizeWikiTarget } from './resolve.ts'

describe('normalizeWikiTarget', () => {
  it('trims and case-folds, flagging daily-date targets', () => {
    expect(normalizeWikiTarget('  Project X ')).toEqual({ raw: 'Project X', key: 'project x' })
    expect(normalizeWikiTarget('2024-02-29')).toEqual({
      raw: '2024-02-29',
      key: '2024-02-29',
      date: '2024-02-29', // leap day — calendar-valid
    })
    expect(normalizeWikiTarget('2026-06-09')).toEqual({
      raw: '2026-06-09',
      key: '2026-06-09',
      date: '2026-06-09',
    })
  })

  it('does not flag impossible dates as dailies (shape alone is not enough)', () => {
    // A shape-only match would be suggested as a daily but click-create as a
    // regular note — the calendar check keeps every consumer consistent.
    expect(normalizeWikiTarget('2026-02-31').date).toBeUndefined()
    expect(normalizeWikiTarget('2026-13-01').date).toBeUndefined()
    expect(normalizeWikiTarget('2023-02-29').date).toBeUndefined() // not a leap year
    expect(normalizeWikiTarget('2026-00-10').date).toBeUndefined()
  })
})
