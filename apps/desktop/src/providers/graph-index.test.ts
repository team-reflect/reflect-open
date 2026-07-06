import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@reflect/core', () => ({
  openIndex: vi.fn(),
  syncIndex: vi.fn(),
  subscribeIndexChanges: vi.fn(),
  watchStart: vi.fn(),
  watchStop: vi.fn(),
}))

import {
  openIndex,
  syncIndex,
  subscribeIndexChanges,
  watchStart,
  watchStop,
} from '@reflect/core'
import { createGraphIndex } from './graph-index'

const mockOpen = vi.mocked(openIndex)
// syncIndex (hash reconcile, or a version-bump rebuild — core decides) is the
// one sync entry point the lifecycle calls.
const mockSync = vi.mocked(syncIndex)
const mockSubscribe = vi.mocked(subscribeIndexChanges)
const mockWatchStart = vi.mocked(watchStart)
const mockWatchStop = vi.mocked(watchStop)

beforeEach(() => {
  vi.clearAllMocks()
  mockSync.mockResolvedValue(undefined)
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

  it('close() stops the watcher and does not reconcile', async () => {
    const index = createGraphIndex()
    await index.close()
    expect(mockWatchStop).toHaveBeenCalledTimes(1)
    expect(mockSync).not.toHaveBeenCalled()
  })

  it('sync(generation) reconciles, then subscribes, then starts the watcher', async () => {
    const unlisten = vi.fn()
    mockSubscribe.mockResolvedValue(unlisten)
    const onApplied = vi.fn()
    const onMoved = vi.fn()
    const index = createGraphIndex({ onApplied, onMoved })
    index.sync(5, () => false)
    await index.stop()

    // Both healing paths get the move hook: the reconcile pass and the live
    // subscription — external renames must follow through to sessions/routes.
    expect(mockSync).toHaveBeenCalledWith({
      generation: 5,
      signal: expect.any(AbortSignal),
      onMoved,
    })
    expect(mockSubscribe).toHaveBeenCalledWith(5, onApplied, onMoved)
    // The initial reconcile is itself an index change: invalidate once there.
    expect(onApplied).toHaveBeenCalledTimes(1)
    expect(mockWatchStart).toHaveBeenCalledTimes(1)
    // Sequenced: reconcile → subscribe → watchStart.
    expect(mockSync.mock.invocationCallOrder[0]!).toBeLessThan(
      mockSubscribe.mock.invocationCallOrder[0]!,
    )
    expect(mockSubscribe.mock.invocationCallOrder[0]!).toBeLessThan(
      mockWatchStart.mock.invocationCallOrder[0]!,
    )
    expect(unlisten).not.toHaveBeenCalled() // retained as the active subscription
  })

  it('reports progress: reconciling → live; idle when closed', async () => {
    const onProgress = vi.fn()
    const index = createGraphIndex({ onProgress })
    index.sync(5, () => false)
    await index.stop()
    expect(onProgress.mock.calls.map(([stage]) => stage)).toEqual(['reconciling', 'live'])

    onProgress.mockClear()
    await index.close()
    expect(onProgress).toHaveBeenCalledWith('idle')
  })

  it('reports idle (not live) when the sync pass fails un-superseded', async () => {
    const onProgress = vi.fn()
    mockSync.mockRejectedValue(new Error('boom'))
    const index = createGraphIndex({ onProgress })
    index.sync(5, () => false)
    await index.stop()
    expect(onProgress.mock.calls.map(([stage]) => stage)).toEqual(['reconciling', 'idle'])
  })

  it('bails after reconcile when superseded — no subscribe, no watcher', async () => {
    const index = createGraphIndex()
    index.sync(5, () => true) // stale immediately after reconcile
    await index.stop()
    expect(mockSync).toHaveBeenCalledTimes(1)
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
    mockSync.mockRejectedValue(new Error('reconcile boom'))
    const index = createGraphIndex({ onError })
    index.sync(5, () => false)
    await index.stop()
    expect(onError).toHaveBeenCalledWith('sync', expect.any(Error))
  })

  it('stop() aborts the running reconcile and waits for it to settle', async () => {
    let captured: AbortSignal | undefined
    let settle: () => void = () => {}
    mockSync.mockImplementation((options) => {
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

  it('close() drops an active subscription', async () => {
    const unlisten = vi.fn()
    mockSubscribe.mockResolvedValue(unlisten)
    const index = createGraphIndex()
    index.sync(5, () => false)
    await index.stop()

    await index.close()

    expect(unlisten).toHaveBeenCalledTimes(1)
    expect(mockWatchStop).toHaveBeenCalledTimes(1)
  })

  it('refresh() coalesces stacked triggers into a single queued rerun', async () => {
    // Resume, poll-end, and watch-failed can fire together; each used to
    // abort the in-flight pass and start another — a full pass per trigger.
    const settles: Array<() => void> = []
    mockSync.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settles.push(resolve)
        }),
    )
    const index = createGraphIndex()

    index.refresh(5, () => false)
    await vi.waitFor(() => expect(settles).toHaveLength(1))
    index.refresh(5, () => false)
    index.refresh(5, () => false)
    index.refresh(5, () => false)

    settles[0]!()
    // The three stacked triggers fold into exactly one rerun…
    await vi.waitFor(() => expect(settles).toHaveLength(2))
    settles[1]!()
    // …and nothing further runs once the queue drains.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockSync).toHaveBeenCalledTimes(2)
  })

  it('refresh() bails without a rerun when superseded', async () => {
    const index = createGraphIndex()
    index.refresh(5, () => true) // a newer open owns the lifecycle
    await index.settled()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockSync).not.toHaveBeenCalled()
  })

  it('stops reporting file progress once the pass is superseded', async () => {
    const onFileProgress = vi.fn()
    let stale = false
    mockSync.mockImplementation(async (options) => {
      options.onFileProgress?.(10, 100, 10)
      stale = true
      options.onFileProgress?.(20, 100, 20) // a superseded pass must go quiet
    })
    const index = createGraphIndex({ onFileProgress })
    index.sync(5, () => stale)
    await index.stop()

    expect(onFileProgress).toHaveBeenCalledTimes(1)
    expect(onFileProgress).toHaveBeenCalledWith(10, 100, 10)
  })
})
