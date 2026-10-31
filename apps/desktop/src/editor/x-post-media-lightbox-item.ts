import type { LightboxItem } from '@meowdown/react'
import type { XPostMedia } from '@post-embed/types'

export function lightboxItemFromXPostMedia(media: XPostMedia): LightboxItem {
  if (media.type === 'photo') {
    return { type: 'image', src: media.url, alt: media.alt }
  }
  return {
    type: 'video',
    sources: media.sources.map((source) => ({ src: source.url, type: source.type })),
    poster: media.poster,
    width: media.width,
    height: media.height,
    gif: media.type === 'gif',
  }
}
