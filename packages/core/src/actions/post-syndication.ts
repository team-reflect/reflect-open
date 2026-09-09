import { z } from 'zod'
import { toAppError } from '../errors'
import { captureJsonFetch } from '../graph/commands'
import type { CapturedPost, PostMedia, QuotedPost } from './capture-envelope'
import { postPermalink } from './post-url'

/**
 * X's embed backend as a post source (Plan 25): the endpoint behind X's own
 * `publish.x.com` embeds and Vercel's `react-tweet`. Undocumented, but
 * unauthenticated, cookie-free, and the `token` is a pure function of the
 * post id. This module owns the policy — request URL, the answer subset we
 * consume, the permanent-vs-transient outcome mapping — and the Rust side
 * only bounds the transport (`capture_json_fetch`: https, JSON, a small byte
 * cap, no redirects). The privacy gate runs before any call here.
 */

const SYNDICATION_ENDPOINT = 'https://cdn.syndication.twimg.com/tweet-result'

/** The feature flags `react-tweet` sends; the answer shape depends on them. */
const FEATURES = [
  'tfw_timeline_list:',
  'tfw_follower_count_sunset:true',
  'tfw_tweet_edit_backend:on',
  'tfw_refsrc_session:on',
  'tfw_fosnr_soft_interventions_enabled:on',
  'tfw_show_birdwatch_pivots_enabled:on',
  'tfw_show_business_verified_badge:on',
  'tfw_duplicate_scribes_to_settings:on',
  'tfw_use_profile_image_shape_enabled:on',
  'tfw_show_blue_verified_badge:on',
  'tfw_legacy_timeline_sunset:true',
  'tfw_show_gov_verified_badge:on',
  'tfw_show_business_affiliate_badge:on',
  'tfw_tweet_edit_frontend:on',
].join(';')

/** The endpoint's anti-abuse token: `(id / 1e15 * π)` in base 36, zeros and the dot stripped. */
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replaceAll(/0+|\./g, '')
}

/** The request URL for a post id. */
export function syndicationRequestUrl(id: string): string {
  const url = new URL(SYNDICATION_ENDPOINT)
  url.searchParams.set('id', id)
  url.searchParams.set('lang', 'en')
  url.searchParams.set('features', FEATURES)
  url.searchParams.set('token', syndicationToken(id))
  return url.href
}

const userSchema = z.object({ name: z.string(), screen_name: z.string() })

const urlEntitySchema = z.object({
  url: z.string(),
  expanded_url: z.string().optional(),
  display_url: z.string().optional(),
})

const mediaDetailSchema = z.object({
  type: z.string(),
  media_url_https: z.string(),
  ext_alt_text: z.string().optional(),
})

const postBaseSchema = z.object({
  id_str: z.string(),
  text: z.string().optional(),
  display_text_range: z.tuple([z.number(), z.number()]).optional(),
  entities: z.object({ urls: z.array(urlEntitySchema).optional() }).optional(),
  user: userSchema.optional(),
  created_at: z.string().optional(),
  note_tweet: z.object({ id: z.string() }).optional(),
  mediaDetails: z.array(mediaDetailSchema).optional(),
})

/** The subset of the answer we read; everything else is ignored. */
export const syndicationAnswerSchema = z.union([
  z.object({ __typename: z.literal('TweetTombstone') }),
  postBaseSchema.extend({
    __typename: z.literal('Tweet').optional(),
    quoted_tweet: postBaseSchema.optional(),
  }),
])

export type SyndicationAnswer = z.infer<typeof syndicationAnswerSchema>
type SyndicatedPostBase = z.infer<typeof postBaseSchema>

/**
 * What the endpoint said about a post. `unavailable` is permanent for this
 * pass — deleted, protected/withheld (tombstone), or an answer we cannot
 * read — and leaves the page fields as the note.
 */
export type SyndicationOutcome = { kind: 'post'; post: CapturedPost } | { kind: 'unavailable' }

function unescapeHtml(text: string): string {
  return text
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
}

/**
 * The visible text: sliced to `display_text_range` (code points — the
 * range excludes leading reply mentions and the trailing media link), with
 * `t.co` links swapped for their expanded form and HTML entities decoded.
 */
export function syndicatedText(post: SyndicatedPostBase): string | undefined {
  if (post.text === undefined) {
    return undefined
  }
  let text = post.text
  if (post.display_text_range !== undefined) {
    const [start, end] = post.display_text_range
    text = Array.from(text).slice(start, end).join('')
  }
  for (const entity of post.entities?.urls ?? []) {
    if (entity.expanded_url !== undefined) {
      text = text.replaceAll(entity.url, entity.expanded_url)
    }
  }
  text = unescapeHtml(text).trim()
  return text === '' ? undefined : text
}

function isoDate(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** Full-size photo URL; the answer's bare `media_url_https` serves a medium rendition. */
function fullSizeUrl(url: string): string {
  return url.includes('?') ? url : `${url}?name=large`
}

function syndicatedMedia(post: SyndicatedPostBase): PostMedia[] | undefined {
  const media: PostMedia[] = []
  for (const detail of post.mediaDetails ?? []) {
    if (!detail.media_url_https.startsWith('https://')) {
      continue
    }
    const kind: PostMedia['kind'] | null =
      detail.type === 'photo'
        ? 'image'
        : detail.type === 'video'
          ? 'video'
          : detail.type === 'animated_gif'
            ? 'gif'
            : null
    if (kind === null) {
      continue
    }
    media.push({
      kind,
      url: kind === 'image' ? fullSizeUrl(detail.media_url_https) : detail.media_url_https,
      ...(detail.ext_alt_text ? { alt: detail.ext_alt_text.slice(0, 1000) } : {}),
    })
    if (media.length === 4) {
      break
    }
  }
  return media.length === 0 ? undefined : media
}

function syndicatedQuoted(quoted: SyndicatedPostBase | undefined): QuotedPost | undefined {
  if (quoted?.user === undefined) {
    return undefined
  }
  const text = syndicatedText(quoted)
  const postedAt = isoDate(quoted.created_at)
  return {
    id: quoted.id_str,
    url: postPermalink(quoted.id_str, quoted.user.screen_name),
    author: { name: quoted.user.name, handle: quoted.user.screen_name },
    ...(text === undefined ? {} : { text }),
    ...(postedAt === undefined ? {} : { postedAt }),
  }
}

/**
 * The captured-post view of an answer, or `null` for a tombstone. A
 * `note_tweet` marks a long-form post whose `text` is only the preview.
 */
export function postFromSyndication(
  answer: SyndicationAnswer,
  trigger: CapturedPost['trigger'],
): CapturedPost | null {
  if ('__typename' in answer && answer.__typename === 'TweetTombstone') {
    return null
  }
  const text = syndicatedText(answer)
  const postedAt = isoDate(answer.created_at)
  const media = syndicatedMedia(answer)
  const quoted = syndicatedQuoted(answer.quoted_tweet)
  return {
    provider: 'x',
    id: answer.id_str,
    trigger,
    ...(answer.user === undefined
      ? {}
      : { author: { name: answer.user.name, handle: answer.user.screen_name } }),
    ...(text === undefined ? {} : { text }),
    ...(answer.note_tweet === undefined ? {} : { truncated: true }),
    ...(postedAt === undefined ? {} : { postedAt }),
    ...(media === undefined ? {} : { media }),
    ...(quoted === undefined ? {} : { quoted }),
  }
}

/**
 * Fetch one post. Propagates transient failures (`network` — offline, a
 * 429, a 5xx) for the enrichment pass to retry; every other failure — a 404
 * (deleted), a non-JSON or unreadable answer, a tombstone — is permanent and
 * reads as `unavailable`.
 */
export async function fetchSyndicatedPost(
  id: string,
  trigger: CapturedPost['trigger'],
): Promise<SyndicationOutcome> {
  let json: string
  try {
    json = await captureJsonFetch(syndicationRequestUrl(id))
  } catch (cause) {
    if (toAppError(cause).kind === 'network') {
      throw cause
    }
    return { kind: 'unavailable' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return { kind: 'unavailable' }
  }
  const parsed = syndicationAnswerSchema.safeParse(raw)
  if (!parsed.success) {
    return { kind: 'unavailable' }
  }
  const post = postFromSyndication(parsed.data, trigger)
  return post === null ? { kind: 'unavailable' } : { kind: 'post', post }
}
