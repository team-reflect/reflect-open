import { type ReactElement } from 'react'
import { ExternalLinkIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LightboxDialog } from '@/editor/lightbox-dialog'
import { useImageDismissDrag } from '@/editor/use-image-dismiss-drag'
import { type LightboxTransitionItem } from '@/editor/use-lightbox-transition'
import { isMobileSurface } from '@/lib/platform-surface'
import { cn } from '@/lib/utils'

export const IMAGE_LIGHTBOX_TRANSITION_NAME = 'reflect-image-lightbox'

/** Image data rendered by the editor lightbox. */
export interface LightboxImage extends LightboxTransitionItem {
  /** Displayable URL, already resolved from the markdown `src`. */
  src: string
  alt: string
  /** Resolved image path to pass to `openImage`, or null for a remote image. */
  openPath: string | null
  /** Opener captured from the graph session that produced this preview. */
  openImage: ((path: string) => Promise<void> | void) | null
}

interface ImageLightboxProps {
  image: LightboxImage | null
  onClose: () => void
  onOpenImage?: (image: LightboxImage) => void
}

export function ImageLightbox({
  image,
  onClose,
  onOpenImage,
}: ImageLightboxProps): ReactElement | null {
  const mobileSurface = isMobileSurface()
  const dismissDrag = useImageDismissDrag({
    active: image !== null,
    enabled: mobileSurface,
    onClose,
  })

  if (image === null) {
    return null
  }
  const canOpenImage =
    image.openPath !== null && image.openImage !== null && onOpenImage !== undefined

  return (
    <LightboxDialog open title="Image preview" immersive={mobileSurface} onClose={onClose}>
      {mobileSurface ? (
        <div aria-hidden className="absolute inset-0 bg-black" style={dismissDrag.backdropStyle} />
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
      {canOpenImage ? (
        <div
          className="absolute top-[max(env(safe-area-inset-top),1rem)] right-[max(env(safe-area-inset-right),1rem)] z-10"
          style={dismissDrag.chromeStyle}
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              'shadow-sm',
              mobileSurface
                ? 'h-9 rounded-full bg-white/15 px-3 text-white backdrop-blur-xl hover:bg-white/25 active:bg-white/20'
                : 'bg-white/70 text-text hover:bg-white',
            )}
            onClick={() => onOpenImage(image)}
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
        <img
          src={image.src}
          alt={image.alt}
          draggable={false}
          className="h-full w-full select-none object-contain"
          onTransitionEnd={dismissDrag.finishSettle}
          style={{ ...dismissDrag.imageStyle, viewTransitionName: image.transitionName }}
        />
      </button>
    </LightboxDialog>
  )
}
