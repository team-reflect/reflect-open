import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useToday } from './use-today'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useToday', () => {
  it('rolls over when local midnight passes, then keeps rolling', () => {
    vi.setSystemTime(new Date(2026, 5, 9, 23, 59, 0)) // June 9, 23:59 local
    const { result } = renderHook(() => useToday())
    expect(result.current).toBe('2026-06-09')

    act(() => {
      vi.advanceTimersByTime(2 * 60 * 1000) // past midnight (+ the timer pad)
    })
    expect(result.current).toBe('2026-06-10')

    act(() => {
      vi.advanceTimersByTime(24 * 60 * 60 * 1000) // the timer re-armed
    })
    expect(result.current).toBe('2026-06-11')
  })

  it('cleans its timer up on unmount', () => {
    vi.setSystemTime(new Date(2026, 5, 9, 12, 0, 0))
    const { unmount } = renderHook(() => useToday())
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
