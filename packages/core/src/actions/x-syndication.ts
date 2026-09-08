import { z } from 'zod'
import { isAppError } from '../errors'
import { captureJsonFetch } from '../graph/commands'
import { X_POST_ID } from './x-post'

export interface XText {
  text: string
  author?: { name: string; handle: string }
  truncated: boolean
}

const tweetSchema = z.object({
  id_str: z.string(),
  text: z.string(),
  display_text_range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
  user: z.object({ name: z.string(), screen_name: z.string() }).optional(),
  entities: z.object({ urls: z.array(z.object({ url: z.string().min(1), expanded_url: z.string() })).optional() }).optional(),
  truncated: z.boolean().optional(),
  note_tweet: z.unknown().optional(),
})
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }

/** Read only public post text from the bounded syndication response. */
export function parseXText(value: unknown, id: string): XText | null {
  const parsed = tweetSchema.safeParse(value)
  if (!parsed.success || parsed.data.id_str !== id) return null
  const tweet = parsed.data
  let truncated = tweet.truncated === true || tweet.note_tweet != null
  const points = Array.from(tweet.text)
  let text = tweet.text
  if (tweet.display_text_range) {
    const [start, end] = tweet.display_text_range
    if (start <= end && end <= points.length) text = points.slice(start, end).join('')
    else truncated = true
  }
  for (const entity of tweet.entities?.urls ?? []) text = text.replaceAll(entity.url, () => entity.expanded_url)
  text = text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity).trim()
  if (!text) return null
  const limited = Array.from(text)
  return {
    text: limited.slice(0, 20_000).join(''),
    ...(tweet.user ? { author: {
      name: Array.from(tweet.user.name).slice(0, 200).join(''),
      handle: Array.from(tweet.user.screen_name).slice(0, 100).join(''),
    } } : {}),
    truncated: truncated || limited.length > 20_000,
  }
}

/** Fetch a single text source; transient transport failures remain retryable. */
export async function fetchXText(id: string): Promise<XText | null> {
  if (!X_POST_ID.test(id)) throw new Error('invalid X post ID')
  // Matches react-tweet's public syndication token algorithm.
  const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/0+|\./g, '')
  const url = new URL('https://cdn.syndication.twimg.com/tweet-result')
  url.search = new URLSearchParams({ id, lang: 'en', token }).toString()
  let raw: string
  try {
    raw = await captureJsonFetch(url.href)
  } catch (cause) {
    if (isAppError(cause) && (cause.kind === 'notFound' || cause.kind === 'parse')) return null
    throw cause
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  return parseXText(value, id)
}
