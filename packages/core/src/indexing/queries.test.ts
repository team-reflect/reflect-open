import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import { dailyDatesInRange } from './queries'

// A fake bridge resolves `db_query` so the test exercises the real compiled
// SQL (snake_case columns, range parameters) — the same harness pipeline.test
// uses for the indexer.
const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()
setBridge({ invoke: mockInvoke, listen: async () => () => {} })

beforeEach(() => {
  mockInvoke.mockReset()
})

describe('dailyDatesInRange', () => {
  it('queries the notes daily_date column with inclusive bounds', async () => {
    mockInvoke.mockResolvedValue([
      { daily_date: '2026-06-01' },
      { daily_date: '2026-06-09' },
    ])

    const dates = await dailyDatesInRange('2026-06-01', '2026-06-30')

    expect(dates).toEqual(['2026-06-01', '2026-06-09'])
    const [command, args] = mockInvoke.mock.calls[0]
    expect(command).toBe('db_query')
    const sql = String(args.sql)
    expect(sql).toContain('daily_date')
    expect(sql).toContain('is not null')
    expect(args.params).toEqual(['2026-06-01', '2026-06-30'])
  })

  it('returns an empty list when no daily notes exist in the range', async () => {
    mockInvoke.mockResolvedValue([])
    await expect(dailyDatesInRange('2025-01-01', '2025-01-31')).resolves.toEqual([])
  })
})
