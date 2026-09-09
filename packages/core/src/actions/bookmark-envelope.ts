import { z } from 'zod'

/** Bound for a bookmark wire message, in UTF-8 bytes. */
export const BOOKMARK_MAX_BYTES = 8192
export const postIdSchema = z.string().regex(/^[1-9]\d{0,19}$/)

/** URL-only bookmark capture, bound to a paired local graph. */
export const bookmarkEnvelopeSchema = z
  .object({
    version: z.literal(2),
    kind: z.literal('x-bookmark'),
    id: z.guid(),
    source: z.literal('extension'),
    postId: postIdSchema,
    capturedAt: z.iso.datetime({ offset: true }),
    captureDate: z.iso.date(),
    targetGraphId: z.string().regex(/^[a-f0-9]{64}$/),
    evidence: z.enum(['request-intent', 'manual']),
    presentation: z.enum(['link', 'embed']),
  })
  .strict()
export type BookmarkEnvelope = z.infer<typeof bookmarkEnvelopeSchema>

export const bookmarkWireSchema = z
  .object({ envelope: bookmarkEnvelopeSchema })
  .strict()
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= BOOKMARK_MAX_BYTES)

/** Capability advertised by a desktop-installed, bookmark-aware host. */
export const bookmarkCapabilitySchema = z.object({
  ok: z.literal(true),
  bookmarkVersion: z.literal(2),
  targetGraphId: bookmarkEnvelopeSchema.shape.targetGraphId,
  maxMessageBytes: z.literal(BOOKMARK_MAX_BYTES),
})
export type BookmarkCapability = z.infer<typeof bookmarkCapabilitySchema>

/** Normalize supported X permalink spellings without trusting a page title. */
export function getBookmarkPostId(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password
    )
      return undefined
    const match =
      /^\/(?:\w+|i\/web)\/status\/([1-9]\d{0,19})(?:\/(?:photo|video)\/\d+)?\/?$/.exec(
        url.pathname,
      )
    return match?.[1]
  } catch {
    return undefined
  }
}
