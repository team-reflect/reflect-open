import { z } from 'zod'
import { safeParse } from 'valibot'
import { XPostSchema } from '@post-embed/schema'
import type { XPost, XPostBase } from '@post-embed/types'
import { call } from './ipc/invoke'

export interface ArchivedXPost {
  kind: 'x-post'
  capturedAt: string
  data: XPost
}

/** One adapter shared by captured messages and archive files. */
export const xPostSchema = z.unknown().transform((value, context) => {
  FIXME: I do not want to add "valibot" as a explicit dependency to reflect-open repo. Try to just use XPostSchema as a standard schema. Is there a good way so that I can integrate a standard schema into zod. Also notice that you can use runtime to ensuree that XPostSchema is a "sync" standard schema.
  const result = safeParse(XPostSchema, value)
  if (result.success) return result.output
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
export function getXArchiveOwners(assetPath: string) {
  if (!assetPath.startsWith('assets/x/')) return Promise.resolve([] as string[])
  return call('x_archive_owners', { assetPath }, z.array(z.string()))
}

export async function saveArchivedPost(generation: number, incoming: ArchivedXPost): Promise<void> {
  await call('x_archive_write', { generation, value: incoming }, z.null())
}
