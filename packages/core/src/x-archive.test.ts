import type { XPost } from '@post-embed/types'
import { afterEach, expect, it, vi } from 'vitest'
import { setBridge } from './ipc/bridge'
import {
  createArchivedPost,
  peekArchivedPost,
  resolveArchivedPost,
  saveArchivedPost,
  xPostSchema,
} from './x-archive'

afterEach(() => {
  setBridge(null)
})

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

it('keeps a resolved archive until a capture rewrites it', async () => {
  const post: XPost = {
    id: '123',
    createdAt: '2026-09-14T00:00:00Z',
    author: { name: 'Author', handle: 'author' },
    body: [{ type: 'text', text: 'Saved text' }],
  }
  const archived = createArchivedPost(post, '2026-09-14T00:00:00Z')
  const invoke = vi.fn(async (command: string) =>
    command === 'x_archive_resolve' ? { archive: archived, resources: [] } : null,
  )
  setBridge({ invoke, listen: async () => () => {} })

  expect(peekArchivedPost(1, '123')).toBeUndefined()
  const resolved = await resolveArchivedPost(1, '123')
  expect(peekArchivedPost(1, '123')).toEqual(resolved)
  expect(peekArchivedPost(2, '123')).toBeUndefined()

  await saveArchivedPost(1, archived)
  expect(peekArchivedPost(1, '123')).toBeUndefined()
})

it('does not keep a missing archive', async () => {
  setBridge({ invoke: async () => null, listen: async () => () => {} })
  expect(await resolveArchivedPost(3, '456')).toBeNull()
  expect(peekArchivedPost(3, '456')).toBeUndefined()
})
