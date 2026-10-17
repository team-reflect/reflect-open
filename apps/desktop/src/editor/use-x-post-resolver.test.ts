import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { EmbedMediaService, ResolvedArchivedPost } from '@reflect/core'
import { AppError } from '@reflect/core'
import {
  createTestCoreServices,
  createTestPlatformService,
  createTestXArchiveService,
  type TestCoreServices,
  type TestXArchiveService,
} from '@reflect/core/testing'
import { invalidateXPostQueries, queryClient } from '@/lib/query-client.ts'
import { createXPostResolver, getXPostResolver } from './use-x-post-resolver.ts'

const platform = createTestPlatformService()
const ROOT = '/graph'
let xArchive: TestXArchiveService
let app: TestCoreServices
let ctx: EmbedMediaService

beforeEach(() => {
  xArchive = createTestXArchiveService()
  app = createTestCoreServices({ xArchive, platform })
  app.graphSession.setGraph({ root: ROOT, generation: 7 })
  ctx = app.embedMedia
})

afterEach(() => {
  queryClient.clear()
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

const URL = 'https://x.com/jack/status/123'

it('rewrites media URLs while retaining URLs without a local mapping', async () => {
  const result = archivedPost()
  result.archive.data.media = [
    { type: 'photo', url: 'https://pbs.twimg.com/unmapped.png', width: 100, height: 100 },
  ]
  xArchive.setPost('123', result)
  const post = await createXPostResolver(ctx, ROOT)(URL)
  expect(post?.author.avatar).toBe(
    platform.convertFileSrc(`7/x-media/123/${'a'.repeat(64)}`, 'reflect-asset'),
  )
  expect(post?.media?.[0]).toEqual({
    type: 'photo',
    url: 'https://pbs.twimg.com/unmapped.png',
    width: 100,
    height: 100,
  })
})

it('returns a loaded archive synchronously to every resolver of the graph', async () => {
  xArchive.setPost('123', archivedPost())
  const first = createXPostResolver(ctx, ROOT)(URL)
  expect(first).toBeInstanceOf(Promise)
  const post = await first
  expect(post?.id).toBe('123')
  expect(createXPostResolver(ctx, ROOT)('https://twitter.com/jack/status/123')).toBe(post)
  expect(xArchive.resolves()).toEqual([{ generation: 7, postId: '123' }])
})

it('reads a missing archive again', async () => {
  const resolveXPost = createXPostResolver(ctx, ROOT)
  expect(await resolveXPost(URL)).toBeUndefined()
  xArchive.setPost('123', archivedPost())
  expect((await resolveXPost(URL))?.id).toBe('123')
  expect(xArchive.resolves()).toHaveLength(2)
})

it('reads an archive again after X post queries are invalidated', async () => {
  xArchive.setPost('123', archivedPost())
  const resolveXPost = createXPostResolver(ctx, ROOT)
  await resolveXPost(URL)
  invalidateXPostQueries()
  const next = resolveXPost(URL)
  expect(next).toBeInstanceOf(Promise)
  expect((await next)?.id).toBe('123')
  expect(xArchive.resolves()).toHaveLength(2)
})

it('keeps archives of different graphs apart', async () => {
  xArchive.setPost('123', archivedPost())
  await createXPostResolver(ctx, ROOT)(URL)
  expect(createXPostResolver(ctx, '/other')(URL)).toBeInstanceOf(Promise)
})

it('ignores non-X URLs and resolves nothing with no graph open', async () => {
  expect(await createXPostResolver(ctx, ROOT)('https://example.com')).toBeUndefined()
  app.graphSession.setGraph(null)
  expect(await createXPostResolver(ctx, '/other')(URL)).toBeUndefined()
  expect(xArchive.resolves()).toEqual([])
})

it('shares pending reads for different URLs of the same post', async () => {
  xArchive.setPost('123', archivedPost())
  const resolveXPost = createXPostResolver(ctx, ROOT)
  const first = resolveXPost(URL)
  const second = resolveXPost('https://twitter.com/jack/status/123')
  await first
  await second
  expect(xArchive.resolves()).toEqual([{ generation: 7, postId: '123' }])
})

it('shares a resolver within a graph and isolates another graph', () => {
  const graph = { root: '/graph', name: 'Graph', generation: 7 }
  expect(getXPostResolver(ctx, graph)).toBe(getXPostResolver(ctx, graph))
  expect(getXPostResolver(ctx, { ...graph, generation: 8 })).not.toBe(getXPostResolver(ctx, graph))
})

it('fetches, saves, and renders a post that has no archive', async () => {
  xArchive.setSyndication('123', archivedPost().archive.data)

  const post = await createXPostResolver(ctx, ROOT)(URL)

  expect(post).toMatchObject({ id: '123' })
  expect(xArchive.syndicationRequests()).toEqual(['123'])
  expect(xArchive.writes()).toEqual([
    {
      generation: 7,
      post: expect.objectContaining({
        kind: 'x-post',
        data: expect.objectContaining({ id: '123' }),
      }),
    },
  ])
})

it('asks X once for a post that does not exist', async () => {
  const resolve = createXPostResolver(ctx, ROOT)
  await expect(resolve(URL)).resolves.toBeUndefined()
  await expect(resolve(URL)).resolves.toBeUndefined()
  expect(xArchive.syndicationRequests()).toHaveLength(1)
  expect(xArchive.resolves()).toHaveLength(2)
  expect(xArchive.writes()).toEqual([])
})

it('asks X again after a failed request', async () => {
  const fetchSyndication = vi
    .spyOn(xArchive, 'fetchSyndication')
    .mockRejectedValueOnce(new AppError('network', 'offline'))
  const resolve = createXPostResolver(ctx, ROOT)
  await expect(resolve(URL)).rejects.toMatchObject({ kind: 'network' })
  await resolve(URL)
  expect(fetchSyndication).toHaveBeenCalledTimes(2)
})

it('does not ask X for a post that has an archive', async () => {
  xArchive.setPost('123', archivedPost())
  await createXPostResolver(ctx, ROOT)(URL)
  expect(xArchive.syndicationRequests()).toEqual([])
})
