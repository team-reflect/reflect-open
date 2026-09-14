import { afterEach, expect, it, vi } from 'vitest'
import { resolveArchivedPost } from '@reflect/core/x-archive'
import { XPostHost } from './use-x-post-resolver'

vi.mock('@reflect/core/x-archive', () => ({ resolveArchivedPost: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `reflect-asset://${path}`,
}))
vi.mock('@/providers/graph-provider', () => ({ useOptionalGraph: () => null }))

afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

it('notifies a missing card when its archive first arrives and rewrites media URLs', async () => {
  vi.useFakeTimers()
  const resolve = vi.mocked(resolveArchivedPost)
  resolve.mockResolvedValueOnce(null)
  const host = new XPostHost(7)
  const url = 'https://x.com/jack/status/123'
  const notify = vi.fn()
  const unsubscribe = host.subscribeXPost(url, notify)
  host.start()
  try {
    expect(await host.resolveXPost(url)).toBeUndefined()
    expect(notify).not.toHaveBeenCalled()
    resolve.mockResolvedValue({
      archive: {
        kind: 'x-post',
        id: '123',
        revision: 'one',
        capturedAt: '2026-09-14T00:00:00Z',
        textState: 'complete',
        data: {
          id: '123',
          author: { name: 'Jack', handle: 'jack', avatar: 'https://example.com/avatar.png' },
          body: [{ type: 'text', text: 'Saved tweet' }],
        },
        resources: [{ url: 'https://example.com/avatar.png', state: 'pending' }],
      },
      resources: [
        {
          url: 'https://example.com/avatar.png',
          hash: 'a'.repeat(64),
          state: 'pending',
          error: null,
          bytes: null,
        },
      ],
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(notify).toHaveBeenCalledOnce()
    const post = await host.resolveXPost(url)
    expect(post?.author.avatar).toBe(`reflect-asset://7/x-media/123/${'a'.repeat(64)}`)
    expect(host.resolveXPostMediaUrl(post!.author.avatar!)).toBe(post?.author.avatar)
    await vi.advanceTimersByTimeAsync(2000)
    expect(notify).toHaveBeenCalledOnce()
    unsubscribe()
  } finally {
    host.stop()
  }
})
