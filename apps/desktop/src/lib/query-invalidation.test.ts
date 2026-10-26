import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTestAppServices,
  createTestWindowService,
  type TestWindowService,
} from '@reflect/app/testing'
import {
  createNodeTestDatabaseService,
  createTestCoreServices,
  createTestCaptureService,
  createTestGraphSessionService,
  createTestIndexLifecycleService,
  createTestIndexStoreService,
  type TestCoreServices,
} from '@reflect/core/testing'
import type { XPost } from '@post-embed/types'
import { createXPostResolver, xPostQueryOptions } from '@/editor/use-x-post-resolver.ts'
import { queryClient, queryKeys } from './query-client.ts'
import { installQueryInvalidation } from './query-invalidation.ts'

const app = {
  embedMedia: createTestCoreServices({ database: createNodeTestDatabaseService() }).embedMedia,
}
const url = 'https://x.com/jack/status/123'
const post: XPost = {
  id: '123',
  createdAt: '2026-09-14T00:00:00Z',
  author: { name: 'Jack', handle: 'jack' },
  body: [{ type: 'text', text: 'Saved tweet' }],
}

let services: TestCoreServices | null = null

/**
 * Install over `core` in the window `window`; the test ends with `core`.
 */
function installApp(core: TestCoreServices, window: TestWindowService = createTestWindowService()) {
  services = core
  const stop = installQueryInvalidation(core, createTestAppServices(core, { window }))
  return { core, window, stop }
}

function install(capture: ReturnType<typeof createTestCaptureService>): () => void {
  return installApp(createTestCoreServices({ database: createNodeTestDatabaseService(), capture }))
    .stop
}

function cachePost(): void {
  queryClient.setQueryData(xPostQueryOptions(app.embedMedia, '/graph', '123').queryKey, post)
}

afterEach(() => {
  vi.useRealTimers()
  queryClient.clear()
  services?.database.close()
  services = null
})

describe('installQueryInvalidation', () => {
  it('re-reads cached X posts after a capture pass wrote X posts', async () => {
    cachePost()
    const capture = createTestCaptureService()
    const stop = install(capture)
    const resolveXPost = createXPostResolver(app.embedMedia, '/graph')
    expect(resolveXPost(url)).toBe(post)

    capture.emitXPostsWritten()

    const next = resolveXPost(url)
    expect(next).toBeInstanceOf(Promise)
    await Promise.resolve(next).catch(() => {})
    stop()
  })

  it('keeps cached X posts while no pass reports a write', () => {
    cachePost()
    const stop = install(createTestCaptureService())
    const resolveXPost = createXPostResolver(app.embedMedia, '/graph')

    expect(resolveXPost(url)).toBe(post)
    stop()
  })

  it('stops re-reading once unsubscribed', () => {
    cachePost()
    const capture = createTestCaptureService()
    install(capture)()
    const resolveXPost = createXPostResolver(app.embedMedia, '/graph')

    capture.emitXPostsWritten()

    expect(resolveXPost(url)).toBe(post)
  })
})

describe('installQueryInvalidation for the index and the graph', () => {
  it('invalidates the index queries once a pass commits and after a rebuild', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { core, stop } = installApp(
      createTestCoreServices({ database: createNodeTestDatabaseService() }),
    )
    core.graphSession.setGraph({ indexGeneration: 5 })

    core.indexLifecycle.emitApplied(null, 5)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.index.all })
    invalidate.mockClear()

    await core.indexLifecycle.rebuildVisibly()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.index.all })
    stop()
  })

  it('leaves the index queries alone after a failed rebuild', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const indexLifecycle = createTestIndexLifecycleService({
      indexStore: createTestIndexStoreService({
        fail: (call) => (call.method === 'clear' ? new Error('index on fire') : undefined),
      }),
      graphSession: createTestGraphSessionService({ graph: { indexGeneration: 5 } }),
    })
    const { stop } = installApp(
      createTestCoreServices({ database: createNodeTestDatabaseService(), indexLifecycle }),
    )

    await indexLifecycle.rebuildVisibly()

    expect(invalidate).not.toHaveBeenCalled()
    stop()
  })

  it('refreshes the chat history queries after a saved turn', () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const listeners: Array<() => void> = []
    const core = createTestCoreServices({ database: createNodeTestDatabaseService() })
    vi.spyOn(core.chatSessions, 'onConversationsChanged').mockImplementation((listener) => {
      listeners.push(listener)
      return () => {}
    })
    const { stop } = installApp(core)

    for (const listener of listeners) {
      listener()
    }

    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.chat.all })
    stop()
  })

  it('drops the similar notes on a graph switch and the iCloud listing on a delete', async () => {
    const { core, stop } = installApp(
      createTestCoreServices({ database: createNodeTestDatabaseService() }),
    )
    core.graphSession.setGraph({ root: '/known' })
    queryClient.setQueryData([...queryKeys.similar.all, '/known', 'notes/a.md'], [])
    queryClient.setQueryData(queryKeys.icloud.status, { available: true })

    await core.graphSession.openRecent('/other')
    expect(queryClient.getQueriesData({ queryKey: queryKeys.similar.all })).toEqual([])
    expect(queryClient.getQueryData(queryKeys.icloud.status)).toEqual({ available: true })

    queryClient.setQueryData([...queryKeys.similar.all, '/other', 'notes/a.md'], [])
    await core.graphSession.close()
    expect(queryClient.getQueriesData({ queryKey: queryKeys.similar.all })).toHaveLength(1)

    await core.graphSession.openRecent('/other')
    await core.graphSession.deleteGraph()
    expect(queryClient.getQueryData(queryKeys.icloud.status)).toBeUndefined()
    stop()
  })

  it('drops the archived X posts whenever the graph session ends', async () => {
    const { core, stop } = installApp(
      createTestCoreServices({ database: createNodeTestDatabaseService() }),
    )
    core.graphSession.setGraph({ root: '/known' })
    cachePost()

    await core.graphSession.openRecent('/known')
    expect(queryClient.getQueriesData({ queryKey: queryKeys.xPost.all })).toEqual([])

    cachePost()
    await core.graphSession.close()
    expect(queryClient.getQueriesData({ queryKey: queryKeys.xPost.all })).toEqual([])
    stop()
  })

  it('follows the index writes of the main window in a note window only', () => {
    // The throttle may hold the call until its window ends.
    vi.useFakeTimers()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const main = installApp(createTestCoreServices({ database: createNodeTestDatabaseService() }))
    main.window.emitIndexWritten()
    expect(invalidate).not.toHaveBeenCalled()
    main.stop()
    main.core.database.close()

    const note = installApp(
      createTestCoreServices({ database: createNodeTestDatabaseService(), role: 'note-window' }),
      createTestWindowService({ label: 'note-1' }),
    )
    note.window.emitIndexWritten()
    vi.advanceTimersByTime(3_000)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.index.all })
    note.stop()
  })
})
