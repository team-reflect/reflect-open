import { emitFileChanges, setBridge } from '@reflect/core'
import { afterEach, expect, it, vi } from 'vitest'
import { resolveArchivedPost } from '@reflect/core/x-archive'
import { XPostResolverHost } from './use-x-post-resolver'

vi.mock('@reflect/core/x-archive', () => ({ resolveArchivedPost: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `reflect-asset://${path}`,
}))
vi.mock('@/providers/graph-provider', () => ({ useGraph: () => null }))

afterEach(() => {
  setBridge(null)
  vi.resetAllMocks()
})

function archivedPost(): NonNullable<Awaited<ReturnType<typeof resolveArchivedPost>>> {
  return {
    archive: {
      kind: 'x-post',
      capturedAt: '2026-09-14T00:00:00Z',
      data: {
        id: '123',
        createdAt: '2026-09-14T00:00:00Z',
        author: { name: 'Jack', handle: 'jack', avatar: 'https://example.com/avatar.png' },
        body: [{ type: 'text', text: 'Saved tweet' }],
      },
    },
    resources: [
      {
        url: 'https://example.com/avatar.png',
        hash: 'a'.repeat(64),
      },
    ],
  }
}

// FIXME: all three tests here exercise the subscription and go away with it (see the FIXME at the
// top of use-x-post-resolver.ts), together with the
// `subscribeFileChanges`/`subscribeReconcileRequests` mocks added to backlinks-panel.test.tsx and
// incoming-backlinks.test.tsx. What is left to test is `resolve`: rewrites media URLs to
// reflect-asset URLs, returns undefined for a missing archive, and ignores non-X URLs.
it('notifies a missing card when its archive first arrives', async () => {
  setBridge({ invoke: async () => null, listen: async () => () => {} })
  const resolve = vi.mocked(resolveArchivedPost)
  resolve.mockResolvedValueOnce(null)
  const host = new XPostResolverHost(7)
  const url = 'https://x.com/jack/status/123'
  const notify = vi.fn()
  await host.start()
  const unsubscribe = host.subscribe(url, notify)
  try {
    expect(await host.resolve(url)).toBeUndefined()
    expect(notify).not.toHaveBeenCalled()
    resolve.mockResolvedValue(archivedPost())
    emitFileChanges([{ path: 'assets/x/post-123.json', kind: 'upsert' }])
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce())
    expect((await host.resolve(url))?.id).toBe('123')
    const calls = resolve.mock.calls.length
    emitFileChanges([{ path: 'unrelated.md', kind: 'upsert' }])
    expect(resolve).toHaveBeenCalledTimes(calls)
    expect(notify).toHaveBeenCalledOnce()
    unsubscribe()
  } finally {
    host.stop()
  }
})

it('rewrites media URLs and does not refetch when only a media file arrives', async () => {
  setBridge({ invoke: async () => null, listen: async () => () => {} })
  const resolve = vi.mocked(resolveArchivedPost).mockResolvedValue(archivedPost())
  const host = new XPostResolverHost(7)
  const url = 'https://x.com/jack/status/123'
  await host.start()
  host.subscribe(url, vi.fn())
  expect((await host.resolve(url))?.author.avatar).toBe(
    `reflect-asset://7/x-media/123/${'a'.repeat(64)}`,
  )
  const calls = resolve.mock.calls.length
  emitFileChanges([{ path: `assets/x/url_sha256_${'a'.repeat(64)}.png`, kind: 'upsert' }])
  expect(resolve).toHaveBeenCalledTimes(calls)
  host.stop()
  emitFileChanges([{ path: 'assets/x/post-123.json', kind: 'remove' }])
  expect(resolve).toHaveBeenCalledTimes(calls)
})

it('rechecks after listener setup so an archive arriving during setup is not missed', async () => {
  let ready!: () => void
  const waiting = new Promise<void>((resolve) => {
    ready = resolve
  })
  setBridge({
    invoke: async () => null,
    listen: async () => {
      await waiting
      return () => {}
    },
  })
  const resolve = vi.mocked(resolveArchivedPost).mockResolvedValueOnce(null)
  const host = new XPostResolverHost(7)
  const url = 'https://x.com/jack/status/123'
  const notify = vi.fn()
  const started = host.start()
  host.subscribe(url, notify)
  try {
    expect(await host.resolve(url)).toBeUndefined()
    resolve.mockResolvedValue(archivedPost())
    ready()
    await started
    expect(notify).toHaveBeenCalledOnce()
    expect((await host.resolve(url))?.id).toBe('123')
  } finally {
    ready()
    host.stop()
    await started
  }
})
