import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors.ts'
import { createEmbedMediaService } from './embed-media-service.ts'
import {
  createTestClockService,
  createTestGraphSessionService,
  createTestLoggerService,
  createTestPlatformService,
  createTestWebFetchService,
  createTestXArchiveService,
} from '../testing/index.ts'
import type { ResolvedArchivedPost, XArchiveService } from './x-archive-service.ts'

/**
 * The real embed media service over `deps`; each one left out is a fresh test double.
 */
function createTestEmbedMedia(deps: Partial<Parameters<typeof createEmbedMediaService>[0]>) {
  return createEmbedMediaService({
    xArchive: deps.xArchive ?? createTestXArchiveService(),
    webFetch: deps.webFetch ?? createTestWebFetchService(),
    platform: deps.platform ?? createTestPlatformService(),
    clock: deps.clock ?? createTestClockService(),
    logger: deps.logger ?? createTestLoggerService(),
    graphSession: deps.graphSession ?? createTestGraphSessionService({ graph: { generation: 7 } }),
  })
}

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

describe('EmbedMediaService.loadXPost', () => {
  function setup() {
    const xArchive = createTestXArchiveService()
    const platform = createTestPlatformService()
    const clock = createTestClockService()
    const graphSession = createTestGraphSessionService({ graph: { generation: 7 } })
    const embedMedia = createTestEmbedMedia({ xArchive, platform, clock, graphSession })
    return { xArchive, platform, clock, graphSession, embedMedia }
  }

  it('rewrites media URLs while retaining URLs without a local mapping', async () => {
    const { xArchive, platform, embedMedia } = setup()
    const result = archivedPost()
    result.archive.data.media = [
      { type: 'photo', url: 'https://pbs.twimg.com/unmapped.png', width: 100, height: 100 },
    ]
    xArchive.setPost('123', result)

    const post = await embedMedia.loadXPost('123')

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

  it('reads the archive of the open graph on every call', async () => {
    const { xArchive, graphSession, embedMedia } = setup()
    expect(await embedMedia.loadXPost('123')).toBeNull()
    xArchive.setPost('123', archivedPost())
    expect((await embedMedia.loadXPost('123'))?.id).toBe('123')
    graphSession.setGraph({ generation: 8 })
    expect((await embedMedia.loadXPost('123'))?.id).toBe('123')
    expect(xArchive.resolves()).toEqual([
      { generation: 7, postId: '123' },
      // The first miss reads again after X had no post to archive.
      { generation: 7, postId: '123' },
      { generation: 8, postId: '123' },
    ])
  })

  it('fetches, saves, and returns a post that has no archive', async () => {
    const { xArchive, clock, embedMedia } = setup()
    xArchive.setSyndication('123', archivedPost().archive.data)
    clock.setNow(Date.parse('2026-10-13T08:00:00Z'))

    const post = await embedMedia.loadXPost('123')

    expect(post).toMatchObject({ id: '123' })
    expect(xArchive.syndicationRequests()).toEqual(['123'])
    expect(xArchive.writes()).toEqual([
      {
        generation: 7,
        post: expect.objectContaining({
          kind: 'x-post',
          capturedAt: '2026-10-13T08:00:00.000Z',
          data: expect.objectContaining({ id: '123' }),
        }),
      },
    ])
  })

  it('asks X once for a post that does not exist', async () => {
    const { xArchive, embedMedia } = setup()
    await expect(embedMedia.loadXPost('123')).resolves.toBeNull()
    await expect(embedMedia.loadXPost('123')).resolves.toBeNull()
    expect(xArchive.syndicationRequests()).toHaveLength(1)
    expect(xArchive.resolves()).toHaveLength(2)
    expect(xArchive.writes()).toEqual([])
  })

  it('asks X once for concurrent reads of one post', async () => {
    const { xArchive, embedMedia } = setup()
    xArchive.setSyndication('123', archivedPost().archive.data)
    await Promise.all([embedMedia.loadXPost('123'), embedMedia.loadXPost('123')])
    expect(xArchive.syndicationRequests()).toEqual(['123'])
  })

  it('asks X again after a failed request', async () => {
    const fake = createTestXArchiveService({ syndication: { '123': archivedPost().archive.data } })
    let failures = 1
    let requests = 0
    const xArchive: XArchiveService = {
      resolve: (generation, postId) => fake.resolve(generation, postId),
      owners: (assetPath, generation) => fake.owners(assetPath, generation),
      write: (generation, post) => fake.write(generation, post),
      async fetchSyndication(postId) {
        requests += 1
        if (failures > 0) {
          failures -= 1
          throw new AppError('network', 'offline')
        }
        return await fake.fetchSyndication(postId)
      },
    }
    const embedMedia = createTestEmbedMedia({ xArchive })

    await expect(embedMedia.loadXPost('123')).rejects.toMatchObject({ kind: 'network' })
    await expect(embedMedia.loadXPost('123')).resolves.toMatchObject({ id: '123' })
    expect(requests).toBe(2)
  })

  it('answers null with no graph open, without reading the archive', async () => {
    const xArchive = createTestXArchiveService()
    xArchive.setPost('123', archivedPost())
    const embedMedia = createTestEmbedMedia({
      xArchive,
      graphSession: createTestGraphSessionService({ graph: null }),
    })

    await expect(embedMedia.loadXPost('123')).resolves.toBeNull()
    expect(xArchive.resolves()).toEqual([])
  })

  it('does not ask X for a post that has an archive', async () => {
    const { xArchive, embedMedia } = setup()
    xArchive.setPost('123', archivedPost())
    await embedMedia.loadXPost('123')
    expect(xArchive.syndicationRequests()).toEqual([])
  })
})

describe('EmbedMediaService.resolveYouTubeVideo', () => {
  const URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=90'

  const ANSWER = {
    title: 'Big Buck Bunny',
    author_name: 'Blender',
    author_url: 'https://www.youtube.com/@BlenderOfficial',
    type: 'video',
    height: 113,
    width: 200,
    version: '1.0',
    provider_name: 'YouTube',
    provider_url: 'https://www.youtube.com/',
    thumbnail_height: 360,
    thumbnail_width: 480,
    thumbnail_url: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg',
    html: '<iframe></iframe>',
  }

  const VIDEO = {
    url: URL,
    title: 'Big Buck Bunny',
    author_name: 'Blender',
    author_url: 'https://www.youtube.com/@BlenderOfficial',
    thumbnail_url: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg',
    thumbnail_width: 480,
    thumbnail_height: 360,
    width: 200,
    height: 113,
  }

  const REQUEST_URL =
    'https://www.youtube.com/oembed?url=' + encodeURIComponent(URL) + '&format=json'

  /**
   * A service whose oEmbed endpoint gives each of `answers` in turn; an `Error` rejects.
   */
  function setup(...answers: (string | Error)[]) {
    const requests: string[] = []
    const logger = createTestLoggerService()
    const clock = createTestClockService()
    const webFetch = createTestWebFetchService()
    vi.spyOn(webFetch, 'fetchOembed').mockImplementation((url) => {
      requests.push(url)
      const answer = answers.shift() ?? new Error('no oEmbed answer left')
      if (answer instanceof Error) {
        return Promise.reject(answer)
      }
      return Promise.resolve(answer)
    })
    const embedMedia = createTestEmbedMedia({
      webFetch,
      clock,
      logger,
    })
    return { embedMedia, requests, logger, clock }
  }

  it('asks the oEmbed endpoint and returns the snapshot with the pasted URL', async () => {
    const webFetch = createTestWebFetchService({
      oembed: { [REQUEST_URL]: JSON.stringify(ANSWER) },
    })
    const embedMedia = createTestEmbedMedia({ webFetch })
    expect(await embedMedia.resolveYouTubeVideo(URL)).toEqual(VIDEO)
    expect(webFetch.requests()).toEqual([{ kind: 'oembed', url: REQUEST_URL }])
  })

  it('returns a fetched video synchronously the second time', async () => {
    const { embedMedia, requests } = setup(JSON.stringify(ANSWER))
    const first = embedMedia.resolveYouTubeVideo(URL)
    expect(first).toBeInstanceOf(Promise)
    expect(await first).toEqual(VIDEO)
    expect(embedMedia.resolveYouTubeVideo(URL)).toEqual(VIDEO)
    expect(requests).toEqual([REQUEST_URL])
  })

  it('asks once for concurrent reads of one video', async () => {
    const { embedMedia, requests } = setup(JSON.stringify(ANSWER))
    const answers = await Promise.all([
      embedMedia.resolveYouTubeVideo(URL),
      embedMedia.resolveYouTubeVideo(URL),
    ])
    expect(answers).toEqual([VIDEO, VIDEO])
    expect(requests).toHaveLength(1)
  })

  it('drops a fetched video 30 minutes after the fetch', async () => {
    const { embedMedia, requests, clock } = setup(JSON.stringify(ANSWER), JSON.stringify(ANSWER))
    await embedMedia.resolveYouTubeVideo(URL)
    await clock.advance(30 * 60 * 1000 - 1)
    expect(embedMedia.resolveYouTubeVideo(URL)).toEqual(VIDEO)
    await clock.advance(1)
    expect(await embedMedia.resolveYouTubeVideo(URL)).toEqual(VIDEO)
    expect(requests).toHaveLength(2)
  })

  it('does not fetch for a URL that is not a YouTube video', async () => {
    const { embedMedia, requests, logger } = setup()
    expect(
      await embedMedia.resolveYouTubeVideo('https://example.com/watch?v=aqz-KE-bpKQ'),
    ).toBeUndefined()
    expect(requests).toEqual([])
    expect(logger.getErrors()).toEqual([])
  })

  it('logs a failed fetch and asks again', async () => {
    const cause = new AppError('io', 'answered 404')
    const { embedMedia, logger } = setup(cause, JSON.stringify(ANSWER))
    expect(await embedMedia.resolveYouTubeVideo(URL)).toBeUndefined()
    expect(logger.getErrors()).toEqual([{ message: `YouTube video fetch failed: ${URL}`, cause }])
    expect(await embedMedia.resolveYouTubeVideo(URL)).toEqual(VIDEO)
  })

  it('logs an answer that is not an object and asks again', async () => {
    const { embedMedia, logger } = setup('null', JSON.stringify(ANSWER))
    expect(await embedMedia.resolveYouTubeVideo(URL)).toBeUndefined()
    expect(logger.getErrors()).toEqual([
      {
        message: `YouTube video fetch failed: ${URL}`,
        cause: expect.objectContaining({
          message: expect.stringContaining('invalid oEmbed answer'),
        }),
      },
    ])
    expect(await embedMedia.resolveYouTubeVideo(URL)).toEqual(VIDEO)
  })
})
