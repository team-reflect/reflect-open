import type { CapturedPost } from './x-capture-messages'

type CapturedMedia = NonNullable<CapturedPost['media']>[number]

interface MediaPosition {
  slot: string
  unavailable: boolean
}
export type ProbeMediaCandidate = MediaPosition &
  (
    | { kind: 'image' | 'video'; url: string }
    | { kind: 'unsupported'; reason: 'hls-only' | 'no-source' }
  )

function selectVideo(
  media: Extract<CapturedMedia, { type: 'video' | 'gif' }>,
  slot: string,
): ProbeMediaCandidate {
  const position = { slot, unavailable: media.unavailable ?? false }
  const mp4 = media.sources
    .filter((source) => source.type === 'video/mp4')
    .sort((left, right) => (right.bitrate ?? 0) - (left.bitrate ?? 0))[0]
  if (mp4) return { ...position, kind: 'video', url: mp4.url }
  return {
    ...position,
    kind: 'unsupported',
    reason: media.sources.some((source) => source.type === 'application/x-mpegURL')
      ? 'hls-only'
      : 'no-source',
  }
}

/** Select avatars, photos, posters and one highest-bitrate MP4 per video/GIF. */
export function collectProbeMedia(post: CapturedPost): ProbeMediaCandidate[] {
  const candidates: ProbeMediaCandidate[] = []
  for (const [prefix, entry] of [
    ['post', post],
    ['quote', post.quote],
  ] as const) {
    if (!entry) continue
    if (entry.author.avatar) {
      candidates.push({
        slot: `${prefix}.avatar`,
        unavailable: false,
        kind: 'image',
        url: entry.author.avatar,
      })
    }
    for (const [index, media] of (entry.media ?? []).entries()) {
      const slot = `${prefix}.media.${index}`
      const unavailable = media.unavailable ?? false
      if (media.type === 'photo') {
        candidates.push({ slot, unavailable, kind: 'image', url: media.url })
      } else {
        if (media.poster) {
          candidates.push({ slot: `${slot}.poster`, unavailable, kind: 'image', url: media.poster })
        }
        candidates.push(selectVideo(media, slot))
      }
    }
  }
  return candidates
}

export interface MediaReadResult {
  mime: string
  bytes: number
  signature: number[]
}

function checkedMediaUrl(source: string, kind: 'image' | 'video'): string {
  let url: URL
  try {
    url = new URL(source)
  } catch {
    throw new Error('media-origin-not-allowed')
  }
  const hosts = kind === 'image' ? ['pbs.twimg.com', 'video.twimg.com'] : ['video.twimg.com']
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    !hosts.includes(url.hostname)
  )
    throw new Error('media-origin-not-allowed')
  return url.href
}

/** Consume an entire media stream within a diagnostic budget, retaining only its prefix. */
export async function probeMedia(
  source: string,
  kind: 'image' | 'video',
): Promise<MediaReadResult> {
  const url = checkedMediaUrl(source, kind)
  const signal = AbortSignal.timeout(120_000)
  let response: Response
  try {
    response = await fetch(url, { credentials: 'include', redirect: 'error', signal })
  } catch {
    throw new Error(signal.aborted ? 'probe-time-budget' : 'media-network-error')
  }
  const mime =
    (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  let failure: string | undefined
  if (!response.ok) failure = `media-http-${response.status}`
  else if (kind === 'video' ? mime !== 'video/mp4' : !mime.startsWith('image/')) {
    failure = 'unexpected-media-type'
  }
  if (failure) {
    await response.body?.cancel().catch(() => {})
    throw new Error(failure)
  }
  if (!response.body) throw new Error('empty-media-body')
  const reader = response.body.getReader()
  const prefix = new Uint8Array(32)
  let bytes = 0
  let prefixBytes = 0
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch {
        throw new Error(signal.aborted ? 'probe-time-budget' : 'media-stream-error')
      }
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 64 * 1024 * 1024) throw new Error('probe-size-budget')
      const take = Math.min(prefix.length - prefixBytes, chunk.value.byteLength)
      prefix.set(chunk.value.subarray(0, take), prefixBytes)
      prefixBytes += take
    }
    if (bytes === 0) throw new Error('empty-media-body')
    return { mime, bytes, signature: Array.from(prefix.subarray(0, prefixBytes)) }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
