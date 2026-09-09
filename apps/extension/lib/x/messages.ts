import { z } from 'zod'
import { capturedPostSchema } from '@reflect/core/capture-envelope'
import {
  EXTRACT_POST_MESSAGE_TYPE,
  POST_CAPTURED_MESSAGE_TYPE,
  POST_RELEASED_MESSAGE_TYPE,
  type ExtractPostRequest,
  type ExtractPostResponse,
  type PostCapturedMessage,
  type PostReleasedMessage,
} from './message-types'

/**
 * The validating half of the X message contract (Plan 25), for the
 * background, the popup, and the on-demand content script — every receiver
 * of a message that carries a post. The shapes are declared in
 * `message-types.ts`; each schema is pinned to its interface so the two
 * cannot drift. The watcher content script imports only `message-types`.
 */

export {
  EXTRACT_POST_MESSAGE_TYPE,
  POST_CAPTURED_MESSAGE_TYPE,
  POST_RELEASED_MESSAGE_TYPE,
  X_CAPTURE_STOP_MESSAGE_TYPE,
  isStopXCaptureMessage,
  type ExtractPostRequest,
  type ExtractPostResponse,
  type PostCapturedMessage,
  type PostReleasedMessage,
  type StopXCaptureMessage,
} from './message-types'

export const postCapturedMessageSchema = z.object({
  type: z.literal(POST_CAPTURED_MESSAGE_TYPE),
  page: z.object({
    url: z.url(),
    title: z.string(),
    post: capturedPostSchema,
  }),
}) satisfies z.ZodType<PostCapturedMessage>

export const postReleasedMessageSchema = z.object({
  type: z.literal(POST_RELEASED_MESSAGE_TYPE),
  id: z.string(),
}) satisfies z.ZodType<PostReleasedMessage>

/** What the background did with a reported transition. */
export const postCaptureResponseSchema = z.object({
  saved: z.boolean(),
  reason: z.enum(['queued', 'disabled', 'seen', 'rejected']),
})
export type PostCaptureResponse = z.infer<typeof postCaptureResponseSchema>

export const extractPostRequestSchema = z.object({
  type: z.literal(EXTRACT_POST_MESSAGE_TYPE),
  id: z.string(),
}) satisfies z.ZodType<ExtractPostRequest>

export const extractPostResponseSchema = z.object({
  post: capturedPostSchema.nullable(),
}) satisfies z.ZodType<ExtractPostResponse>

/** Is `message` a well-formed {@link PostCapturedMessage}? Validates against its schema. */
export function isPostCapturedMessage(message: unknown): message is PostCapturedMessage {
  return postCapturedMessageSchema.safeParse(message).success
}

/** Is `message` a well-formed {@link PostReleasedMessage}? Validates against its schema. */
export function isPostReleasedMessage(message: unknown): message is PostReleasedMessage {
  return postReleasedMessageSchema.safeParse(message).success
}
