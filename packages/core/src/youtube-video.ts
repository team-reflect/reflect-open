import { parseYouTubeVideo } from '@post-embed/schema'
import type { YouTubeVideo } from '@post-embed/types'
import { oembedRequestURL } from './actions/oembed.ts'
import { captureOEmbedFetch } from './graph/commands.ts'

/** The card snapshot for a YouTube video URL, or `null` when the URL is not one. */
export async function fetchYouTubeVideo(url: string): Promise<YouTubeVideo | null> {
  const requestURL = oembedRequestURL(url)
  if (requestURL === null) return null
  const answer: unknown = JSON.parse(await captureOEmbedFetch(requestURL))
  const result = parseYouTubeVideo(answer)
  if (result.issues) {
    throw new Error(`invalid oEmbed answer for ${url}: ${JSON.stringify(result.issues)}`)
  }
  return { ...result.value, url }
}
