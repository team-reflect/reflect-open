import { z } from 'zod'
import { capturedPostSchema } from '@reflect/core/capture-envelope'

/**
 * The X content script ↔ background contract (Plan 25). The content script
 * reports every state transition it saw; the background owns the decision
 * (preferences, the seen-set) and the queue.
 */

export const POST_CAPTURED_MESSAGE_TYPE = 'reflect:post-captured'
export const POST_RELEASED_MESSAGE_TYPE = 'reflect:post-released'
export const EXTRACT_POST_MESSAGE_TYPE = 'reflect:extract-post'

/** A post just became bookmarked or liked on the page. */
export const postCapturedMessageSchema = z.object({
  type: z.literal(POST_CAPTURED_MESSAGE_TYPE),
  page: z.object({
    /** The post permalink, as the page spells it. */
    url: z.url(),
    /** The tab title — the note's fallback title when nothing was read. */
    title: z.string(),
    post: capturedPostSchema,
  }),
})
export type PostCapturedMessage = z.infer<typeof postCapturedMessageSchema>

/** A post was un-bookmarked (or un-liked): forget it, so a re-bookmark captures. */
export const postReleasedMessageSchema = z.object({
  type: z.literal(POST_RELEASED_MESSAGE_TYPE),
  id: z.string(),
})
export type PostReleasedMessage = z.infer<typeof postReleasedMessageSchema>

/** What the background did with a reported transition. */
export const postCaptureResponseSchema = z.object({
  saved: z.boolean(),
  reason: z.enum(['queued', 'disabled', 'seen', 'rejected']),
})
export type PostCaptureResponse = z.infer<typeof postCaptureResponseSchema>

/** Popup/shortcut request to the on-demand content script on a permalink page. */
export const extractPostRequestSchema = z.object({
  type: z.literal(EXTRACT_POST_MESSAGE_TYPE),
  /** The post id the page is expected to show. */
  id: z.string(),
})
export type ExtractPostRequest = z.infer<typeof extractPostRequestSchema>

export const extractPostResponseSchema = z.object({
  post: capturedPostSchema.nullable(),
})
export type ExtractPostResponse = z.infer<typeof extractPostResponseSchema>

export function isPostCapturedMessage(message: unknown): message is PostCapturedMessage {
  return postCapturedMessageSchema.safeParse(message).success
}

export function isPostReleasedMessage(message: unknown): message is PostReleasedMessage {
  return postReleasedMessageSchema.safeParse(message).success
}
