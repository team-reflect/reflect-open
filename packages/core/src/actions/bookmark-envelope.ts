import { archivedPostSchema } from '../x-archive/schema'
import { z } from 'zod'

export const postIdSchema = z.string().regex(/^[1-9]\d{0,19}$/)

/** URL-only X bookmark capture; the desktop derives the permalink from `postId`. */
// FIXME: `bookmark-envelope.fixtures.json` now repeats the same 15-line `archive` object seven
// times. The Rust test that consumed it as language-neutral JSON was deleted with `bookmark.rs`, so
// build the cases in the TS test from one shared `archive` constant instead. Also see x-save.ts:
// `postId`/`capturedAt`/`id` are duplicated inside `archive`.
export const bookmarkEnvelopeSchema = z.object({
  archive: archivedPostSchema,
  version: z.literal(2),
  kind: z.literal('x-bookmark'),
  id: z.guid(),
  source: z.literal('extension'),
  postId: postIdSchema,
  capturedAt: z.iso.datetime({ offset: true }),
})

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
