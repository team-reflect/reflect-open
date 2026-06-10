import { describe, expect, it } from 'vitest'
import { dailySidebarDate } from './sidebar-route'

const TODAY = '2026-06-09'

describe('dailySidebarDate', () => {
  it('follows the live clock on the today route', () => {
    expect(dailySidebarDate({ kind: 'today' }, TODAY)).toBe(TODAY)
  })

  it('uses the route date on valid daily routes', () => {
    expect(dailySidebarDate({ kind: 'daily', date: '2026-06-01' }, TODAY)).toBe('2026-06-01')
  })

  it('anchors malformed daily dates to today, matching the stream', () => {
    expect(dailySidebarDate({ kind: 'daily', date: '2026-02-31' }, TODAY)).toBe(TODAY)
    expect(dailySidebarDate({ kind: 'daily', date: 'not-a-date' }, TODAY)).toBe(TODAY)
  })

  it('shows no daily sidebar on note, search, and settings routes', () => {
    expect(dailySidebarDate({ kind: 'note', path: 'notes/a.md' }, TODAY)).toBeNull()
    expect(dailySidebarDate({ kind: 'search', query: 'rust' }, TODAY)).toBeNull()
    expect(dailySidebarDate({ kind: 'settings' }, TODAY)).toBeNull()
  })
})
