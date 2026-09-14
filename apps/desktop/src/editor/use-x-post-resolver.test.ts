import { afterEach, expect, it, vi } from 'vitest'
import { resolveArchivedPost } from '@reflect/core/x-archive'
import { getXPostResolverHost, XPostResolverHost } from './use-x-post-resolver'

vi.mock('@reflect/core/x-archive', () => ({ resolveArchivedPost: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `reflect-asset://${path}`,
}))
vi.mock('@/providers/graph-provider', () => ({ useGraph: () => null }))

afterEach(() => {
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

it('rewrites media URLs while retaining URLs without a local mapping', async () => {
  const result = archivedPost()
  result.archive.data.media = [
    { type: 'photo', url: 'https://pbs.twimg.com/unmapped.png', width: 100, height: 100 },
  ]
  vi.mocked(resolveArchivedPost).mockResolvedValue(result)
  const host = new XPostResolverHost(7)
  const post = await host.resolve('https://x.com/jack/status/123')
  expect(post?.author.avatar).toBe(`reflect-asset://7/x-media/123/${'a'.repeat(64)}`)
  expect(post?.media?.[0]).toEqual({
    type: 'photo',
    url: 'https://pbs.twimg.com/unmapped.png',
    width: 100,
    height: 100,
  })
})

it('does not cache missing or previously read archives', async () => {
  const resolve = vi.mocked(resolveArchivedPost).mockResolvedValueOnce(null)
  const host = new XPostResolverHost(7)
  const url = 'https://x.com/jack/status/123'
  expect(await host.resolve(url)).toBeUndefined()
  resolve.mockResolvedValueOnce(archivedPost())
  expect((await host.resolve(url))?.id).toBe('123')
  resolve.mockResolvedValueOnce(null)
  expect(await host.resolve(url)).toBeUndefined()
  expect(resolve).toHaveBeenCalledTimes(3)
})

it('ignores non-X URLs and a missing graph', async () => {
  expect(await new XPostResolverHost(7).resolve('https://example.com')).toBeUndefined()
  expect(await new XPostResolverHost(null).resolve('https://x.com/jack/status/123')).toBeUndefined()
  expect(resolveArchivedPost).not.toHaveBeenCalled()
})

it('shares pending reads for different URLs of the same post', async () => {
  vi.mocked(resolveArchivedPost).mockResolvedValue(archivedPost())
  const host = new XPostResolverHost(7)
  const first = host.resolve('https://x.com/jack/status/123')
  const second = host.resolve('https://twitter.com/jack/status/123')
  expect(first).toBe(second)
  await first
  expect(resolveArchivedPost).toHaveBeenCalledExactlyOnceWith(7, '123')
})

it('shares a host within a graph and isolates another graph', () => {
  const graph = { root: '/graph', name: 'Graph', generation: 7 }
  expect(getXPostResolverHost(graph)).toBe(getXPostResolverHost(graph))
  expect(getXPostResolverHost({ ...graph, generation: 8 })).not.toBe(getXPostResolverHost(graph))
})
