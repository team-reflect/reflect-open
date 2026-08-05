import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { renderHook } from 'vitest-browser-react'
import { useToday } from './use-today'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

// The backing today store is a module singleton whose timers run only while
// subscribed, so every test unmounts its hooks: a leaked subscription would
// keep the store started and later tests would read its stale date.
describe('useToday', () => {
  it('rolls over when local midnight passes, then keeps rolling', async () => {
    vi.setSystemTime(new Date(2026, 5, 9, 23, 59, 0)) // June 9, 23:59 local
    const { result, unmount } = await renderHook(() => useToday())
    expect(result.current).toBe('2026-06-09')

    act(() => {
      vi.advanceTimersByTime(2 * 60 * 1000) // past midnight (+ the timer pad)
    })
    expect(result.current).toBe('2026-06-10')

    act(() => {
      vi.advanceTimersByTime(24 * 60 * 60 * 1000) // the timer re-armed
    })
    expect(result.current).toBe('2026-06-11')
    await unmount()
  })

  it('cleans its timers up on unmount', async () => {
    vi.setSystemTime(new Date(2026, 5, 9, 12, 0, 0))
    const { unmount } = await renderHook(() => useToday())
    await unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resyncs on visibilitychange after sleeping across midnight', async () => {
    vi.setSystemTime(new Date(2026, 5, 9, 23, 59, 0))
    const { result, unmount } = await renderHook(() => useToday())
    expect(result.current).toBe('2026-06-09')

    // Simulated sleep: the wall clock jumps but no timer fires (DOM timers
    // run on a monotonic clock that pauses while the machine sleeps).
    vi.setSystemTime(new Date(2026, 5, 10, 9, 0, 0))
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(result.current).toBe('2026-06-10')
    await unmount()
  })

  it('the heartbeat catches a slept-through midnight with no wake signal', async () => {
    vi.setSystemTime(new Date(2026, 5, 9, 23, 59, 0))
    const { result, unmount } = await renderHook(() => useToday())

    vi.setSystemTime(new Date(2026, 5, 10, 9, 0, 0))
    act(() => {
      vi.advanceTimersByTime(60_000) // one heartbeat tick, no wake event at all
    })
    expect(result.current).toBe('2026-06-10')
    await unmount()
  })

  it('mounted hooks share one timer set', async () => {
    vi.setSystemTime(new Date(2026, 5, 9, 12, 0, 0))
    const first = await renderHook(() => useToday())
    const second = await renderHook(() => useToday())
    expect(vi.getTimerCount()).toBe(2) // one midnight timeout + one heartbeat
    await first.unmount()
    expect(vi.getTimerCount()).toBe(2) // still one subscriber left
    await second.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
