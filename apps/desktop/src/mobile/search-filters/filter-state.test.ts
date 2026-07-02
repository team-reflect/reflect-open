import { describe, expect, it } from 'vitest'
import {
  EMPTY_ALL_NOTES_FILTERS,
  buildAllNotesSearch,
  hasActiveFilters,
  pendingTagToken,
  searchPlanFor,
  updatedPresetFilter,
  updatedRangeFilter,
  type AllNotesFilters,
} from './filter-state'

function filtersWith(overrides: Partial<AllNotesFilters>): AllNotesFilters {
  return { ...EMPTY_ALL_NOTES_FILTERS, ...overrides }
}

describe('pendingTagToken', () => {
  it('captures a trailing half-typed tag and the query before it', () => {
    expect(pendingTagToken('meeting #bo')).toEqual({ rest: 'meeting', partial: 'bo' })
  })

  it('treats a bare trailing # as an empty partial (list every tag)', () => {
    expect(pendingTagToken('#')).toEqual({ rest: '', partial: '' })
  })

  it('ignores completed tags followed by more text', () => {
    expect(pendingTagToken('#book meeting')).toBeNull()
  })

  it('ignores queries without a trailing tag token', () => {
    expect(pendingTagToken('meeting notes')).toBeNull()
    expect(pendingTagToken('')).toBeNull()
  })
})

describe('buildAllNotesSearch', () => {
  it('passes a plain query through untouched', () => {
    const parsed = buildAllNotesSearch('meeting notes', EMPTY_ALL_NOTES_FILTERS, null)
    expect(parsed.text).toBe('meeting notes')
    expect(parsed.filtered).toBe(false)
    expect(parsed.filters.tags).toEqual([])
  })

  it('holds a trailing half-typed tag out of the search text', () => {
    const parsed = buildAllNotesSearch('meeting #bo', EMPTY_ALL_NOTES_FILTERS, null)
    expect(parsed.text).toBe('meeting')
    expect(parsed.filters.tags).toEqual([])
  })

  it('merges badge filters into the parsed dimensions', () => {
    const filters = filtersWith({
      pinned: true,
      daily: true,
      tags: ['book'],
      linkedTo: { path: 'notes/project.md', title: 'Project X' },
      linkedBy: { path: 'notes/hub.md', title: 'Hub' },
      updated: { label: 'Today', afterMs: 1000, beforeMs: null },
    })

    const parsed = buildAllNotesSearch('quarterly', filters, null)

    expect(parsed.text).toBe('quarterly')
    expect(parsed.filtered).toBe(true)
    expect(parsed.filters).toEqual({
      tags: ['book'],
      dailyOnly: true,
      pinnedOnly: true,
      linksTo: null,
      linksToPath: 'notes/project.md',
      linkedFrom: null,
      linkedFromPath: 'notes/hub.md',
      updatedAfterMs: 1000,
      updatedBeforeMs: null,
    })
  })

  it('targets link badges by picked path, so a duplicated title cannot retarget them', () => {
    const filters = filtersWith({ linkedTo: { path: 'notes/alpha-2.md', title: 'Alpha' } })
    const parsed = buildAllNotesSearch('', filters, null)
    expect(parsed.filters.linksTo).toBeNull()
    expect(parsed.filters.linksToPath).toBe('notes/alpha-2.md')
  })

  it('folds the route tag in without duplicating a typed #tag', () => {
    const parsed = buildAllNotesSearch('#book meeting', EMPTY_ALL_NOTES_FILTERS, 'Book')
    expect(parsed.filters.tags).toEqual(['book'])
    expect(parsed.filtered).toBe(true)
  })

  it('lets typed single-value tokens win over badge values', () => {
    const filters = filtersWith({ linkedTo: { path: 'notes/a.md', title: 'A' } })
    const parsed = buildAllNotesSearch('links:B', filters, null)
    expect(parsed.filters.linksTo).toBe('B')
    expect(parsed.filters.linksToPath).toBeNull()
  })

  it('intersects typed and badge date bounds (AND semantics)', () => {
    const filters = filtersWith({ updated: { label: 'x', afterMs: 500, beforeMs: 2000 } })
    const parsed = buildAllNotesSearch('updated:>2026-01-05', filters, null)
    const typedAfter = new Date(2026, 0, 5).getTime()
    expect(parsed.filters.updatedAfterMs).toBe(Math.max(typedAfter, 500))
    expect(parsed.filters.updatedBeforeMs).toBe(2000)
  })
})

describe('searchPlanFor', () => {
  it('caps ranked free-text searches', () => {
    const plan = searchPlanFor(buildAllNotesSearch('meeting', EMPTY_ALL_NOTES_FILTERS, null))
    expect(plan).toEqual({ limit: 50 })
  })

  it('runs no-text queries as the list itself: uncapped, notes-only, pinned first', () => {
    const plan = searchPlanFor(buildAllNotesSearch('', EMPTY_ALL_NOTES_FILTERS, null))
    expect(plan).toEqual({ limit: null, pinnedFirst: true, notesOnly: true })
  })

  it('treats a badge-only query as a list, not a search', () => {
    const filters = filtersWith({ pinned: true })
    const plan = searchPlanFor(buildAllNotesSearch('', filters, null))
    expect(plan).toEqual({ limit: null, pinnedFirst: true, notesOnly: true })
  })

  it('treats a pending #tag token as no text (it is a suggestion, not a search)', () => {
    const plan = searchPlanFor(buildAllNotesSearch('#boo', EMPTY_ALL_NOTES_FILTERS, null))
    expect(plan).toEqual({ limit: null, pinnedFirst: true, notesOnly: true })
  })
})

describe('hasActiveFilters', () => {
  it('is false for the empty set and true for any single badge', () => {
    expect(hasActiveFilters(EMPTY_ALL_NOTES_FILTERS)).toBe(false)
    expect(hasActiveFilters(filtersWith({ pinned: true }))).toBe(true)
    expect(hasActiveFilters(filtersWith({ tags: ['book'] }))).toBe(true)
    expect(hasActiveFilters(filtersWith({ updated: updatedPresetFilter('today') }))).toBe(true)
  })
})

describe('updatedPresetFilter', () => {
  it('resolves presets to local day starts relative to now', () => {
    const now = new Date(2026, 5, 15, 14, 30)
    expect(updatedPresetFilter('today', now)).toEqual({
      label: 'Today',
      afterMs: new Date(2026, 5, 15).getTime(),
      beforeMs: null,
    })
    expect(updatedPresetFilter('week', now).afterMs).toBe(new Date(2026, 5, 9).getTime())
    expect(updatedPresetFilter('month', now).afterMs).toBe(new Date(2026, 4, 17).getTime())
  })
})

describe('updatedRangeFilter', () => {
  it('returns null when both sides are empty', () => {
    expect(updatedRangeFilter('', '')).toBeNull()
  })

  it('makes the end date inclusive by bounding at the next day start', () => {
    const filter = updatedRangeFilter('2026-06-01', '2026-06-15')
    expect(filter).toEqual({
      label: 'Jun 1 – Jun 15',
      afterMs: new Date(2026, 5, 1).getTime(),
      beforeMs: new Date(2026, 5, 16).getTime(),
    })
  })

  it('labels one-sided ranges', () => {
    expect(updatedRangeFilter('2026-06-01', '')?.label).toBe('Since Jun 1')
    expect(updatedRangeFilter('', '2026-06-15')?.label).toBe('Until Jun 15')
  })
})
