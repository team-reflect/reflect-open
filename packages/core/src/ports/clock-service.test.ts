import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestClockService } from '../testing/clock.ts'
import { createSystemClock } from './clock-service.ts'

describe('createSystemClock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads the wall clock', () => {
    vi.setSystemTime(new Date(2026, 5, 9, 12, 0, 0))
    const clock = createSystemClock()
    expect(clock.now()).toBe(new Date(2026, 5, 9, 12, 0, 0).getTime())
  })

  it('reads a monotonic clock', () => {
    const clock = createSystemClock()
    const first = clock.monotonicNow()
    expect(clock.monotonicNow()).toBeGreaterThanOrEqual(first)
  })

  it('runs and clears timeouts', () => {
    const clock = createSystemClock()
    const fired: string[] = []
    clock.setTimeout(() => {
      fired.push('a')
    }, 100)
    const cleared = clock.setTimeout(() => {
      fired.push('b')
    }, 100)
    clock.clearTimeout(cleared)
    vi.advanceTimersByTime(100)
    expect(fired).toEqual(['a'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('runs and clears intervals', () => {
    const clock = createSystemClock()
    let ticks = 0
    const handle = clock.setInterval(() => ticks++, 100)
    vi.advanceTimersByTime(350)
    expect(ticks).toBe(3)
    clock.clearInterval(handle)
    vi.advanceTimersByTime(1000)
    expect(ticks).toBe(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sleeps', async () => {
    const clock = createSystemClock()
    let done = false
    void clock.sleep(500).then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(499)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
  })
})

describe('createTestClockService', () => {
  it('runs due timers in order and moves time with them', async () => {
    const clock = createTestClockService({ now: 1000 })
    const fired: Array<[string, number, number]> = []
    clock.setTimeout(() => {
      fired.push(['b', clock.now(), clock.monotonicNow()])
    }, 200)
    clock.setTimeout(() => {
      fired.push(['a', clock.now(), clock.monotonicNow()])
    }, 100)
    clock.setTimeout(() => {
      fired.push(['c', clock.now(), clock.monotonicNow()])
    }, 200)
    clock.setTimeout(() => {
      fired.push(['late', clock.now(), clock.monotonicNow()])
    }, 500)

    await clock.advance(300)
    expect(fired).toEqual([
      ['a', 1100, 100],
      ['b', 1200, 200],
      ['c', 1200, 200],
    ])
    expect(clock.now()).toBe(1300)
    expect(clock.monotonicNow()).toBe(300)
    expect(clock.pendingTimers()).toBe(1)
  })

  it('repeats intervals and interleaves them with timeouts', async () => {
    const clock = createTestClockService()
    const fired: string[] = []
    const handle = clock.setInterval(() => {
      fired.push(`tick ${clock.now()}`)
    }, 100)
    clock.setTimeout(() => {
      fired.push(`timeout ${clock.now()}`)
    }, 150)

    await clock.advance(300)
    expect(fired).toEqual(['tick 100', 'timeout 150', 'tick 200', 'tick 300'])
    clock.clearInterval(handle)
    expect(clock.pendingTimers()).toBe(0)
  })

  it('runs timers scheduled by a timer within the same advance', async () => {
    const clock = createTestClockService()
    const fired: number[] = []
    clock.setTimeout(() => {
      fired.push(clock.now())
      clock.setTimeout(() => {
        fired.push(clock.now())
      }, 50)
    }, 50)
    await clock.advance(100)
    expect(fired).toEqual([50, 100])
  })

  it('lets awaited code progress between timers', async () => {
    const clock = createTestClockService()
    const steps: number[] = []
    const run = async (): Promise<void> => {
      await clock.sleep(100)
      steps.push(clock.now())
      await Promise.resolve()
      await clock.sleep(100)
      steps.push(clock.now())
    }
    const done = run()
    await clock.advance(200)
    await done
    expect(steps).toEqual([100, 200])
  })

  it('does not run cleared timers', async () => {
    const clock = createTestClockService()
    let fired = false
    const handle = clock.setTimeout(() => {
      fired = true
    }, 10)
    clock.clearTimeout(handle)
    await clock.advance(100)
    expect(fired).toBe(false)
  })

  it('`setNow` moves the wall clock only', () => {
    const clock = createTestClockService({ now: 0 })
    let fired = false
    clock.setTimeout(() => {
      fired = true
    }, 10)
    clock.setNow(5000)
    expect(clock.now()).toBe(5000)
    expect(clock.monotonicNow()).toBe(0)
    expect(fired).toBe(false)
  })
})
