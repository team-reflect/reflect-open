import { z } from 'zod'
import { safeParse } from 'valibot'
import { XPostSchema } from '@post-embed/schema'
import { getXPostMediaUrls } from '@post-embed/types'
import type { ArchivedXPost } from './types'

export const archiveResourceSchema = z.looseObject({
  url: z.string(),
  state: z.enum(['pending', 'stored', 'failed', 'unsupported']),
  error: z
    .enum([
      'network',
      'authentication',
      'source-missing',
      'storage',
      'format',
      'unsupported-hls',
      'video-too-large',
    ])
    .optional(),
})
export function isValidUrl(source: string): boolean {
  return URL.canParse(source)
}

const outerSchema = z.looseObject({
  kind: z.literal('x-post'),
  id: z.string().regex(/^[1-9]\d{0,19}$/),
  revision: z.string().min(1),
  capturedAt: z.iso.datetime({ offset: true }),
  textState: z.enum(['complete', 'partial', 'unknown']),
  data: z.unknown(),
  resources: z.array(archiveResourceSchema),
})
export function parseArchivedPost(input: unknown): ArchivedXPost {
  const archive = outerSchema.parse(input)
  const post = safeParse(XPostSchema, archive.data)
  if (!post.success || post.output.id !== archive.id) throw new Error('invalid-post')
  for (const resource of archive.resources) {
    if (!isValidUrl(resource.url)) throw new Error('invalid-media-url')
  }
  for (const entry of [post.output, post.output.quote]) {
    for (const media of entry?.media ?? []) {
      if (
        media.type !== 'photo' &&
        (media.sources.length > 1 || media.sources.some((source) => source.type !== 'video/mp4'))
      ) {
        throw new Error('invalid-video-selection')
      }
    }
  }
  const resources = new Set(archive.resources.map((resource) => resource.url))
  for (const url of getXPostMediaUrls(post.output)) {
    if (!isValidUrl(url) || !resources.has(url)) {
      throw new Error('unregistered-media-url')
    }
  }
  return { ...archive, data: post.output }
}
export const archivedPostSchema = z.unknown().transform((value, context) => {
  try {
    return parseArchivedPost(value)
  } catch {
    context.addIssue({ code: 'custom', message: 'invalid-post' })
    return z.NEVER
  }
})
export const archiveJobSchema = z.object({
  id: z.string().regex(/^url_sha256_[a-f0-9]{64}$/),
  resource: archiveResourceSchema,
  postIds: z.array(z.string()),
  state: z.enum(['pending', 'stored', 'failed', 'unsupported', 'downloading']),
  lease: z.string().nullable(),
  leaseUntil: z.number(),
  offset: z.number().int().nonnegative(),
  receipt: z
    .object({
      name: z.string(),
      bytes: z.number(),
      mime: z.string(),
      sha256: z.string().optional(),
    })
    .nullable(),
})
