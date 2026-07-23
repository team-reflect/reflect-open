import { describe, expect, it, vi } from 'vitest'
import { createBackgroundReconciler } from './background-reconciler'

/** A promise whose resolution the test controls, to hold a pass mid-flight. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** Drain the microtask/macrotask queue so the loop's awaits settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('createBackgroundReconciler', () => {
  it('coalesces triggers landing mid-pass into exactly one follow-up', async () => {
    const gates: Array<{ promise: Promise<void>; resolve: (value: void) => void }> = []
    let calls = 0
    const reconciler = createBackgroundReconciler({
      pass: async () => {
        calls += 1
        const gate = deferred()
        gates.push(gate)
        await gate.promise
      },
    })

    reconciler.schedule()
    await Promise.resolve() // let pass #1 start and park on its gate
    expect(calls).toBe(1)

    reconciler.schedule() // running → queue one follow-up
    reconciler.schedule() // already queued → no extra
    expect(calls).toBe(1)

    gates[0]!.resolve()
    await tick()
    expect(calls).toBe(2) // exactly one follow-up ran

    gates[1]!.resolve()
    await tick()
    expect(calls).toBe(2) // nothing else queued — loop drained
  })

  it('ends the loop on a "stop" result even when a follow-up was queued', async () => {
    const gate = deferred()
    let calls = 0
    const reconciler = createBackgroundReconciler({
      pass: async () => {
        calls += 1
        await gate.promise
        return 'stop'
      },
    })

    reconciler.schedule()
    await Promise.resolve()
    reconciler.schedule() // queued, but the pass returns 'stop'
    gate.resolve()
    await tick()

    expect(calls).toBe(1)
  })

  it('exposes the dispose state to the pass via isStale', async () => {
    const gate = deferred()
    let seenAtStart: boolean | null = null
    let seenAfterDispose: boolean | null = null
    const reconciler = createBackgroundReconciler({
      pass: async (isStale) => {
        seenAtStart = isStale()
        await gate.promise
        seenAfterDispose = isStale()
      },
    })

    expect(reconciler.isStale()).toBe(false)
    reconciler.schedule()
    await Promise.resolve()
    expect(seenAtStart).toBe(false)

    reconciler.dispose()
    expect(reconciler.isStale()).toBe(true)
    gate.resolve()
    await tick()
    expect(seenAfterDispose).toBe(true)
  })

  it('runs onSettled after the loop drains', async () => {
    const onSettled = vi.fn()
    const reconciler = createBackgroundReconciler({ pass: async () => {}, onSettled })

    reconciler.schedule()
    await tick()

    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('ignores schedule() after dispose', async () => {
    const pass = vi.fn(async () => {})
    const reconciler = createBackgroundReconciler({ pass })

    reconciler.dispose()
    reconciler.schedule()
    await tick()

    expect(pass).not.toHaveBeenCalled()
  })

  it('retries on window focus/online and removes the listeners on dispose', async () => {
    let calls = 0
    const reconciler = createBackgroundReconciler({ pass: async () => { calls += 1 } })
    reconciler.retryOnWake()

    window.dispatchEvent(new Event('focus'))
    await tick()
    expect(calls).toBe(1)

    window.dispatchEvent(new Event('online'))
    await tick()
    expect(calls).toBe(2)

    reconciler.dispose()
    window.dispatchEvent(new Event('focus'))
    await tick()
    expect(calls).toBe(2) // listener removed on dispose
  })


  it('runs onDispose teardowns once, and immediately when already disposed', () => {
    const before = vi.fn()
    const after = vi.fn()
    const reconciler = createBackgroundReconciler({ pass: async () => {} })

    reconciler.onDispose(before)
    reconciler.dispose()
    expect(before).toHaveBeenCalledTimes(1)

    reconciler.onDispose(after) // registered after dispose → runs immediately
    expect(after).toHaveBeenCalledTimes(1)
  })
})
