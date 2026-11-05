import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { AppError } from '@reflect/core'
import { createTestClockService, type TestClockService } from '@reflect/core/testing'
import { createTestLifecycleService, type TestLifecycleService } from '../testing/lifecycle.ts'
import { pollUntil } from './poll-until.ts'

const POLL_MS = 3000

let clock: TestClockService
let lifecycle: TestLifecycleService
let controller: AbortController

beforeEach(() => {
  clock = createTestClockService()
  lifecycle = createTestLifecycleService()
  controller = new AbortController()
})

/**
 * Let every promise chain that is already runnable settle.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Move the clock by `ms`, running the timers that come due, then settle.
 */
async function advance(ms: number): Promise<void> {
  await clock.advance(ms)
  await flush()
}

/**
 * Poll a check that answers with each of `results` in turn; the last one repeats.
 */
function poll(...results: Array<string | Error>): {
  check: Mock<() => Promise<string>>
  promise: Promise<string>
} {
  let call = 0
  const check = vi.fn(() => {
    const result = results[Math.min(call, results.length - 1)] ?? 'done'
    call += 1
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
  })
  const promise = pollUntil(check, (value) => value === 'done', {
    intervalMs: POLL_MS,
    clock,
    lifecycle,
    signal: controller.signal,
  })
  return { check, promise }
}

describe('pollUntil', () => {
  it('checks once per interval, starting one interval from now, until done', async () => {
    const { check, promise } = poll('wait', 'done')

    await advance(POLL_MS - 1)
    expect(check).not.toHaveBeenCalled()
    await advance(1)
    expect(check).toHaveBeenCalledTimes(1)

    await advance(POLL_MS)
    expect(check).toHaveBeenCalledTimes(2)
    await expect(promise).resolves.toBe('done')
    expect(clock.pendingTimers()).toBe(0)
  })

  it('never overlaps checks: the next wait starts when the check settles', async () => {
    const gate = Promise.withResolvers<string>()
    const check = vi.fn(() => {
      return check.mock.calls.length === 1 ? gate.promise : Promise.resolve('done')
    })
    const promise = pollUntil(check, (value) => value === 'done', {
      intervalMs: POLL_MS,
      clock,
      lifecycle,
      signal: controller.signal,
    })

    await advance(POLL_MS)
    await advance(POLL_MS * 3)
    expect(check).toHaveBeenCalledTimes(1)

    gate.resolve('wait')
    await flush()
    await advance(POLL_MS)
    expect(check).toHaveBeenCalledTimes(2)
    await expect(promise).resolves.toBe('done')
  })

  it('a failing check keeps polling', async () => {
    const { check, promise } = poll(new AppError('network', 'offline'), 'done')

    await advance(POLL_MS)
    await advance(POLL_MS)
    expect(check).toHaveBeenCalledTimes(2)
    await expect(promise).resolves.toBe('done')
  })

  it('pauses while hidden and resumes with an immediate check on return', async () => {
    const { check, promise } = poll('wait')

    lifecycle.emitHidden()
    await advance(POLL_MS * 3)
    expect(check).not.toHaveBeenCalled()

    lifecycle.emitVisible()
    await flush()
    expect(check).toHaveBeenCalledTimes(1)
    controller.abort()
    await expect(promise).rejects.toThrow()
  })

  it('does not start a wait while hidden', async () => {
    lifecycle.setHidden(true)
    const { check, promise } = poll('wait')
    await flush()
    expect(clock.pendingTimers()).toBe(0)

    lifecycle.emitVisible()
    await flush()
    expect(check).toHaveBeenCalledTimes(1)
    controller.abort()
    await expect(promise).rejects.toThrow()
  })

  it('abort rejects and stops polling, even with a check in flight', async () => {
    const gate = Promise.withResolvers<string>()
    const check = vi.fn(() => gate.promise)
    const promise = pollUntil(check, (value) => value === 'done', {
      intervalMs: POLL_MS,
      clock,
      lifecycle,
      signal: controller.signal,
    })
    await advance(POLL_MS)
    expect(check).toHaveBeenCalledTimes(1)

    controller.abort()
    gate.resolve('done')
    await expect(promise).rejects.toThrow()

    lifecycle.emitHidden()
    lifecycle.emitVisible()
    await advance(POLL_MS * 2)
    expect(check).toHaveBeenCalledTimes(1)
    expect(clock.pendingTimers()).toBe(0)
  })
})
