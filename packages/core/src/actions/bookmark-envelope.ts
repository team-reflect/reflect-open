import { xPostSchema } from '../x-archive'
import { X_POST_ID_PATTERN } from '@post-embed/schema'
import { z } from 'zod'

export const postIdSchema = z.string().regex(X_POST_ID_PATTERN)

/** X capture with one source of truth for its timestamp and post ID. */
export const bookmarkEnvelopeSchema = z.object({
  version: z.literal(2),
  kind: z.literal('x-bookmark'),
  id: z.guid(),
  source: z.literal('extension'),
  capturedAt: z.iso.datetime({ offset: true }),
  data: xPostSchema,
})

export type BookmarkEnvelope = z.infer<typeof bookmarkEnvelopeSchema>

export const bookmarkWireSchema = z.object({ envelope: bookmarkEnvelopeSchema }).strict()
