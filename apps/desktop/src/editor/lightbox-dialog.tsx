import type { ReactElement, ReactNode } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

interface LightboxDialogProps {
  open: boolean
  title: string
  children: ReactNode
  onClose: () => void
  /**
   * Strip the dark scrim so the lightbox owns its background — mobile
   * drag-to-dismiss fades that background to reveal the note behind.
   */
  immersive?: boolean
}

/**
 * Full-window, chrome-free dialog shell for editor lightbox experiences.
 */
export function LightboxDialog({
  open,
  title,
  children,
  onClose,
  immersive = false,
}: LightboxDialogProps): ReactElement | null {
  if (!open) {
    return null
  }

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose()
        }
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        overlayClassName="bg-transparent backdrop-blur-0 supports-backdrop-filter:backdrop-blur-0"
        className={cn(
          'fixed inset-0 top-0 left-0 z-50 flex h-dvh w-dvw max-w-none translate-x-0 translate-y-0 items-center justify-center overflow-hidden rounded-none ring-0 outline-none sm:max-w-none',
          immersive ? 'bg-transparent p-0' : 'bg-black/80 p-6',
        )}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) {
            onClose()
          }
        }}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  )
}
