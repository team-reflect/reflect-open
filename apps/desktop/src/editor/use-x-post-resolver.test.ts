import { afterEach, expect, it, vi } from 'vitest'
import { resolveArchivedPost } from '@reflect/core/x-archive'
import { getXPostResolver, createXPostResolver } from './use-x-post-resolver'

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
  const resolveXPost = createXPostResolver(7)
  const post = await resolveXPost('https://x.com/jack/status/123')
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
  const resolveXPost = createXPostResolver(7)
  const url = 'https://x.com/jack/status/123'
  expect(await resolveXPost(url)).toBeUndefined()
  resolve.mockResolvedValueOnce(archivedPost())
  expect((await resolveXPost(url))?.id).toBe('123')
  resolve.mockResolvedValueOnce(null)
  expect(await resolveXPost(url)).toBeUndefined()
  expect(resolve).toHaveBeenCalledTimes(3)
})

it('ignores non-X URLs and a missing graph', async () => {
  expect(await createXPostResolver(7)('https://example.com')).toBeUndefined()
  expect(await createXPostResolver(null)('https://x.com/jack/status/123')).toBeUndefined()
  expect(resolveArchivedPost).not.toHaveBeenCalled()
})

it('shares pending reads for different URLs of the same post', async () => {
  vi.mocked(resolveArchivedPost).mockResolvedValue(archivedPost())
  const resolveXPost = createXPostResolver(7)
  const first = resolveXPost('https://x.com/jack/status/123')
  const second = resolveXPost('https://twitter.com/jack/status/123')
  expect(first).toBe(second)
  await first
  expect(resolveArchivedPost).toHaveBeenCalledExactlyOnceWith(7, '123')
})

it('shares a resolver within a graph and isolates another graph', () => {
  const graph = { root: '/graph', name: 'Graph', generation: 7 }
  expect(getXPostResolver(graph)).toBe(getXPostResolver(graph))
  expect(getXPostResolver({ ...graph, generation: 8 })).not.toBe(getXPostResolver(graph))
})
