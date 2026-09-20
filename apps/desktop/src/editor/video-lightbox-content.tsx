import type { ReactElement } from 'react'
import { LightboxVideo, type LightboxVideoItem } from '@meowdown/react'
import { XIcon } from 'lucide-react'
import { LightboxChromeButton } from '@/editor/lightbox-chrome-button'
import { cn } from '@/lib/utils'

interface VideoLightboxContentProps {
  item: LightboxVideoItem
  mobileSurface: boolean
  onClose: () => void
}

export function VideoLightboxContent({
  item,
  mobileSurface,
  onClose,
}: VideoLightboxContentProps): ReactElement {
  return (
    // Clicking the dark area around the player closes; clicking the player
    // reaches its controls.
    <div
      className={cn(
        'absolute inset-0 flex items-center justify-center overflow-hidden',
        mobileSurface ? 'bg-black p-0' : 'p-6',
      )}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <LightboxChromeButton side="left" size="icon-lg" aria-label="Close" onClick={onClose}>
        <XIcon />
      </LightboxChromeButton>
      <LightboxVideo item={item} />
    </div>
  )
}
