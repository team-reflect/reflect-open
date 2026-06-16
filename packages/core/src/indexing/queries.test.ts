import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import {
  dailyDatesInRange,
  getDuplicateNoteIds,
  getNoteIdsByPath,
  getPinnedNotes,
  listDailyNotes,
} from './queries'

// A fake bridge resolves `db_query` so the test exercises the real compiled
// SQL (snake_case columns, range parameters) — the same harness pipeline.test
// uses for the indexer.
const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

beforeEach(() => {
  mockInvoke.mockReset()
  setBridge({ invoke: mockInvoke, listen: async () => () => {} })
})

afterEach(() => {
  setBridge(null)
})

describe('dailyDatesInRange', () => {
  it('queries the notes daily_date column with inclusive bounds', async () => {
    mockInvoke.mockResolvedValue([
      { daily_date: '2026-06-01' },
      { daily_date: '2026-06-09' },
    ])

    const dates = await dailyDatesInRange('2026-06-01', '2026-06-30')

    expect(dates).toEqual(['2026-06-01', '2026-06-09'])
    const [command, args] = mockInvoke.mock.calls[0]!
    expect(command).toBe('db_query')
    const sql = String(args['sql'])
    expect(sql).toContain('daily_date')
    expect(sql).toContain('is not null')
    expect(args['params']).toEqual(['2026-06-01', '2026-06-30'])
  })

  it('returns an empty list when no daily notes exist in the range', async () => {
    mockInvoke.mockResolvedValue([])
    await expect(dailyDatesInRange('2025-01-01', '2025-01-31')).resolves.toEqual([])
  })
})

describe('listDailyNotes', () => {
  it('selects public dailies in the inclusive range, most recent first, capped', async () => {
    mockInvoke.mockResolvedValue([
      {
        path: 'daily/2026-06-09.md',
        title: '2026-06-09',
        daily_date: '2026-06-09',
        preview: 'Stand-up notes.',
        mtime: 2000,
        is_private: 0,
      },
    ])

    const rows = await listDailyNotes({ start: '2026-06-01', end: '2026-06-30', limit: 32 })

    expect(rows).toEqual([
      {
        path: 'daily/2026-06-09.md',
        title: '2026-06-09',
        dailyDate: '2026-06-09',
        preview: 'Stand-up notes.',
        mtime: 2000,
        isPrivate: false,
      },
    ])
    const [command, args] = mockInvoke.mock.calls[0]!
    expect(command).toBe('db_query')
    const sql = String(args['sql'])
    expect(sql).toContain('daily_date')
    expect(sql).toContain('is not null')
    expect(sql).toContain('"is_private"')
    expect(sql).toContain('order by "daily_date" desc')
    expect(sql).toContain('limit')
    expect(args['params']).toEqual(['2026-06-01', '2026-06-30', 0, 32])
  })

  it('returns an empty list when no daily notes exist in the range', async () => {
    mockInvoke.mockResolvedValue([])
    await expect(
      listDailyNotes({ start: '2025-01-01', end: '2025-01-31', limit: 32 }),
    ).resolves.toEqual([])
  })
})

describe('getPinnedNotes', () => {
  it('selects pinned rows: explicit orders first, then folded title', async () => {
    mockInvoke.mockResolvedValue([
      { path: 'notes/a.md', title: 'Alpha', daily_date: null },
      { path: 'notes/b.md', title: 'Beta', daily_date: null },
    ])

    const pinned = await getPinnedNotes()

    expect(pinned).toEqual([
      { path: 'notes/a.md', title: 'Alpha', dailyDate: null },
      { path: 'notes/b.md', title: 'Beta', dailyDate: null },
    ])
    const [command, args] = mockInvoke.mock.calls[0]!
    expect(command).toBe('db_query')
    const sql = String(args['sql'])
    expect(sql).toContain('is_pinned')
    // Ordered pins lead (NULL orders sort last), alphabetical within.
    expect(sql).toContain('order by pinned_order IS NULL')
    expect(sql).toContain('"pinned_order"')
    expect(sql).toContain('title_key')
    expect(args['params']).toEqual([1])
  })
})

describe('getDuplicateNoteIds', () => {
  it('returns empty without a second query when no id is duplicated', async () => {
    mockInvoke.mockResolvedValue([])

    await expect(getDuplicateNoteIds()).resolves.toEqual([])

    expect(mockInvoke).toHaveBeenCalledTimes(1)
    const [command, args] = mockInvoke.mock.calls[0]!
    expect(command).toBe('db_query')
    const sql = String(args['sql'])
    expect(sql).toContain('group by')
    expect(sql).toContain('count(*)')
    expect(sql).toContain('is not null')
  })

  it('groups every path claiming a duplicated id, ordered', async () => {
    mockInvoke
      .mockResolvedValueOnce([{ id: 'dup-1' }])
      .mockResolvedValueOnce([
        { id: 'dup-1', path: 'notes/a.md' },
        { id: 'dup-1', path: 'notes/b.md' },
      ])

    await expect(getDuplicateNoteIds()).resolves.toEqual([
      { id: 'dup-1', paths: ['notes/a.md', 'notes/b.md'] },
    ])
    const [, args] = mockInvoke.mock.calls[1]!
    expect(args['params']).toEqual(['dup-1'])
  })
})

describe('getNoteIdsByPath', () => {
  it('asks nothing for no paths', async () => {
    await expect(getNoteIdsByPath([])).resolves.toEqual(new Map())
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('chunks the IN clause under SQLite variable limits and merges the results', async () => {
    // A mass external move can orphan thousands of paths in one reconcile —
    // a single statement would blow the bound-variable budget.
    const paths = Array.from({ length: 1200 }, (_, index) => `notes/${index}.md`)
    mockInvoke.mockImplementation(async (_command, args) => {
      const params = args['params'] as string[]
      return [{ path: params[0], id: `id-${params[0]}` }]
    })

    const ids = await getNoteIdsByPath(paths)

    expect(mockInvoke).toHaveBeenCalledTimes(3) // 500 + 500 + 200
    for (const [, args] of mockInvoke.mock.calls) {
      expect((args['params'] as string[]).length).toBeLessThanOrEqual(500)
    }
    expect(ids.get('notes/0.md')).toBe('id-notes/0.md')
    expect(ids.get('notes/500.md')).toBe('id-notes/500.md')
    expect(ids.get('notes/1000.md')).toBe('id-notes/1000.md')
  })
})
