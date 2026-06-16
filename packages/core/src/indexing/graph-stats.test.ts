import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import { loadGraphStats } from './graph-stats'

// A fake bridge resolves `db_query` so the tests exercise the real compiled
// SQL (snake_case columns, parameters) — the same harness note-list.test uses.
const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

beforeEach(() => {
  mockInvoke.mockReset()
  setBridge({ invoke: mockInvoke, listen: async () => () => {} })
})

afterEach(() => {
  setBridge(null)
})

describe('loadGraphStats', () => {
  it('computes counts, daily span, and tag facets — every query private-excluded', async () => {
    mockInvoke
      .mockResolvedValueOnce([{ count: 5 }])
      .mockResolvedValueOnce([{ count: 3, earliest: '2026-01-02', latest: '2026-06-01' }])
      .mockResolvedValueOnce([
        { tag: 'Book', count: 2 },
        { tag: 'health', count: 1 },
      ])

    const stats = await loadGraphStats({ tagLimit: 40 })

    expect(stats).toEqual({
      noteCount: 5,
      dailyNoteCount: 3,
      earliestDailyDate: '2026-01-02',
      latestDailyDate: '2026-06-01',
      tags: [
        { tag: 'Book', count: 2 },
        { tag: 'health', count: 1 },
      ],
      tagsTruncated: false,
    })

    expect(mockInvoke).toHaveBeenCalledTimes(3)
    for (const [command, args] of mockInvoke.mock.calls) {
      expect(command).toBe('db_query')
      // The hard block: every aggregate is computed over public rows only.
      expect(String(args['sql'])).toContain('"is_private" = ?')
      expect(args['params']).toContain(0)
    }

    const [, noteArgs] = mockInvoke.mock.calls[0]!
    expect(String(noteArgs['sql'])).toContain('"daily_date" is null')

    const [, dailyArgs] = mockInvoke.mock.calls[1]!
    const dailySql = String(dailyArgs['sql'])
    expect(dailySql).toContain('"daily_date" is not null')
    expect(dailySql).toContain('min(daily_date)')
    expect(dailySql).toContain('max(daily_date)')

    const [, tagArgs] = mockInvoke.mock.calls[2]!
    const tagSql = String(tagArgs['sql'])
    expect(tagSql).toContain('inner join "notes"')
    expect(tagSql).toContain('group by "tags"."tag_key"')
    expect(tagSql).toContain('order by count(*) desc')
    // One row past the cap, so truncation is detectable.
    expect(tagArgs['params']).toContain(41)
  })

  it('caps the facets at the limit and flags the truncation', async () => {
    mockInvoke
      .mockResolvedValueOnce([{ count: 9 }])
      .mockResolvedValueOnce([{ count: 0, earliest: null, latest: null }])
      .mockResolvedValueOnce([
        { tag: 'a', count: 3 },
        { tag: 'b', count: 2 },
        { tag: 'c', count: 1 },
      ])

    const stats = await loadGraphStats({ tagLimit: 2 })

    expect(stats.tags).toEqual([
      { tag: 'a', count: 3 },
      { tag: 'b', count: 2 },
    ])
    expect(stats.tagsTruncated).toBe(true)
  })

  it('maps an empty graph to zero counts, a null span, and no tags', async () => {
    mockInvoke
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ count: 0, earliest: null, latest: null }])
      .mockResolvedValueOnce([])

    const stats = await loadGraphStats({ tagLimit: 40 })

    expect(stats).toEqual({
      noteCount: 0,
      dailyNoteCount: 0,
      earliestDailyDate: null,
      latestDailyDate: null,
      tags: [],
      tagsTruncated: false,
    })
  })
})
