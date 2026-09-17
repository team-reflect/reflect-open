import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import type { ResolvedArchivedPost } from '@reflect/core/x-archive'
import { createXPostResolver, getXPostResolver, isXPostResolved } from './use-x-post-resolver'

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `reflect-asset://${path}`,
}))
vi.mock('@/providers/graph-provider', () => ({ useGraph: () => null }))

const resolveArchive = vi.fn<(args: Record<string, unknown>) => ResolvedArchivedPost | null>()

beforeEach(() => {
  setBridge({
    invoke: async (command, args) => {
      expect(command).toBe('x_archive_resolve')
      return resolveArchive(args)
    },
    listen: async () => () => {},
  })
})

afterEach(() => {
  setBridge(null)
  vi.resetAllMocks()
})

function archivedPost(): ResolvedArchivedPost {
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

// Archives resolved by one test stay cached, so each test reads its own generation.
it('rewrites media URLs while retaining URLs without a local mapping', async () => {
  const result = archivedPost()
  result.archive.data.media = [
    { type: 'photo', url: 'https://pbs.twimg.com/unmapped.png', width: 100, height: 100 },
  ]
  resolveArchive.mockReturnValue(result)
  const resolveXPost = createXPostResolver(1)
  const post = await resolveXPost('https://x.com/jack/status/123')
  expect(post?.author.avatar).toBe(`reflect-asset://1/x-media/123/${'a'.repeat(64)}`)
  expect(post?.media?.[0]).toEqual({
    type: 'photo',
    url: 'https://pbs.twimg.com/unmapped.png',
    width: 100,
    height: 100,
  })
})

it('reads a missing archive again', async () => {
  resolveArchive.mockReturnValueOnce(null)
  const resolveXPost = createXPostResolver(2)
  const url = 'https://x.com/jack/status/123'
  expect(await resolveXPost(url)).toBeUndefined()
  resolveArchive.mockReturnValueOnce(archivedPost())
  expect((await resolveXPost(url))?.id).toBe('123')
  expect(resolveArchive).toHaveBeenCalledTimes(2)
})

it('returns a resolved archive synchronously to every resolver of the graph', async () => {
  resolveArchive.mockReturnValue(archivedPost())
  const url = 'https://x.com/jack/status/123'
  const post = await createXPostResolver(3)(url)
  expect(post?.id).toBe('123')
  expect(createXPostResolver(3)('https://twitter.com/jack/status/123')).toBe(post)
  expect(resolveArchive).toHaveBeenCalledExactlyOnceWith({ generation: 3, postId: '123' })
})

it('reports which X posts a graph has resolved', async () => {
  resolveArchive.mockReturnValue(archivedPost())
  const graph = { root: '/graph', name: 'Graph', generation: 4 }
  const url = 'https://x.com/jack/status/123'
  expect(isXPostResolved(graph, url)).toBe(false)
  await getXPostResolver(graph)(url)
  expect(isXPostResolved(graph, url)).toBe(true)
  expect(isXPostResolved({ ...graph, generation: 5 }, url)).toBe(false)
  expect(isXPostResolved(null, url)).toBe(false)
  expect(isXPostResolved(graph, 'https://example.com')).toBe(false)
})

it('ignores non-X URLs and a missing graph', async () => {
  expect(await createXPostResolver(6)('https://example.com')).toBeUndefined()
  expect(await createXPostResolver(null)('https://x.com/jack/status/123')).toBeUndefined()
  expect(resolveArchive).not.toHaveBeenCalled()
})

it('shares pending reads for different URLs of the same post', async () => {
  resolveArchive.mockReturnValue(archivedPost())
  const resolveXPost = createXPostResolver(7)
  const first = resolveXPost('https://x.com/jack/status/123')
  const second = resolveXPost('https://twitter.com/jack/status/123')
  expect(first).toBe(second)
  await first
  expect(resolveArchive).toHaveBeenCalledExactlyOnceWith({ generation: 7, postId: '123' })
})

it('shares a resolver within a graph and isolates another graph', () => {
  const graph = { root: '/graph', name: 'Graph', generation: 8 }
  expect(getXPostResolver(graph)).toBe(getXPostResolver(graph))
  expect(getXPostResolver({ ...graph, generation: 9 })).not.toBe(getXPostResolver(graph))
})
