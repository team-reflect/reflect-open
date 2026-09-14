import { getXPostMediaUrls, mapXPostMediaUrls, type XPost, type XPostBase } from '@post-embed/types'
import { isValidUrl } from './schema'
import type { ArchiveResource, ArchivedXPost } from './types'

export function createArchivedPost(post: XPost, capturedAt: string, revision: string): ArchivedXPost {
  const resources = new Map<string, ArchiveResource>()
  function add(resource: ArchiveResource) {
    resources.set(resource.url, resource)
  }
  function select(entry: XPostBase): XPostBase {
    return { ...entry, ...(entry.media ? { media: entry.media.map((media) => {
      if (media.unavailable) {
        if (media.type === 'photo' && isValidUrl(media.url)) {
          add({ url: media.url, state: 'failed', error: 'source-missing' })
        }
        if (media.type !== 'photo') {
          for (const source of media.sources) if (isValidUrl(source.url)) {
            add({ url: source.url, state: 'failed', error: 'source-missing' })
          }
        }
        return media.type === 'photo' ? media : { ...media, sources: [] }
      }
      if (media.type === 'photo') return media
      const mp4 = media.sources.filter((source) =>
        source.type === 'video/mp4' && isValidUrl(source.url))
        .sort((left, right) => (right.bitrate ?? 0) - (left.bitrate ?? 0) ||
          left.url.localeCompare(right.url))[0]
      if (!mp4) {
        for (const source of media.sources) {
          if (source.type === 'application/x-mpegURL' && isValidUrl(source.url)) {
            add({ url: source.url, state: 'unsupported', error: 'unsupported-hls' })
          }
        }
      }
      return { ...media, sources: mp4 ? [mp4] : [] }
    }) } : {}) }
  }
  const selected = { ...post, ...select(post), ...(post.quote ? { quote: select(post.quote) } : {}) }
  const data = mapXPostMediaUrls(selected, (url) => isValidUrl(url) ? url : undefined)
  for (const url of getXPostMediaUrls(data)) {
    if (!resources.has(url)) add({ url, state: 'pending' })
  }
  return {
    kind: 'x-post', id: data.id, revision, capturedAt,
    textState: data.truncated ? 'partial' : 'complete',
    data, resources: [...resources.values()],
  }
}
export function mergeArchivedPost(previous: ArchivedXPost | undefined, incoming: ArchivedXPost): ArchivedXPost {
  if (!previous) return incoming
  if (previous.revision === incoming.revision) return previous
  if (previous.capturedAt > incoming.capturedAt) return previous
  if (previous.textState === 'complete' && incoming.textState !== 'complete') return previous
  const saved = new Map(previous.resources.map((resource) => [resource.url, resource]))
  return { ...previous, ...incoming, resources: incoming.resources.map((resource) => {
    const old = saved.get(resource.url)
    if (old?.state !== 'stored') return resource
    const clean = { ...old, ...resource, state: 'stored' as const }
    delete clean.error
    return clean
  }) }
}

