import { mapXPostMediaUrls, parseYouTubeVideo } from '@post-embed/schema'
import type { XPost, YouTubeVideo } from '@post-embed/types'
import { oembedRequestURL } from './oembed.ts'
import type { ClockService, TimerHandle } from '../ports/clock-service.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { FileSrcSource } from '../ports/file-src.ts'
import type { WebFetchService } from '../link-preview/web-fetch-service.ts'
import type { GraphSessionService } from '../graph/graph-session-service.ts'
import type { CloudSafe } from '../privacy/cloud-safe.ts'
import { createArchivedPost, type XArchiveService } from './x-archive-service.ts'

// A video no note asked for again is dropped this long after it was fetched.
const YOUTUBE_VIDEO_DROP_MS = 30 * 60 * 1000

export interface EmbedMediaServiceDeps {
  readonly xArchive: XArchiveService
  readonly webFetch: WebFetchService
  readonly platform: FileSrcSource
  readonly clock: ClockService
  readonly logger: LoggerService
  readonly graphSession: GraphSessionService
}

/**
 * The embedded media of the editor's cards: X posts and YouTube videos.
 */
export interface EmbedMediaService {
  /**
   * The archived X post `postId` of the open graph, with each media URL that
   * has a local copy mapped to its `reflect-asset:` URL, or `null` when there
   * is none or no graph is open. A post with no archive is fetched from X, archived
   * and read again. X is asked once per post for the service's lifetime; a
   * failed request runs again. Every call reads the archive: the caller
   * caches the answer.
   */
  loadXPost(postId: string): Promise<XPost | null>
  /**
   * The card snapshot of a YouTube video URL: at once when it was fetched
   * before, otherwise once the oEmbed endpoint answers. A URL that is not a
   * YouTube video and a failed fetch (which is logged) resolve `undefined`
   * and are asked again.
   */
  resolveYouTubeVideo(url: string): YouTubeVideo | Promise<YouTubeVideo | undefined>
}

class EmbedMediaServiceImpl implements EmbedMediaService {
  readonly #deps: EmbedMediaServiceDeps
  // What X answered for each post id; a failed request leaves no entry.
  readonly #syndication = new Map<string, Promise<XPost | null>>()
  readonly #videos = new Map<string, YouTubeVideo>()
  readonly #videoFetches = new Map<string, Promise<YouTubeVideo | null>>()
  readonly #videoDrops = new Map<string, TimerHandle>()

  constructor(deps: EmbedMediaServiceDeps) {
    this.#deps = deps
  }

  async loadXPost(postId: string): Promise<XPost | null> {
    const { xArchive, platform, graphSession } = this.#deps
    const session = graphSession.getState().session
    if (session === null) return null
    const { generation } = session
    const result =
      (await xArchive.resolve(generation, postId)) ??
      (await this.#fetchAndArchiveXPost(generation, postId))
    if (!result) return null
    const local = new Map(
      result.resources.map((resource) => [
        resource.url,
        platform.convertFileSrc(
          generation + '/x-media/' + postId + '/' + resource.hash,
          'reflect-asset',
        ),
      ]),
    )
    return mapXPostMediaUrls(result.archive.data, (source) => local.get(source))
  }

  resolveYouTubeVideo(url: string): YouTubeVideo | Promise<YouTubeVideo | undefined> {
    return this.#videos.get(url) ?? this.#loadYouTubeVideo(url)
  }

  #fetchSyndicationOnce(postId: string): Promise<XPost | null> {
    let pending = this.#syndication.get(postId)
    if (pending === undefined) {
      const request = this.#deps.xArchive.fetchSyndication(postId)
      pending = request
      this.#syndication.set(postId, request)
      request.catch(() => {
        if (this.#syndication.get(postId) === request) {
          this.#syndication.delete(postId)
        }
      })
    }
    return pending
  }

  async #fetchAndArchiveXPost(generation: number, postId: string) {
    const { xArchive, clock } = this.#deps
    const post = await this.#fetchSyndicationOnce(postId)
    if (!post) return null
    await xArchive.write(generation, createArchivedPost(post, new Date(clock.now()).toISOString()))
    return await xArchive.resolve(generation, postId)
  }

  /**
   * The card snapshot for a YouTube video URL, or `null` when the URL is not one.
   */
  async #fetchYouTubeVideo(url: string): Promise<YouTubeVideo | null> {
    const requestURL = oembedRequestURL(url)
    if (requestURL === null) return null
    // The URL is one the user put on a card, which loads from YouTube anyway.
    const answer: unknown = JSON.parse(
      await this.#deps.webFetch.fetchOembed(requestURL as CloudSafe<string>),
    )
    const result = parseYouTubeVideo(answer)
    if (result.issues) {
      throw new Error(`invalid oEmbed answer for ${url}: ${JSON.stringify(result.issues)}`)
    }
    return { ...result.value, url }
  }

  #scheduleVideoDrop(url: string): void {
    const { clock } = this.#deps
    const scheduled = this.#videoDrops.get(url)
    if (scheduled !== undefined) {
      clock.clearTimeout(scheduled)
    }
    this.#videoDrops.set(
      url,
      clock.setTimeout(() => {
        this.#videoDrops.delete(url)
        this.#videos.delete(url)
      }, YOUTUBE_VIDEO_DROP_MS),
    )
  }

  #fetchYouTubeVideoOnce(url: string): Promise<YouTubeVideo | null> {
    let pending = this.#videoFetches.get(url)
    if (pending === undefined) {
      pending = (async () => {
        try {
          const video = await this.#fetchYouTubeVideo(url)
          // A found video stays for the session; a missing one is asked again.
          if (video !== null) {
            this.#videos.set(url, video)
            this.#scheduleVideoDrop(url)
          }
          return video
        } finally {
          this.#videoFetches.delete(url)
        }
      })()
      this.#videoFetches.set(url, pending)
    }
    return pending
  }

  async #loadYouTubeVideo(url: string): Promise<YouTubeVideo | undefined> {
    try {
      return (await this.#fetchYouTubeVideoOnce(url)) ?? undefined
    } catch (cause) {
      this.#deps.logger.error(`YouTube video fetch failed: ${url}`, cause)
      return
    }
  }
}

export function createEmbedMediaService(deps: EmbedMediaServiceDeps): EmbedMediaService {
  return new EmbedMediaServiceImpl(deps)
}
