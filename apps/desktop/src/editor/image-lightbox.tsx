import { useCallback, type CSSProperties, type ReactElement } from 'react'
import { LightboxImage, LightboxRoot, type LightboxController } from '@meowdown/react'
import { ExternalLinkIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useImageDismissDrag } from '@/editor/use-image-dismiss-drag'
import { isMobileSurface } from '@/lib/platform-surface'
import { cn } from '@/lib/utils'

// The mobile lightbox owns its background: drag-to-dismiss fades it to reveal
// the note behind.
const IMMERSIVE_STYLE = {
  '--meowdown-lightbox-backdrop': 'transparent',
  '--meowdown-lightbox-padding': '0',
} as CSSProperties

interface ImageLightboxProps {
  lightbox: LightboxController
  /** Opens the previewed image externally; null for a remote image. */
  onOpenImage: (() => void) | null
}

export function ImageLightbox({ lightbox, onOpenImage }: ImageLightboxProps): ReactElement {
  const mobileSurface = isMobileSurface()
  const { close } = lightbox
  const onClose = useCallback(() => close(), [close])
  const dismissDrag = useImageDismissDrag({
    active: lightbox.item !== null,
    enabled: mobileSurface,
    onClose,
  })

  return (
    <LightboxRoot lightbox={lightbox} style={mobileSurface ? IMMERSIVE_STYLE : undefined}>
      {(item) =>
        item.type === 'image' ? (
          <>
            {mobileSurface ? (
              <div
                aria-hidden
                className="absolute inset-0 bg-black"
                style={dismissDrag.backdropStyle}
              />
            ) : null}
            {mobileSurface ? (
              <div
                className="absolute top-[max(env(safe-area-inset-top),1rem)] left-[max(env(safe-area-inset-left),1rem)] z-10"
                style={dismissDrag.chromeStyle}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  aria-label="Close"
                  className="rounded-full bg-white/15 text-white shadow-sm backdrop-blur-xl hover:bg-white/25 active:bg-white/20"
                  onClick={onClose}
                >
                  <XIcon />
                </Button>
              </div>
            ) : null}
            {onOpenImage ? (
              <div
                className="absolute top-[max(env(safe-area-inset-top),1rem)] right-[max(env(safe-area-inset-right),1rem)] z-10"
                style={dismissDrag.chromeStyle}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-9 rounded-full bg-white/15 px-3 text-white shadow-sm backdrop-blur-xl hover:bg-white/25 active:bg-white/20"
                  onClick={onOpenImage}
                >
                  <ExternalLinkIcon data-icon="inline-start" />
                  Open
                </Button>
              </div>
            ) : null}
            <button
              type="button"
              aria-label="Close image preview"
              className={cn(
                'absolute inset-0 flex cursor-zoom-out items-center justify-center overflow-hidden bg-transparent',
                mobileSurface ? 'touch-none p-0' : 'p-6',
              )}
              {...dismissDrag.handlers}
            >
              <LightboxImage
                item={item}
                className="select-none"
                onTransitionEnd={dismissDrag.finishSettle}
                style={dismissDrag.imageStyle}
              />
            </button>
          </>
        ) : null
      }
    </LightboxRoot>
  )
}
