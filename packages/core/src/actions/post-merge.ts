import type { CapturedPost } from './capture-envelope'

/**
 * Merge what the page read with what X's embed backend answered (Plan 25).
 * The endpoint wins for structure — exact timestamp, full-size media, the
 * quoted post, canonical author — and the page wins for text whenever it
 * holds the full post and the endpoint only a preview (long-form posts,
 * which the endpoint truncates). A full text from either side ends the
 * truncation; otherwise the longer prefix survives, still marked truncated.
 */
export function mergePost(page: CapturedPost, remote: CapturedPost | null): CapturedPost {
  if (remote === null) {
    return page
  }
  const pageText = page.text?.trim() ? page.text : undefined
  const remoteText = remote.text?.trim() ? remote.text : undefined
  const pageFull = pageText !== undefined && page.truncated !== true
  const remoteFull = remoteText !== undefined && remote.truncated !== true

  let text: string | undefined
  let truncated: boolean
  if (remoteFull) {
    text = remoteText
    truncated = false
  } else if (pageFull) {
    text = pageText
    truncated = false
  } else {
    text = (remoteText?.length ?? 0) >= (pageText?.length ?? 0) ? remoteText : pageText
    truncated = text !== undefined || remote.truncated === true || page.truncated === true
  }

  const author = remote.author ?? page.author
  const postedAt = remote.postedAt ?? page.postedAt
  const media = remote.media !== undefined && remote.media.length > 0 ? remote.media : page.media
  const quoted = remote.quoted ?? page.quoted
  return {
    provider: page.provider,
    id: page.id,
    trigger: page.trigger,
    ...(author === undefined ? {} : { author }),
    ...(text === undefined ? {} : { text }),
    ...(truncated ? { truncated: true } : {}),
    ...(postedAt === undefined ? {} : { postedAt }),
    ...(media === undefined || media.length === 0 ? {} : { media }),
    ...(quoted === undefined ? {} : { quoted }),
  }
}
