import { z } from 'zod'

/**
 * oEmbed policy for link capture: which capture URLs have an oEmbed answer
 * worth asking for, where to ask, and what a valid answer looks like. The
 * Rust `capture_oembed_fetch` primitive only bounds the transport (https,
 * JSON, a small byte cap, no redirects); everything provider-shaped lives
 * here, so supporting another provider is a TypeScript-only change: one more
 * entry in `OEMBED_PROVIDERS`.
 */

interface OEmbedProvider {
  /** Does this capture URL address one resource the provider can describe? */
  matches: (url: URL) => boolean
  /** The provider's oEmbed endpoint, before the `url`/`format` params. */
  endpoint: string
}

function isYouTubeHost(host: string): boolean {
  return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')
}

/**
 * Id-safe characters only. The endpoint is the authority on real ids: a shape
 * this misses skips the shortcut, and junk that slips through answers 400 and
 * falls back, so the check stays permissive.
 */
const YOUTUBE_VIDEO_ID = /^[\w-]+$/

/**
 * YouTube watch pages bury `<title>` and the `og:` tags ~700 KB into ~1.2 MB
 * of identity-encoded HTML, so the HTML scrape must pull the whole page to
 * read them; the oEmbed answer carries the exact title in ~1 KB.
 */
const youtube: OEmbedProvider = {
  matches: (url) => {
    if (!isYouTubeHost(url.hostname)) {
      return false
    }
    if (url.hostname === 'youtu.be') {
      return YOUTUBE_VIDEO_ID.test(url.pathname.slice(1))
    }
    if (url.pathname === '/watch') {
      return YOUTUBE_VIDEO_ID.test(url.searchParams.get('v') ?? '')
    }
    const prefixed = /^\/(?:shorts|live|embed)\/([^/]+)$/.exec(url.pathname)
    return prefixed !== null && YOUTUBE_VIDEO_ID.test(prefixed[1]!)
  },
  endpoint: 'https://www.youtube.com/oembed',
}

const OEMBED_PROVIDERS: readonly OEmbedProvider[] = [youtube]

/**
 * The oEmbed request URL for a capture URL, or `null` when no registered
 * provider claims it. The capture URL rides along URL-encoded, exactly as
 * shared (no canonicalization: the endpoints resolve short links, mobile
 * hosts, and junk params themselves).
 */
export function oembedRequestURL(captureURL: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(captureURL)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null
  }
  const provider = OEMBED_PROVIDERS.find((candidate) => candidate.matches(parsed))
  if (provider === undefined) {
    return null
  }
  const request = new URL(provider.endpoint)
  request.searchParams.set('url', captureURL)
  request.searchParams.set('format', 'json')
  return request.href
}

const oembedAnswerSchema = z.object({
  title: z.string(),
  provider_name: z.string().optional(),
})

/** The fields of an oEmbed answer the capture pipeline consumes. */
export interface OEmbedAnswer {
  title: string
  /** `provider_name`, the `og:site_name` analogue (`"YouTube"`). */
  providerName: string | null
}

/** Parse one oEmbed answer's JSON text, or `null` when it is not one. */
export function parseOEmbedAnswer(json: string): OEmbedAnswer | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  const parsed = oembedAnswerSchema.safeParse(raw)
  if (!parsed.success) {
    return null
  }
  return { title: parsed.data.title, providerName: parsed.data.provider_name ?? null }
}
