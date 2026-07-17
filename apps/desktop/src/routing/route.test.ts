import { describe, expect, it } from 'vitest'
import { effectiveDailyDate, notePathForRoute, routeForPath, routesEqual } from './route'

describe('routeForPath', () => {
  it('routes real daily paths to the daily view', () => {
    expect(routeForPath('journal/2026-06-09.md')).toEqual({ kind: 'daily', date: '2026-06-09' })
  })

  it('routes regular notes to the note view', () => {
    expect(routeForPath('notes/charlotte.md')).toEqual({ kind: 'note', path: 'notes/charlotte.md' })
  })

  it('routes a daily file with an impossible calendar date as a plain note', () => {
    // dailyPath() would throw on 2026-02-31 — navigation must not crash.
    expect(routeForPath('journal/2026-02-31.md')).toEqual({
      kind: 'note',
      path: 'journal/2026-02-31.md',
    })
  })
})

describe('routesEqual', () => {
  it('compares allNotes routes by their tag filter', () => {
    expect(routesEqual({ kind: 'allNotes', tag: null }, { kind: 'allNotes', tag: null })).toBe(true)
    expect(routesEqual({ kind: 'allNotes', tag: 'book' }, { kind: 'allNotes', tag: 'book' })).toBe(
      true,
    )
    expect(routesEqual({ kind: 'allNotes', tag: 'book' }, { kind: 'allNotes', tag: null })).toBe(
      false,
    )
    expect(routesEqual({ kind: 'allNotes', tag: null }, { kind: 'today' })).toBe(false)
  })

  it('treats singleton screens as equal to themselves', () => {
    expect(routesEqual({ kind: 'chat' }, { kind: 'chat' })).toBe(true)
    expect(routesEqual({ kind: 'chat' }, { kind: 'settings' })).toBe(false)
  })
})

describe('notePathForRoute', () => {
  const TODAY = '2026-06-10'

  it('resolves the file note-scoped commands act on', () => {
    expect(notePathForRoute({ kind: 'note', path: 'notes/a.md' }, TODAY)).toBe('notes/a.md')
    expect(notePathForRoute({ kind: 'daily', date: '2026-06-09' }, TODAY)).toBe(
      'journal/2026-06-09.md',
    )
    expect(notePathForRoute({ kind: 'today' }, TODAY)).toBe('journal/2026-06-10.md')
  })

  it('is null on screens that edit no note', () => {
    expect(notePathForRoute({ kind: 'search', query: 'x' }, TODAY)).toBeNull()
    expect(notePathForRoute({ kind: 'settings' }, TODAY)).toBeNull()
    expect(notePathForRoute({ kind: 'allNotes', tag: null }, TODAY)).toBeNull()
    expect(notePathForRoute({ kind: 'chat' }, TODAY)).toBeNull()
  })
})

describe('effectiveDailyDate', () => {
  const TODAY = '2026-06-10'

  it('prefers the focused stream day on a daily view', () => {
    expect(effectiveDailyDate({ kind: 'today' }, TODAY, '2026-06-01')).toBe('2026-06-01')
    expect(effectiveDailyDate({ kind: 'daily', date: '2026-06-09' }, TODAY, '2026-06-01')).toBe(
      '2026-06-01',
    )
  })

  it('falls back to the route’s own day when nothing is focused', () => {
    expect(effectiveDailyDate({ kind: 'today' }, TODAY, null)).toBe(TODAY)
    expect(effectiveDailyDate({ kind: 'daily', date: '2026-06-09' }, TODAY, null)).toBe('2026-06-09')
  })

  it('is null off the daily views, even with a focused day (focus is irrelevant)', () => {
    expect(effectiveDailyDate({ kind: 'note', path: 'notes/a.md' }, TODAY, '2026-06-01')).toBeNull()
    expect(effectiveDailyDate({ kind: 'search', query: 'x' }, TODAY, '2026-06-01')).toBeNull()
    expect(effectiveDailyDate({ kind: 'settings' }, TODAY, '2026-06-01')).toBeNull()
  })
})
