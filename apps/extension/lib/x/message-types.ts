import type { CapturedPost } from '@reflect/core/capture-envelope'

/**
 * The X content script ↔ background contract (Plan 25), the half the
 * content script needs: message type strings, the message shapes, and a
 * plain-object check for the one message it receives. Deliberately free of
 * zod (and of `capture-envelope`'s value exports) so the watcher bundle that
 * runs on x.com carries no validator — the background validates what it
 * receives with the schemas in `messages.ts`, which build on these types.
 */

export const POST_CAPTURED_MESSAGE_TYPE = 'reflect:post-captured'
export const POST_RELEASED_MESSAGE_TYPE = 'reflect:post-released'
export const EXTRACT_POST_MESSAGE_TYPE = 'reflect:extract-post'
export const X_CAPTURE_STOP_MESSAGE_TYPE = 'reflect:x-capture-stop'

/** A post just became bookmarked or liked on the page. */
export interface PostCapturedMessage {
  type: typeof POST_CAPTURED_MESSAGE_TYPE
  page: {
    /** The post permalink, as the page spells it. */
    url: string
    /** The tab title — the note's fallback title when nothing was read. */
    title: string
    post: CapturedPost
  }
}

/** A post was un-bookmarked (or un-liked): forget it, so a re-bookmark captures. */
export interface PostReleasedMessage {
  type: typeof POST_RELEASED_MESSAGE_TYPE
  id: string
}

/** Background → content script: the feature was switched off; stop watching. */
export interface StopXCaptureMessage {
  type: typeof X_CAPTURE_STOP_MESSAGE_TYPE
}

/** Popup/shortcut request to the on-demand content script on a permalink page. */
export interface ExtractPostRequest {
  type: typeof EXTRACT_POST_MESSAGE_TYPE
  /** The post id the page is expected to show. */
  id: string
}

/**
 * The on-demand content script's answer: the post read off the permalink
 * page, or `null` when the page shows no article for the requested id (a
 * logged-out render, a deleted post, X markup the extractor cannot read) —
 * the capture then proceeds by URL alone.
 */
export interface ExtractPostResponse {
  post: CapturedPost | null
}

/**
 * Is `message` the stop signal? A shape check, not a validation — the
 * message carries nothing but its type, and this runs in the page.
 */
export function isStopXCaptureMessage(message: unknown): message is StopXCaptureMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    (message as { type: unknown }).type === X_CAPTURE_STOP_MESSAGE_TYPE
  )
}
