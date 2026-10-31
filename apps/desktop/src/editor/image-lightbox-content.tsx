import type { ReactElement } from 'react'
import { LightboxImage, type LightboxImageItem } from '@meowdown/react'
import { ExternalLinkIcon, XIcon } from 'lucide-react'
import { LightboxChromeButton } from '@/editor/lightbox-chrome-button.tsx'
import { useImageDismissDrag } from '@/editor/use-image-dismiss-drag.ts'
import { cn } from '@/lib/utils.ts'

interface ImageLightboxContentProps {
  item: LightboxImageItem
  mobileSurface: boolean
  onClose: () => void
  onOpenImage: (() => void) | null
}

export function ImageLightboxContent({
  item,
  mobileSurface,
  onClose,
  onOpenImage,
}: ImageLightboxContentProps): ReactElement {
  const dismissDrag = useImageDismissDrag({ active: true, enabled: mobileSurface, onClose })

  return (
    <>
      {mobileSurface ? (
        <div
          ref={dismissDrag.backdropRef}
          aria-hidden
          className="absolute inset-0 bg-black"
          style={dismissDrag.backdropStyle}
        />
      ) : null}
      {mobileSurface ? (
        <LightboxChromeButton
          side="left"
          wrapperRef={dismissDrag.chromeRef}
          wrapperStyle={dismissDrag.chromeStyle}
          size="icon-lg"
          aria-label="Close"
          onClick={onClose}
        >
          <XIcon />
        </LightboxChromeButton>
      ) : null}
      {onOpenImage ? (
        <LightboxChromeButton
          side="right"
          wrapperRef={dismissDrag.chromeRef}
          wrapperStyle={dismissDrag.chromeStyle}
          size="sm"
          className="h-9 px-3"
          onClick={onOpenImage}
        >
          <ExternalLinkIcon data-icon="inline-start" />
          Open
        </LightboxChromeButton>
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
          ref={dismissDrag.imageRef}
          item={item}
          className="select-none"
          onTransitionEnd={dismissDrag.finishSettle}
          style={dismissDrag.imageStyle}
        />
      </button>
    </>
  )
}
