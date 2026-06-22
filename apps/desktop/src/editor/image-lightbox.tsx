import { type ReactElement } from 'react'
import { ExternalLinkIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LightboxDialog } from '@/editor/lightbox-dialog'
import { type LightboxTransitionItem } from '@/editor/use-lightbox-transition'

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
  if (image === null) {
    return null
  }
  const canOpenImage =
    image.openPath !== null && image.openImage !== null && onOpenImage !== undefined

  return (
    <LightboxDialog open title="Image preview" onClose={onClose}>
      {canOpenImage ? (
        <div className="absolute top-4 right-4 z-10">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="bg-white/70 text-text hover:bg-white"
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
        className="flex h-full w-full cursor-zoom-out items-center justify-center overflow-hidden bg-transparent p-0"
        onClick={onClose}
      >
        <img
          src={image.src}
          alt={image.alt}
          draggable={false}
          className="h-full w-full select-none object-contain"
          style={{ viewTransitionName: image.transitionName }}
        />
      </button>
    </LightboxDialog>
  )
}
