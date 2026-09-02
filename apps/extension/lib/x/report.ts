import { postPermalink } from '@reflect/core/post-url'
import type { PostStateChange } from './bookmark-watch'
import { extractPost } from './extract-post'
import {
  POST_CAPTURED_MESSAGE_TYPE,
  POST_RELEASED_MESSAGE_TYPE,
  type PostCapturedMessage,
  type PostReleasedMessage,
} from './messages'

/**
 * Turn a watched transition into the message the content script sends. A
 * bookmark/like reads the post off the article (best-effort — an unreadable
 * article still captures by id); a release only names the id. The URL is
 * the post's own permalink, never the page's (the timeline's URL says
 * nothing about the post).
 */
export function messageForChange(
  change: PostStateChange,
): PostCapturedMessage | PostReleasedMessage {
  if (!change.active) {
    return { type: POST_RELEASED_MESSAGE_TYPE, id: change.id }
  }
  const post = extractPost(change.article, change.action) ?? {
    provider: 'x',
    id: change.id,
    trigger: change.action,
  }
  return {
    type: POST_CAPTURED_MESSAGE_TYPE,
    page: { url: postPermalink(post.id, post.author?.handle ?? null), title: '', post },
  }
}
