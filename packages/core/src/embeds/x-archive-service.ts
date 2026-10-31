import { z } from 'zod'
import { fromSyndication } from '@post-embed/exporter/x/syndication'
import { parseXPost } from '@post-embed/schema'
import type { XPost, XPostBase } from '@post-embed/types'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'

export interface ArchivedXPost {
  kind: 'x-post'
  capturedAt: string
  data: XPost
}

/**
 * One adapter shared by captured messages and archive files.
 */
export const xPostSchema = z.unknown().transform((value, context) => {
  const result = parseXPost(value)
  if (!result.issues) return result.value
  context.addIssue({ code: 'custom', message: 'invalid-post' })
  return z.NEVER
})
export const archivedPostSchema = z.looseObject({
  kind: z.literal('x-post'),
  capturedAt: z.iso.datetime({ offset: true }),
  data: xPostSchema,
})

/**
 * Capture one progressive MP4 per video; HLS is not archived.
 */
export function createArchivedPost(post: XPost, capturedAt: string): ArchivedXPost {
  function select(entry: XPostBase): XPostBase {
    return {
      ...entry,
      media: entry.media?.map((media) => {
        if (media.type === 'photo') return media
        const source = media.sources
          .filter((source) => source.type === 'video/mp4')
          .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0) || a.url.localeCompare(b.url))[0]
        return { ...media, sources: source ? [source] : [] }
      }),
    }
  }
  return {
    kind: 'x-post',
    capturedAt,
    data: {
      ...select(post),
      ...(post.quote ? { quote: select(post.quote) } : {}),
    },
  }
}

export const resolvedPostSchema = z.object({
  archive: archivedPostSchema,
  resources: z.array(z.object({ url: z.string(), hash: z.string() })),
})

/**
 * An archived post with the local hash of each media resource it references.
 */
export type ResolvedArchivedPost = z.infer<typeof resolvedPostSchema>

const syndicationPostSchema = z.unknown().transform((value): XPost | null => {
  if (value == null) return null
  const result = fromSyndication(value)
  return result.issues ? null : result.value
})

export interface XArchiveServiceDeps {
  readonly ipc: IpcBridgeService
}

/**
 * X (Twitter) posts and their media archived under `assets/x/`.
 */
export interface XArchiveService {
  /**
   * The archived post with this id, fetching missing media, or `null` when none is archived.
   */
  resolve(generation: number, postId: string): Promise<ResolvedArchivedPost | null>
  /**
   * The archive files that reference an `assets/x/` media file. Other paths have no owners.
   */
  owners(assetPath: string, generation?: number): Promise<string[]>
  /**
   * Save one archived post.
   */
  write(generation: number, post: ArchivedXPost): Promise<void>
  /**
   * The post from X's syndication API, or `null` when X has no renderable public post with this id.
   */
  fetchSyndication(postId: string): Promise<XPost | null>
}

class XArchiveServiceImpl implements XArchiveService {
  readonly #deps: XArchiveServiceDeps

  constructor(deps: XArchiveServiceDeps) {
    this.#deps = deps
  }

  async resolve(generation: number, postId: string): Promise<ResolvedArchivedPost | null> {
    return await this.#deps.ipc.call(
      'x_archive_resolve',
      { generation, postId },
      resolvedPostSchema.nullable(),
    )
  }

  async owners(assetPath: string, generation?: number): Promise<string[]> {
    if (!assetPath.startsWith('assets/x/')) return []
    return await this.#deps.ipc.call(
      'x_archive_owners',
      { assetPath, generation },
      z.array(z.string()),
    )
  }

  async write(generation: number, post: ArchivedXPost): Promise<void> {
    await this.#deps.ipc.call('x_archive_write', { generation, value: post }, z.null())
  }

  async fetchSyndication(postId: string): Promise<XPost | null> {
    const post = await this.#deps.ipc.call('x_syndication_fetch', { postId }, syndicationPostSchema)
    return post?.id === postId ? post : null
  }
}

export function createXArchiveService(deps: XArchiveServiceDeps): XArchiveService {
  return new XArchiveServiceImpl(deps)
}
