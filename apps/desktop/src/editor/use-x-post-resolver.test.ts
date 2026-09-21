import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { fetchSyndicationPost, type resolveArchivedPost } from '@reflect/core/x-archive'
import { invalidateXPostQueries, queryClient } from '@/lib/query-client'
import { createXPostResolver, getXPostResolver } from './use-x-post-resolver'

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `reflect-asset://${path}`,
}))
vi.mock('@/providers/graph-provider', () => ({ useGraph: () => null }))
vi.mock('@reflect/core/x-archive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core/x-archive')>()),
  fetchSyndicationPost: vi.fn(),
}))
const fetchSyndication = vi.mocked(fetchSyndicationPost)

type ResolvedArchive = Awaited<ReturnType<typeof resolveArchivedPost>>

const resolveArchive = vi.fn<(args: Record<string, unknown>) => ResolvedArchive>()
const writeArchive = vi.fn<(args: Record<string, unknown>) => null>()

beforeEach(() => {
  fetchSyndication.mockResolvedValue(null)
  writeArchive.mockReturnValue(null)
  setBridge({
    invoke: async (command, args) => {
      if (command === 'x_archive_write') return writeArchive(args)
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

it('fetches, saves, and renders a post that has no archive', async () => {
  const saved = archivedPost()
  resolveArchive.mockReturnValueOnce(null).mockReturnValueOnce(saved)
  fetchSyndication.mockResolvedValueOnce(saved.archive.data)

  const post = await createXPostResolver(1)(URL)

  expect(post).toMatchObject({ id: '123' })
  expect(fetchSyndication).toHaveBeenCalledWith('123')
  expect(writeArchive).toHaveBeenCalledWith({
    generation: 1,
    value: expect.objectContaining({
      kind: 'x-post',
      data: expect.objectContaining({ id: '123' }),
    }),
  })
})

it('asks X once for a post that does not exist', async () => {
  resolveArchive.mockReturnValue(null)
  const resolve = createXPostResolver(1)
  await expect(resolve(URL)).resolves.toBeUndefined()
  await expect(resolve(URL)).resolves.toBeUndefined()
  expect(fetchSyndication).toHaveBeenCalledTimes(1)
  expect(resolveArchive).toHaveBeenCalledTimes(2)
  expect(writeArchive).not.toHaveBeenCalled()
})

it('asks X again after a failed request', async () => {
  resolveArchive.mockReturnValue(null)
  fetchSyndication.mockRejectedValueOnce({ kind: 'network', message: 'offline' })
  const resolve = createXPostResolver(1)
  await expect(resolve(URL)).rejects.toMatchObject({ kind: 'network' })
  await resolve(URL)
  expect(fetchSyndication).toHaveBeenCalledTimes(2)
})

it('does not ask X for a post that has an archive', async () => {
  resolveArchive.mockReturnValue(archivedPost())
  await createXPostResolver(1)(URL)
  expect(fetchSyndication).not.toHaveBeenCalled()
})
