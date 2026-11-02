import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestClockService } from '../testing/clock.ts'
import { createTodayService } from './today-service.ts'

describe('createTodayService', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the current date while nothing is subscribed', () => {
    const clock = createTestClockService({ now: new Date(2026, 5, 9, 12, 0, 0).getTime() })
    const today = createTodayService({ clock })
    expect(today.get()).toBe('2026-06-09')
    expect(today.get()).toBe(today.get())

    clock.setNow(new Date(2026, 5, 10, 12, 0, 0).getTime())
    expect(today.get()).toBe('2026-06-10')
  })

  it('rolls over at local midnight, then keeps rolling', async () => {
    const clock = createTestClockService({ now: new Date(2026, 5, 9, 23, 59, 0).getTime() })
    const today = createTodayService({ clock })
    const seen: string[] = []
    const unsubscribe = today.subscribe(() => {
      seen.push(today.get())
    })

    await clock.advance(2 * 60 * 1000)
    expect(today.get()).toBe('2026-06-10')
    await clock.advance(24 * 60 * 60 * 1000)
    expect(today.get()).toBe('2026-06-11')
    expect(seen).toEqual(['2026-06-10', '2026-06-11'])
    unsubscribe()
  })

  it('the heartbeat catches a slept-through midnight', async () => {
    const clock = createTestClockService({ now: new Date(2026, 5, 9, 23, 59, 0).getTime() })
    const today = createTodayService({ clock })
    const seen: string[] = []
    const unsubscribe = today.subscribe(() => {
      seen.push(today.get())
    })

    clock.setNow(new Date(2026, 5, 10, 9, 0, 0).getTime())
    expect(seen).toEqual([])
    await clock.advance(60_000)
    expect(seen).toEqual(['2026-06-10'])
    unsubscribe()
  })

  it('re-reads the date on `visibilitychange`', () => {
    const target = new EventTarget()
    vi.stubGlobal('document', target)
    const clock = createTestClockService({ now: new Date(2026, 5, 9, 23, 59, 0).getTime() })
    const today = createTodayService({ clock })
    const seen: string[] = []
    const unsubscribe = today.subscribe(() => {
      seen.push(today.get())
    })

    clock.setNow(new Date(2026, 5, 10, 9, 0, 0).getTime())
    target.dispatchEvent(new Event('visibilitychange'))
    expect(seen).toEqual(['2026-06-10'])

    unsubscribe()
    clock.setNow(new Date(2026, 5, 11, 9, 0, 0).getTime())
    target.dispatchEvent(new Event('visibilitychange'))
    expect(seen).toEqual(['2026-06-10'])
  })

  it('does not notify while the date stays the same', async () => {
    const clock = createTestClockService({ now: new Date(2026, 5, 9, 12, 0, 0).getTime() })
    const today = createTodayService({ clock })
    const listener = vi.fn()
    const unsubscribe = today.subscribe(listener)
    await clock.advance(5 * 60 * 1000)
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('subscribers share one timer set, released by the last unsubscribe', () => {
    const clock = createTestClockService({ now: new Date(2026, 5, 9, 12, 0, 0).getTime() })
    const today = createTodayService({ clock })
    const first = today.subscribe(() => {})
    const second = today.subscribe(() => {})
    expect(clock.pendingTimers()).toBe(2)
    first()
    expect(clock.pendingTimers()).toBe(2)
    second()
    second()
    expect(clock.pendingTimers()).toBe(0)
  })
})
