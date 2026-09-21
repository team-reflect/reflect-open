import { z } from 'zod'
import { fromSyndication } from '@post-embed/exporter/x/syndication'
import { parseXPost } from '@post-embed/schema'
import type { XPost, XPostBase } from '@post-embed/types'
import { call } from './ipc/invoke.ts'

export interface ArchivedXPost {
  kind: 'x-post'
  capturedAt: string
  data: XPost
}

/** One adapter shared by captured messages and archive files. */
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

/** Capture one progressive MP4 per video; HLS is not archived. */
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
export function resolveArchivedPost(generation: number, postId: string) {
  return call('x_archive_resolve', { generation, postId }, resolvedPostSchema.nullable())
}
export function getXArchiveOwners(assetPath: string, generation?: number) {
  if (!assetPath.startsWith('assets/x/')) return Promise.resolve([] as string[])
  return call('x_archive_owners', { assetPath, generation }, z.array(z.string()))
}

export async function saveArchivedPost(generation: number, incoming: ArchivedXPost): Promise<void> {
  await call('x_archive_write', { generation, value: incoming }, z.null())
}

const syndicationPostSchema = z.unknown().transform((value): XPost | null => {
  if (value == null) return null
  const result = fromSyndication(value)
  return result.issues ? null : result.value
})

/** The post from X's syndication API, or `null` when X has no renderable public post with this id. */
export async function fetchSyndicationPost(postId: string): Promise<XPost | null> {
  const post = await call('x_syndication_fetch', { postId }, syndicationPostSchema)
  return post?.id === postId ? post : null
}
