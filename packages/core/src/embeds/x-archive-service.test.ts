import type { XPost } from '@post-embed/types'
import { expect, it } from 'vitest'
import { AppError } from '../errors.ts'
import { createTestIpcBridgeService, createTestXArchiveService } from '../testing/index.ts'
import { syndicationPost20 as tweet } from '../testing/syndication-20.ts'
import {
  createArchivedPost,
  createXArchiveService,
  xPostSchema,
  type ResolvedArchivedPost,
} from './x-archive-service.ts'

function serviceAnswering(command: string, answer: unknown) {
  const ipc = createTestIpcBridgeService({ commands: { [command]: () => answer } })
  return { ipc, xArchive: createXArchiveService({ ipc }) }
}

const POST: XPost = {
  id: '123',
  createdAt: '2026-09-14T00:00:00Z',
  author: { name: 'Author', handle: 'author' },
  body: [{ type: 'text', text: 'Saved text' }],
}

const RESOLVED: ResolvedArchivedPost = {
  archive: { kind: 'x-post', capturedAt: '2026-09-14T00:00:00Z', data: POST },
  resources: [{ url: 'https://pbs.twimg.com/a.jpg', hash: 'a'.repeat(64) }],
}

it('archives the highest bitrate MP4 in the post and quote without mutating capture data', () => {
  const video = {
    type: 'video' as const,
    width: 640,
    height: 360,
    poster: 'https://pbs.twimg.com/poster.jpg',
    sources: [
      { url: 'https://video.twimg.com/low.mp4', type: 'video/mp4' as const, bitrate: 1000 },
      { url: 'https://video.twimg.com/high.mp4', type: 'video/mp4' as const, bitrate: 2000 },
      { url: 'https://video.twimg.com/stream.m3u8', type: 'application/x-mpegURL' as const },
    ],
  }
  const post: XPost = {
    id: '123',
    createdAt: '',
    author: { name: 'Author', handle: 'author' },
    body: [{ type: 'text', text: 'Saved text' }],
    media: [video],
  }
  post.quote = { ...post, id: '456' }
  const original = structuredClone(post)
  const archived = createArchivedPost(post, '2026-09-14T00:00:00Z')
  expect(archived).toMatchObject({ kind: 'x-post', capturedAt: '2026-09-14T00:00:00Z' })
  const selected = { ...video, sources: [video.sources[1]] }
  expect(archived.data.media).toEqual([selected])
  expect(archived.data.quote?.media).toEqual([selected])
  expect(archived.data.body).toEqual(post.body)
  expect(post).toEqual(original)
})

it('preserves photos and video posters while omitting HLS-only playback sources', () => {
  const photo = {
    type: 'photo' as const,
    url: 'https://pbs.twimg.com/photo.jpg',
    width: 1,
    height: 1,
  }
  const video = {
    type: 'video' as const,
    width: 1,
    height: 1,
    poster: 'https://pbs.twimg.com/poster.jpg',
    sources: [
      { type: 'application/x-mpegURL' as const, url: 'https://video.twimg.com/stream.m3u8' },
    ],
  }
  const post: XPost = {
    id: '123',
    createdAt: '',
    author: { name: '', handle: '' },
    body: [],
    media: [photo, video],
  }
  expect(createArchivedPost(post, '2026-09-14T00:00:00Z').data.media).toEqual([
    photo,
    { ...video, sources: [] },
  ])
})

it('validates captured posts through the synchronous Standard Schema contract', () => {
  const post = {
    id: '123',
    createdAt: '2026-09-14T00:00:00Z',
    author: { name: 'Author', handle: 'author' },
    body: [{ type: 'text', text: 'Saved text' }],
  }
  expect(xPostSchema.parse(post)).toEqual(post)
  expect(xPostSchema.safeParse({ ...post, id: 'invalid' }).success).toBe(false)
})

it('converts a syndication answer to a post', async () => {
  const { ipc, xArchive } = serviceAnswering('x_syndication_fetch', tweet)
  await expect(xArchive.fetchSyndication('20')).resolves.toMatchObject({ id: '20' })
  expect(ipc.calls()).toEqual([{ command: 'x_syndication_fetch', args: { postId: '20' } }])
})

it.each([
  ['a missing post', null],
  ['an answer that is not a tweet', { id_str: '20' }],
])('returns null for %s', async (_, answer) => {
  const { xArchive } = serviceAnswering('x_syndication_fetch', answer)
  await expect(xArchive.fetchSyndication('20')).resolves.toBeNull()
})

it('returns null for a post with another id', async () => {
  const { xArchive } = serviceAnswering('x_syndication_fetch', tweet)
  await expect(xArchive.fetchSyndication('21')).resolves.toBeNull()
})

it('rejects when the request fails', async () => {
  const ipc = createTestIpcBridgeService({
    commands: {
      x_syndication_fetch: async () => await Promise.reject(new AppError('network', 'offline')),
    },
  })
  await expect(createXArchiveService({ ipc }).fetchSyndication('20')).rejects.toMatchObject({
    kind: 'network',
  })
})

it('resolves an archived post and validates the answer', async () => {
  const { ipc, xArchive } = serviceAnswering('x_archive_resolve', RESOLVED)
  await expect(xArchive.resolve(7, '123')).resolves.toEqual(RESOLVED)
  expect(ipc.calls()).toEqual([
    { command: 'x_archive_resolve', args: { generation: 7, postId: '123' } },
  ])

  ipc.onCommand('x_archive_resolve', () => null)
  await expect(xArchive.resolve(7, '123')).resolves.toBeNull()
  ipc.onCommand('x_archive_resolve', () => ({ archive: {}, resources: [] }))
  await expect(xArchive.resolve(7, '123')).rejects.toMatchObject({ kind: 'parse' })
})

it('asks for owners of archived media only', async () => {
  const { ipc, xArchive } = serviceAnswering('x_archive_owners', ['assets/x/post-123.json'])
  await expect(xArchive.owners('assets/x/123/a.jpg', 4)).resolves.toEqual([
    'assets/x/post-123.json',
  ])
  await expect(xArchive.owners('assets/a.jpg')).resolves.toEqual([])
  expect(ipc.calls()).toEqual([
    { command: 'x_archive_owners', args: { assetPath: 'assets/x/123/a.jpg', generation: 4 } },
  ])
})

it('writes an archived post', async () => {
  const { ipc, xArchive } = serviceAnswering('x_archive_write', null)
  await xArchive.write(7, RESOLVED.archive)
  expect(ipc.calls()).toEqual([
    { command: 'x_archive_write', args: { generation: 7, value: RESOLVED.archive } },
  ])
})

it('keeps written posts in the test archive', async () => {
  const xArchive = createTestXArchiveService({
    owners: { 'assets/x/123/a.jpg': ['assets/x/post-123.json'] },
  })
  await expect(xArchive.resolve(7, '123')).resolves.toBeNull()
  await xArchive.write(7, RESOLVED.archive)
  await expect(xArchive.resolve(7, '123')).resolves.toEqual({
    archive: RESOLVED.archive,
    resources: [],
  })
  xArchive.setPost('123', RESOLVED)
  await expect(xArchive.resolve(8, '123')).resolves.toEqual(RESOLVED)
  await expect(xArchive.owners('assets/x/123/a.jpg')).resolves.toEqual(['assets/x/post-123.json'])
  await expect(xArchive.fetchSyndication('123')).resolves.toBeNull()

  expect(xArchive.resolves()).toEqual([
    { generation: 7, postId: '123' },
    { generation: 7, postId: '123' },
    { generation: 8, postId: '123' },
  ])
  expect(xArchive.writes()).toEqual([{ generation: 7, post: RESOLVED.archive }])
  expect(xArchive.syndicationRequests()).toEqual(['123'])
})
