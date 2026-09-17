import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import type { resolveArchivedPost } from '@reflect/core/x-archive'
import { invalidateXPostQueries, queryClient } from '@/lib/query-client'
import { createXPostResolver, getXPostResolver } from './use-x-post-resolver'

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `reflect-asset://${path}`,
}))
vi.mock('@/providers/graph-provider', () => ({ useGraph: () => null }))

type ResolvedArchive = Awaited<ReturnType<typeof resolveArchivedPost>>

const resolveArchive = vi.fn<(args: Record<string, unknown>) => ResolvedArchive>()

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
  queryClient.clear()
  vi.resetAllMocks()
})

function archivedPost(): NonNullable<ResolvedArchive> {
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

const URL = 'https://x.com/jack/status/123'

it('rewrites media URLs while retaining URLs without a local mapping', async () => {
  const result = archivedPost()
  result.archive.data.media = [
    { type: 'photo', url: 'https://pbs.twimg.com/unmapped.png', width: 100, height: 100 },
  ]
  resolveArchive.mockReturnValue(result)
  const post = await createXPostResolver(7)(URL)
  expect(post?.author.avatar).toBe(`reflect-asset://7/x-media/123/${'a'.repeat(64)}`)
  expect(post?.media?.[0]).toEqual({
    type: 'photo',
    url: 'https://pbs.twimg.com/unmapped.png',
    width: 100,
    height: 100,
  })
})

it('returns a loaded archive synchronously to every resolver of the graph', async () => {
  resolveArchive.mockReturnValue(archivedPost())
  const first = createXPostResolver(7)(URL)
  expect(first).toBeInstanceOf(Promise)
  const post = await first
  expect(post?.id).toBe('123')
  expect(createXPostResolver(7)('https://twitter.com/jack/status/123')).toBe(post)
  expect(resolveArchive).toHaveBeenCalledExactlyOnceWith({ generation: 7, postId: '123' })
})

it('reads a missing archive again', async () => {
  resolveArchive.mockReturnValueOnce(null)
  const resolveXPost = createXPostResolver(7)
  expect(await resolveXPost(URL)).toBeUndefined()
  resolveArchive.mockReturnValueOnce(archivedPost())
  expect((await resolveXPost(URL))?.id).toBe('123')
  expect(resolveArchive).toHaveBeenCalledTimes(2)
})

it('reads an archive again after X post queries are invalidated', async () => {
  resolveArchive.mockReturnValue(archivedPost())
  const resolveXPost = createXPostResolver(7)
  await resolveXPost(URL)
  invalidateXPostQueries()
  const next = resolveXPost(URL)
  expect(next).toBeInstanceOf(Promise)
  expect((await next)?.id).toBe('123')
  expect(resolveArchive).toHaveBeenCalledTimes(2)
})

it('keeps archives of different graphs apart', async () => {
  resolveArchive.mockReturnValue(archivedPost())
  await createXPostResolver(7)(URL)
  expect(createXPostResolver(8)(URL)).toBeInstanceOf(Promise)
})

it('ignores non-X URLs and a missing graph', async () => {
  expect(await createXPostResolver(7)('https://example.com')).toBeUndefined()
  expect(await createXPostResolver(null)(URL)).toBeUndefined()
  expect(resolveArchive).not.toHaveBeenCalled()
})

it('shares pending reads for different URLs of the same post', async () => {
  resolveArchive.mockReturnValue(archivedPost())
  const resolveXPost = createXPostResolver(7)
  const first = resolveXPost(URL)
  const second = resolveXPost('https://twitter.com/jack/status/123')
  await first
  await second
  expect(resolveArchive).toHaveBeenCalledExactlyOnceWith({ generation: 7, postId: '123' })
})

it('shares a resolver within a graph and isolates another graph', () => {
  const graph = { root: '/graph', name: 'Graph', generation: 7 }
  expect(getXPostResolver(graph)).toBe(getXPostResolver(graph))
  expect(getXPostResolver({ ...graph, generation: 8 })).not.toBe(getXPostResolver(graph))
})
