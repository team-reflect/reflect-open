import { render } from 'vitest-browser-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePoll } from './use-poll'

/**
 * Visibility is simulated by overriding `document.visibilityState` and
 * dispatching `visibilitychange` (the use-wake-to-today pattern). Timers are
 * real: the polling contract is about ordering (paused while hidden, an
 * immediate tick on return), which short real intervals pin down without
 * fake-timer/microtask interleaving hazards.
 */

let visibility: DocumentVisibilityState = 'visible'

function setVisibility(state: DocumentVisibilityState): void {
  visibility = state
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
  visibility = 'visible'
})

interface HarnessProps {
  enabled: boolean
  intervalMs: number
  tick: () => Promise<'continue' | 'stop'>
}

function Harness({ enabled, intervalMs, tick }: HarnessProps): null {
  usePoll(enabled, intervalMs, tick)
  return null
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('usePoll', () => {
  it('ticks repeatedly at the interval while visible', async () => {
    const tick = vi.fn(async () => 'continue' as const)
    await render(<Harness enabled intervalMs={20} tick={tick} />)
    await vi.waitFor(() => {
      expect(tick.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('pauses while hidden', async () => {
    const tick = vi.fn(async () => 'continue' as const)
    await render(<Harness enabled intervalMs={20} tick={tick} />)
    await vi.waitFor(() => {
      expect(tick).toHaveBeenCalled()
    })

    setVisibility('hidden')
    const paused = tick.mock.calls.length
    await wait(120)
    expect(tick.mock.calls.length).toBe(paused)
  })

  it('resumes with an immediate tick on return to visible', async () => {
    const tick = vi.fn(async () => 'continue' as const)
    // An interval far longer than the test: any tick observed after the
    // visibility flip must be the immediate resume tick, not the schedule.
    await render(<Harness enabled intervalMs={60_000} tick={tick} />)
    setVisibility('hidden')
    await wait(20)
    expect(tick).not.toHaveBeenCalled()

    setVisibility('visible')
    expect(tick).toHaveBeenCalledTimes(1)
  })

  it('a synchronously throwing tick keeps the loop alive', async () => {
    let calls = 0
    const tick = (): Promise<'continue' | 'stop'> => {
      calls += 1
      if (calls === 1) {
        throw new Error('sync boom')
      }
      return Promise.resolve('continue')
    }
    await render(<Harness enabled intervalMs={20} tick={tick} />)
    await vi.waitFor(() => {
      expect(calls).toBeGreaterThanOrEqual(2)
    })
  })

  it("a tick's 'stop' ends the loop for good, across hide and show", async () => {
    const tick = vi.fn(async () => 'stop' as const)
    await render(<Harness enabled intervalMs={20} tick={tick} />)
    await vi.waitFor(() => {
      expect(tick).toHaveBeenCalledTimes(1)
    })

    setVisibility('hidden')
    setVisibility('visible')
    await wait(120)
    expect(tick).toHaveBeenCalledTimes(1)
  })
})
