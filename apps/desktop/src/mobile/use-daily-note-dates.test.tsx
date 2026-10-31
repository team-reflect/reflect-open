import { act } from '@/test-utils/act.ts'
import { describe, expect, it, vi } from 'vitest'
import { createTestCoreServices } from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useDailyNoteDates } from './use-daily-note-dates.ts'

describe('useDailyNoteDates', () => {
  it('keeps previous markers while a new range loads', async () => {
    const pendingNextRange = Promise.withResolvers<string[]>()
    const core = createTestCoreServices({ database: createWasmTestDatabaseService() })
    const dailyDatesInRange = vi
      .spyOn(core.dailyNotes, 'dailyDatesInRange')
      .mockResolvedValueOnce(['2026-07-14'])
      .mockImplementationOnce(() => pendingNextRange.promise)
    const hook = await renderHookInApp(
      (
        { start, end }: { start: string; end: string } = {
          start: '2026-01-12',
          end: '2027-01-17',
        },
      ) => useDailyNoteDates(start, end),
      {
        core,
        graph: { root: '/g' },
        initialProps: { start: '2026-01-12', end: '2027-01-17' },
      },
    )

    await vi.waitFor(() => expect(hook.result.current.has('2026-07-14')).toBe(true))

    await hook.rerender({ start: '2026-06-29', end: '2027-07-04' })
    await vi.waitFor(() => expect(dailyDatesInRange).toHaveBeenCalledTimes(2))
    expect(hook.result.current.has('2026-07-14')).toBe(true)

    await act(() => pendingNextRange.resolve(['2027-01-05']))
    await vi.waitFor(() => expect(hook.result.current.has('2027-01-05')).toBe(true))
    expect(hook.result.current.has('2026-07-14')).toBe(false)
  })
})
