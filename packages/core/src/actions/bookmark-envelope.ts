import { xPostSchema } from '../x-archive'
import { X_POST_ID_PATTERN } from '@post-embed/schema'
import { z } from 'zod'

export const postIdSchema = z.string().regex(X_POST_ID_PATTERN)

/** Capture metadata shared by snapshots and URL-only fallbacks. */
const bookmarkMetadataSchema = z.object({
  version: z.literal(2),
  kind: z.literal('x-bookmark'),
  id: z.guid(),
  source: z.literal('extension'),
  capturedAt: z.iso.datetime({ offset: true }),
})

/** A failed page lookup still preserves the bookmark, without inventing post data. */
export const bookmarkEnvelopeSchema = z.union([
  bookmarkMetadataSchema.extend({ data: xPostSchema }),
  bookmarkMetadataSchema.extend({ postId: postIdSchema, data: z.never().optional() }),
])

export type BookmarkEnvelope = z.infer<typeof bookmarkEnvelopeSchema>

export const bookmarkWireSchema = z.object({ envelope: bookmarkEnvelopeSchema }).strict()

/** Liked posts carry the same snapshot or URL fallback as bookmarks. */
const likeMetadataSchema = bookmarkMetadataSchema.extend({ kind: z.literal('x-like') })
export const likeEnvelopeSchema = z.union([
  likeMetadataSchema.extend({ data: xPostSchema }).strict(),
  likeMetadataSchema.extend({ postId: postIdSchema, data: z.never().optional() }).strict(),
])
export type LikeEnvelope = z.infer<typeof likeEnvelopeSchema>
export const likeWireSchema = z.object({ envelope: likeEnvelopeSchema }).strict()
export const xPostEnvelopeSchema = z.union([bookmarkEnvelopeSchema, likeEnvelopeSchema])
export type XPostEnvelope = z.infer<typeof xPostEnvelopeSchema>
export type XPostKind = XPostEnvelope['kind']

/** The current native host and graph reader's supported like format. */
export const captureCapabilitiesSchema = z.object({
  ok: z.literal(true),
  status: z.literal('capabilities'),
  xLikeVersion: z.literal(2).nullable(),
}).strict()
