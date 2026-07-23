import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { useDailyNoteDates } from './use-daily-note-dates'

const dailyDatesInRange = vi.hoisted(() =>
  vi.fn<(start: string, end: string) => Promise<string[]>>(),
)

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  dailyDatesInRange,
  hasBridge: () => true,
}))

vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g' } }),
}))

beforeEach(() => dailyDatesInRange.mockReset())
afterEach(async () => cleanup())

describe('useDailyNoteDates', () => {
  it('keeps previous markers while a new range loads', async () => {
    let resolveNextRange: (dates: string[]) => void = () => {}
    dailyDatesInRange
      .mockResolvedValueOnce(['2026-07-14'])
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNextRange = resolve
          }),
      )
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const hook = await renderHook(
      (
        { start, end }: { start: string; end: string } = {
          start: '2026-01-12',
          end: '2027-01-17',
        },
      ) => useDailyNoteDates(start, end),
      {
        initialProps: { start: '2026-01-12', end: '2027-01-17' },
        wrapper,
      },
    )

    await vi.waitFor(() => expect(hook.result.current.has('2026-07-14')).toBe(true))

    await hook.rerender({ start: '2026-06-29', end: '2027-07-04' })
    await vi.waitFor(() => expect(dailyDatesInRange).toHaveBeenCalledTimes(2))
    expect(hook.result.current.has('2026-07-14')).toBe(true)

    await hook.act(() => resolveNextRange(['2027-01-05']))
    await vi.waitFor(() => expect(hook.result.current.has('2027-01-05')).toBe(true))
    expect(hook.result.current.has('2026-07-14')).toBe(false)
  })
})
