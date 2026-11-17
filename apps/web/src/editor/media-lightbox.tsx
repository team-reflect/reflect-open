import { useCallback, type CSSProperties, type ReactElement } from 'react'
import { LightboxRoot, type LightboxController } from '@meowdown/react'
import { useChromeFullscreen } from '@/mobile/chrome/chrome-renderer.ts'
import { ImageLightboxContent } from '@/editor/image-lightbox-content.tsx'
import { VideoLightboxContent } from '@/editor/video-lightbox-content.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

// The mobile lightbox owns its background: drag-to-dismiss fades it to reveal
// the note behind.
const IMMERSIVE_STYLE = {
  '--meowdown-lightbox-backdrop': 'transparent',
  '--meowdown-lightbox-padding': '0',
} as CSSProperties

interface MediaLightboxProps {
  lightbox: LightboxController
  /** Opens the previewed image externally; null when it has no local file. */
  onOpenImage: (() => void) | null
}

function HideChrome(): null {
  useChromeFullscreen(true)
  return null
}

export function MediaLightbox({ lightbox, onOpenImage }: MediaLightboxProps): ReactElement {
  const { platform } = useCoreServices()
  const mobileSurface = platform.surface.mobileApp
  const { close } = lightbox
  const onClose = useCallback(() => close(), [close])

  return (
    <LightboxRoot lightbox={lightbox} style={mobileSurface ? IMMERSIVE_STYLE : undefined}>
      {(item) => (
        <>
          <HideChrome />
          {item.type === 'image' ? (
            <ImageLightboxContent
              item={item}
              mobileSurface={mobileSurface}
              onClose={onClose}
              onOpenImage={onOpenImage}
            />
          ) : (
            <VideoLightboxContent item={item} mobileSurface={mobileSurface} onClose={onClose} />
          )}
        </>
      )}
    </LightboxRoot>
  )
}
