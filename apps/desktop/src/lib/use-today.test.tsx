import { describe, expect, it } from 'vitest'
import { act } from '@/test-utils/act.ts'
import { createTestCoreServices, createTestClockService } from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { useToday } from './use-today.ts'

describe('useToday', () => {
  it('follows the clock when the local date changes', async () => {
    const clock = createTestClockService({ today: '2026-06-09' })
    const app = createTestCoreServices({ clock })
    const { result, unmount } = await renderHookInApp(() => useToday(), { app })
    expect(result.current).toBe('2026-06-09')

    await act(() => {
      clock.setToday('2026-06-10')
    })
    expect(result.current).toBe('2026-06-10')

    await act(() => {
      clock.setToday('2026-06-11')
    })
    expect(result.current).toBe('2026-06-11')
    await unmount()
  })

  it('rolls over when time advances past local midnight', async () => {
    const clock = createTestClockService({ now: new Date(2026, 5, 9, 23, 59, 0).getTime() })
    const app = createTestCoreServices({ clock })
    const { result, unmount } = await renderHookInApp(() => useToday(), { app })
    expect(result.current).toBe('2026-06-09')

    await act(async () => {
      await clock.advance(2 * 60 * 1000)
    })
    expect(result.current).toBe('2026-06-10')
    await unmount()
  })

  it('mounted hooks share the same date', async () => {
    const clock = createTestClockService({ today: '2026-06-09' })
    const app = createTestCoreServices({ clock })
    const first = await renderHookInApp(() => useToday(), { app })
    const second = await renderHookInApp(() => useToday(), { app })

    await act(() => {
      clock.setToday('2026-06-10')
    })
    expect(first.result.current).toBe('2026-06-10')
    expect(second.result.current).toBe('2026-06-10')
    await first.unmount()
    await second.unmount()
  })
})
