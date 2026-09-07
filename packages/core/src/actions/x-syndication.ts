import { z } from 'zod'
import { isAppError } from '../errors'
import { captureJsonFetch } from '../graph/commands'
import { xPostSchema, type XPost } from './capture-envelope'

const postSchema = z.object({
  id_str: z.string().regex(/^\d{1,20}$/),
  text: z.string().optional(),
  display_text_range: z
    .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
    .optional(),
  entities: z
    .object({
      urls: z.array(z.object({ url: z.string(), expanded_url: z.string().optional() })).optional(),
    })
    .optional(),
  user: z.object({ name: z.string(), screen_name: z.string() }).optional(),
  note_tweet: z.unknown().optional(),
  mediaDetails: z
    .array(z.object({ media_url_https: z.url(), ext_alt_text: z.string().optional() }))
    .optional(),
})
const answerSchema = postSchema.extend({ quoted_tweet: postSchema.optional() })
type SyndicatedPost = z.infer<typeof postSchema>

function normalizedPost(post: SyndicatedPost, textLimit: number): Omit<XPost, 'images' | 'quote'> {
  let value = post.text ?? ''
  if (post.display_text_range) {
    value = Array.from(value)
      .slice(...post.display_text_range)
      .join('')
  }
  for (const entity of post.entities?.urls ?? []) {
    if (entity.expanded_url) value = value.replaceAll(entity.url, entity.expanded_url)
  }
  value = value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .trim()
  return {
    id: post.id_str,
    ...(post.user
      ? {
          author: {
            name: post.user.name.slice(0, 200),
            handle: post.user.screen_name.slice(0, 32),
          },
        }
      : {}),
    ...(value
      ? {
          text: {
            value: value.slice(0, textLimit).replace(/[\uD800-\uDBFF]$/, ''),
            complete: post.note_tweet === undefined && value.length <= textLimit,
          },
        }
      : {}),
  }
}

/** Read X's public embed response; unavailable posts keep the captured page snapshot. */
export async function fetchSyndicatedXPost(id: string): Promise<XPost | null> {
  const request = new URL('https://cdn.syndication.twimg.com/tweet-result')
  request.searchParams.set('id', id)
  request.searchParams.set('lang', 'en')
  request.searchParams.set(
    'token',
    ((Number(id) / 1e15) * Math.PI).toString(36).replaceAll(/0+|\./g, ''),
  )
  let json: string
  try {
    json = await captureJsonFetch(request.href)
  } catch (cause) {
    if (isAppError(cause) && (cause.kind === 'notFound' || cause.kind === 'parse')) return null
    throw cause
  }
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  const answer = answerSchema.safeParse(raw)
  if (!answer.success || answer.data.id_str !== id) return null
  const post = answer.data
  const images = (post.mediaDetails ?? [])
    .filter((image) => image.media_url_https.startsWith('https://'))
    .slice(0, 4)
    .map((image) => ({
      url: image.media_url_https,
      ...(image.ext_alt_text ? { alt: image.ext_alt_text.slice(0, 1000) } : {}),
    }))
  const parsed = xPostSchema.safeParse({
    ...normalizedPost(post, 20_000),
    ...(images.length > 0 ? { images } : {}),
    ...(post.quoted_tweet ? { quote: normalizedPost(post.quoted_tweet, 5000) } : {}),
  })
  return parsed.success ? parsed.data : null
}
