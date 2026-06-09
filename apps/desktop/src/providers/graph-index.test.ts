import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@reflect/core', () => ({
  openIndex: vi.fn(),
  reconcileIndex: vi.fn(),
  subscribeIndexChanges: vi.fn(),
  watchStart: vi.fn(),
  watchStop: vi.fn(),
}))

import {
  openIndex,
  reconcileIndex,
  subscribeIndexChanges,
  watchStart,
  watchStop,
} from '@reflect/core'
import { createGraphIndex } from './graph-index'

const mockOpen = vi.mocked(openIndex)
const mockReconcile = vi.mocked(reconcileIndex)
const mockSubscribe = vi.mocked(subscribeIndexChanges)
const mockWatchStart = vi.mocked(watchStart)
const mockWatchStop = vi.mocked(watchStop)

beforeEach(() => {
  vi.clearAllMocks()
  mockReconcile.mockResolvedValue(undefined)
  mockSubscribe.mockResolvedValue(() => {})
  mockWatchStart.mockResolvedValue(undefined)
  mockWatchStop.mockResolvedValue(undefined)
})

describe('createGraphIndex', () => {
  it('open() returns the generation from the backend', async () => {
    mockOpen.mockResolvedValue(3)
    expect(await createGraphIndex().open()).toBe(3)
  })

  it('open() returns null and reports failure (editing is never blocked)', async () => {
    const onError = vi.fn()
    mockOpen.mockRejectedValue(new Error('boom'))
    expect(await createGraphIndex({ onError }).open()).toBeNull()
    expect(onError).toHaveBeenCalledWith('open', expect.any(Error))
  })

  it('sync(null) stops the watcher and does not reconcile', async () => {
    const index = createGraphIndex()
    index.sync(null, () => false)
    await index.stop()
    expect(mockWatchStop).toHaveBeenCalledTimes(1)
    expect(mockReconcile).not.toHaveBeenCalled()
  })

  it('sync(generation) reconciles, then subscribes, then starts the watcher', async () => {
    const unlisten = vi.fn()
    mockSubscribe.mockResolvedValue(unlisten)
    const index = createGraphIndex()
    index.sync(5, () => false)
    await index.stop()

    expect(mockReconcile).toHaveBeenCalledWith({ generation: 5, signal: expect.any(AbortSignal) })
    expect(mockSubscribe).toHaveBeenCalledWith(5)
    expect(mockWatchStart).toHaveBeenCalledTimes(1)
    // Sequenced: reconcile → subscribe → watchStart.
    expect(mockReconcile.mock.invocationCallOrder[0]).toBeLessThan(
      mockSubscribe.mock.invocationCallOrder[0],
    )
    expect(mockSubscribe.mock.invocationCallOrder[0]).toBeLessThan(
      mockWatchStart.mock.invocationCallOrder[0],
    )
    expect(unlisten).not.toHaveBeenCalled() // retained as the active subscription
  })

  it('bails after reconcile when superseded — no subscribe, no watcher', async () => {
    const index = createGraphIndex()
    index.sync(5, () => true) // stale immediately after reconcile
    await index.stop()
    expect(mockReconcile).toHaveBeenCalledTimes(1)
    expect(mockSubscribe).not.toHaveBeenCalled()
    expect(mockWatchStart).not.toHaveBeenCalled()
  })

  it('tears down a subscription created after supersession (no listener leak)', async () => {
    const unlisten = vi.fn()
    mockSubscribe.mockResolvedValue(unlisten)
    // Fresh after reconcile (1st check), stale after subscribe (2nd check).
    let checks = 0
    const isStale = () => ++checks >= 2
    const index = createGraphIndex()
    index.sync(5, isStale)
    await index.stop()
    expect(mockSubscribe).toHaveBeenCalledTimes(1)
    expect(mockWatchStart).not.toHaveBeenCalled()
    expect(unlisten).toHaveBeenCalledTimes(1) // pending subscription cleaned up
  })

  it('reports a sync failure but stop() still settles', async () => {
    const onError = vi.fn()
    mockReconcile.mockRejectedValue(new Error('reconcile boom'))
    const index = createGraphIndex({ onError })
    index.sync(5, () => false)
    await index.stop()
    expect(onError).toHaveBeenCalledWith('sync', expect.any(Error))
  })

  it('stop() aborts the running reconcile and waits for it to settle', async () => {
    let captured: AbortSignal | undefined
    let settle: () => void = () => {}
    mockReconcile.mockImplementation((options) => {
      captured = options.signal
      return new Promise<void>((resolve) => {
        settle = resolve
      })
    })

    const index = createGraphIndex()
    index.sync(5, () => false)
    expect(captured).toBeInstanceOf(AbortSignal)
    expect(captured?.aborted).toBe(false)

    const stopped = index.stop()
    expect(captured?.aborted).toBe(true) // aborted synchronously
    settle()
    await stopped
  })

  it('stop() before any sync resolves immediately', async () => {
    await expect(createGraphIndex().stop()).resolves.toBeUndefined()
  })

  it('calling sync() twice without stop() aborts the first pass', () => {
    const signals: AbortSignal[] = []
    mockReconcile.mockImplementation((options) => {
      signals.push(options.signal!)
      return new Promise(() => {}) // never settles
    })

    const index = createGraphIndex()
    index.sync(1, () => false)
    index.sync(2, () => false)

    expect(signals).toHaveLength(2)
    expect(signals[0].aborted).toBe(true) // superseded pass is aborted
    expect(signals[1].aborted).toBe(false) // newest pass stays active
  })
})
