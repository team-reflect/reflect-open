import { z } from 'zod'

export const postIdSchema = z.string().regex(/^[1-9]\d{0,19}$/)

/** URL-only X bookmark capture; the desktop derives the permalink from `postId`. */
export const bookmarkEnvelopeSchema = z
  .object({
    version: z.literal(2),
    kind: z.literal('x-bookmark'),
    id: z.guid(),
    source: z.literal('extension'),
    postId: postIdSchema,
    capturedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
export type BookmarkEnvelope = z.infer<typeof bookmarkEnvelopeSchema>

export const bookmarkWireSchema = z.object({ envelope: bookmarkEnvelopeSchema }).strict()

/** Normalize supported X permalink spellings to a post ID. */
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
    const match = /^\/(?:\w+|i\/web)\/status\/([1-9]\d{0,19})(?:\/(?:photo|video)\/\d+)?\/?$/.exec(
      url.pathname,
    )
    return match?.[1]
  } catch {
    return undefined
  }
}
