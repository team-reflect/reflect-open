import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mutationKeys,
  queryClient,
  queryKeys,
  throttledInvalidateIndexQueries,
} from './query-client'

const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

/** Grows per test: the throttle keeps module-level state, so each case must
 * start well past the previous one's window to begin on a cold leading edge. */
let clockOffsetMs = 0

beforeEach(() => {
  vi.useFakeTimers()
  clockOffsetMs += 120_000
  vi.setSystemTime(Date.now() + clockOffsetMs)
  invalidateSpy.mockClear()
  invalidateSpy.mockResolvedValue(undefined)
})

afterEach(() => {
  // Drain any armed trailing edge so it can't leak into the next test.
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
})

describe('throttledInvalidateIndexQueries', () => {
  it('fires the first call immediately — a single save keeps its instant refresh', () => {
    throttledInvalidateIndexQueries()
    expect(invalidateSpy).toHaveBeenCalledTimes(1)
  })

  it('collapses a burst into one trailing refetch, none dropped', () => {
    // The initial-sync shape: an applied watch batch every ~2s for minutes.
    throttledInvalidateIndexQueries() // leading
    throttledInvalidateIndexQueries()
    throttledInvalidateIndexQueries()
    throttledInvalidateIndexQueries()
    expect(invalidateSpy).toHaveBeenCalledTimes(1)

    // The trailing edge runs once the window elapses — the last batch's
    // rows are never left stale.
    vi.advanceTimersByTime(3_000)
    expect(invalidateSpy).toHaveBeenCalledTimes(2)

    // Quiet afterwards: nothing further scheduled.
    vi.advanceTimersByTime(10_000)
    expect(invalidateSpy).toHaveBeenCalledTimes(2)
  })

  it('spaces sustained streams to one refetch per window', () => {
    for (let tick = 0; tick < 12; tick += 1) {
      throttledInvalidateIndexQueries()
      vi.advanceTimersByTime(1_000) // a batch per second for 12s
    }
    // Leading + one trailing per 3s window: ~4 rounds, not 12.
    expect(invalidateSpy.mock.calls.length).toBeLessThanOrEqual(5)
    expect(invalidateSpy.mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  it('an isolated call after a quiet period fires immediately again', () => {
    throttledInvalidateIndexQueries()
    vi.advanceTimersByTime(10_000)
    invalidateSpy.mockClear()

    throttledInvalidateIndexQueries()
    expect(invalidateSpy).toHaveBeenCalledTimes(1)
  })
})

describe('query defaults', () => {
  it('keeps external sources stale and disables browser network pausing', () => {
    const defaults = queryClient.defaultQueryOptions({ queryKey: queryKeys.calendar.all })

    expect(defaults).toMatchObject({
      staleTime: 0,
      retry: 1,
      refetchOnWindowFocus: false,
      networkMode: 'always',
    })
  })

  it.each([
    queryKeys.index.note('/graph', 'notes/example.md'),
    queryKeys.chat.conversations('/graph'),
    queryKeys.settings.current,
  ])('keeps explicitly invalidated data fresh for %j', (queryKey) => {
    expect(queryClient.defaultQueryOptions({ queryKey }).staleTime).toBe(Infinity)
  })

  it('does not apply projection freshness to similar notes', () => {
    expect(
      queryClient.defaultQueryOptions({ queryKey: queryKeys.similar.note('/graph', 'note.md') })
        .staleTime,
    ).toBe(0)
  })

  it('runs mutations while the browser reports offline', () => {
    expect(queryClient.getDefaultOptions().mutations?.networkMode).toBe('always')
  })
})

describe('queryKeys', () => {
  it('builds prefixes that match exact graph resources', () => {
    const prefix = queryKeys.index.allNotesPrefix('/graph')
    const exact = queryKeys.index.allNotes('/graph', 'books')

    expect(exact.slice(0, prefix.length)).toEqual(prefix)
  })

  it('isolates graphs and parameters deterministically', () => {
    expect(queryKeys.index.dailyDates('/one', '2026-08-01', '2026-08-31')).toEqual(
      queryKeys.index.dailyDates('/one', '2026-08-01', '2026-08-31'),
    )
    expect(queryKeys.index.dailyDates('/one', '2026-08-01', '2026-08-31')).not.toEqual(
      queryKeys.index.dailyDates('/two', '2026-08-01', '2026-08-31'),
    )
  })

  it('uses one conflicted-notes identity on every surface', () => {
    expect(queryKeys.index.conflictedNotes('/graph')).toEqual([
      'index',
      '/graph',
      'conflicted-notes',
    ])
  })
})

describe('mutationKeys', () => {
  it('isolates task actions and graphs', () => {
    expect(mutationKeys.tasks.complete('/one')).not.toEqual(mutationKeys.tasks.reopen('/one'))
    expect(mutationKeys.tasks.complete('/one')).not.toEqual(mutationKeys.tasks.complete('/two'))
  })
})
