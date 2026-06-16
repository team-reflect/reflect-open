import { describe, expect, it } from 'vitest'
import { parseSearchQuery } from './filter-query'

function startOfLocalDay(date: string, days = 0): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year!, month! - 1, day! + days).getTime()
}

describe('parseSearchQuery', () => {
  it('plain text parses to text with no filters', () => {
    const parsed = parseSearchQuery('rust sqlite notes')
    expect(parsed).toEqual({
      text: 'rust sqlite notes',
      filtered: false,
      filters: {
        tags: [],
        dailyOnly: false,
        pinnedOnly: false,
        linksTo: null,
        linkedFrom: null,
        updatedAfterMs: null,
        updatedBeforeMs: null,
      },
    })
  })

  it('extracts tags (lower-cased, repeatable) and keeps surrounding text', () => {
    const parsed = parseSearchQuery('meeting #Work #q2-plans notes')
    expect(parsed.filters.tags).toEqual(['work', 'q2-plans'])
    expect(parsed.text).toBe('meeting notes')
    expect(parsed.filtered).toBe(true)
  })

  it('a bare # is text, not an empty tag', () => {
    const parsed = parseSearchQuery('issue # 42')
    expect(parsed.filters.tags).toEqual([])
    expect(parsed.text).toBe('issue # 42')
  })

  it('# tokens outside the indexed tag grammar stay text', () => {
    // The body grammar requires a leading letter (excludes ##, #123) — a
    // filter for a tag that cannot exist would guarantee zero rows.
    const numeric = parseSearchQuery('#123 issue')
    expect(numeric.filtered).toBe(false)
    expect(numeric.text).toBe('#123 issue')
    const doubled = parseSearchQuery('##work notes')
    expect(doubled.filtered).toBe(false)
    expect(doubled.text).toBe('##work notes')
    // …while grammar-valid forms still filter.
    expect(parseSearchQuery('#q2/plans').filters.tags).toEqual(['q2/plans'])
  })

  it('is:daily flags daily-only (case-insensitive)', () => {
    expect(parseSearchQuery('Is:Daily standup').filters.dailyOnly).toBe(true)
    expect(parseSearchQuery('Is:Daily standup').text).toBe('standup')
  })

  it('is:pinned flags pinned-only (case-insensitive)', () => {
    expect(parseSearchQuery('Is:Pinned roadmap').filters.pinnedOnly).toBe(true)
    expect(parseSearchQuery('Is:Pinned roadmap').text).toBe('roadmap')
  })

  it('an unknown is: value stays text', () => {
    const parsed = parseSearchQuery('is:weekly review')
    expect(parsed.filtered).toBe(false)
    expect(parsed.text).toBe('is:weekly review')
  })

  it('links: and linked-from: take bare and quoted targets', () => {
    expect(parseSearchQuery('links:Roadmap').filters.linksTo).toBe('Roadmap')
    expect(parseSearchQuery('links:"Project X" budget').filters.linksTo).toBe('Project X')
    expect(parseSearchQuery('links:"Project X" budget').text).toBe('budget')
    expect(parseSearchQuery('linked-from:"Q2 Plan"').filters.linkedFrom).toBe('Q2 Plan')
  })

  it('an empty links: value stays text', () => {
    const parsed = parseSearchQuery('links: something')
    expect(parsed.filters.linksTo).toBeNull()
    expect(parsed.text).toBe('links: something')
  })

  it('updated:> is on-or-after, updated:< is before, plain is that day', () => {
    const after = parseSearchQuery('updated:>2026-06-01').filters
    expect(after.updatedAfterMs).toBe(startOfLocalDay('2026-06-01'))
    expect(after.updatedBeforeMs).toBeNull()

    const before = parseSearchQuery('updated:<2026-06-01').filters
    expect(before.updatedBeforeMs).toBe(startOfLocalDay('2026-06-01'))
    expect(before.updatedAfterMs).toBeNull()

    const on = parseSearchQuery('updated:2026-06-01').filters
    expect(on.updatedAfterMs).toBe(startOfLocalDay('2026-06-01'))
    expect(on.updatedBeforeMs).toBe(startOfLocalDay('2026-06-01', 1))
  })

  it('an impossible date is not a filter — typing never hides results early', () => {
    const parsed = parseSearchQuery('updated:>2026-02-31 cleanup')
    expect(parsed.filtered).toBe(false)
    expect(parsed.text).toBe('updated:>2026-02-31 cleanup')
  })

  it('composes mixed tokens and text', () => {
    const parsed = parseSearchQuery('#work is:daily links:"Project X" updated:>2026-01-01 retro')
    expect(parsed.filters).toMatchObject({
      tags: ['work'],
      dailyOnly: true,
      linksTo: 'Project X',
    })
    expect(parsed.filters.updatedAfterMs).toBe(startOfLocalDay('2026-01-01'))
    expect(parsed.text).toBe('retro')
  })

  it('a colon inside ordinary text is untouched', () => {
    expect(parseSearchQuery('re: standup notes').text).toBe('re: standup notes')
  })
})
