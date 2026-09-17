import { xPostSchema } from '../x-archive'
import { X_POST_ID_PATTERN } from '@post-embed/schema'
import { z } from 'zod'

export const postIdSchema = z.string().regex(X_POST_ID_PATTERN)

/** Capture metadata shared by snapshots and URL-only fallbacks. */
const xPostMetadataSchema = z.object({
  version: z.literal(2),
  kind: z.enum(['x-bookmark', 'x-like']),
  id: z.guid(),
  source: z.literal('extension'),
  capturedAt: z.iso.datetime({ offset: true }),
})

/** A failed page lookup still preserves the post, without inventing post data. */
export const xPostEnvelopeSchema = z.union([
  xPostMetadataSchema.extend({ data: xPostSchema }),
  xPostMetadataSchema.extend({ postId: postIdSchema, data: z.never().optional() }),
])

export type XPostEnvelope = z.infer<typeof xPostEnvelopeSchema>
export type XPostKind = XPostEnvelope['kind']

export const xPostWireSchema = z.object({ envelope: xPostEnvelopeSchema }).strict()
