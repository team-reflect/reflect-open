import type { CaptureEnvelope, CapturedPost } from './capture-envelope'
import { parsePostUrl, postPermalink } from './post-url'

/** A link envelope resolved to the post it captures, if any. */
export interface PostCapture {
  /** The envelope, its URL replaced by the canonical permalink for a post. */
  envelope: CaptureEnvelope
  post: CapturedPost | undefined
}

/**
 * The post a link envelope captures, when it is one (Plan 25): the block the
 * producer sent, or — for any post permalink captured without one (⌘⇧K, the
 * popup, a share) — a `manual` capture with nothing read off the page. Either
 * way the envelope's URL becomes the canonical permalink so the same post
 * dedupes across `x.com`/`twitter.com` spellings and share-sheet junk params.
 */
export function postCaptureOf(envelope: CaptureEnvelope): PostCapture {
  const permalink = parsePostUrl(envelope.url)
  if (envelope.post !== undefined) {
    const handle = envelope.post.author?.handle ?? permalink?.handle ?? null
    return {
      envelope: { ...envelope, url: postPermalink(envelope.post.id, handle) },
      post: envelope.post,
    }
  }
  if (permalink === null) {
    return { envelope, post: undefined }
  }
  return {
    envelope: { ...envelope, url: permalink.url },
    post: { provider: 'x', id: permalink.id, trigger: 'manual' },
  }
}
