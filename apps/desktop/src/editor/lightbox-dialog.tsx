import { type ReactElement, type ReactNode } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

interface LightboxDialogProps {
  open: boolean
  title: string
  children: ReactNode
  onClose: () => void
}

/**
 * Full-window, chrome-free dialog shell for editor lightbox experiences.
 */
export function LightboxDialog({
  open,
  title,
  children,
  onClose,
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
        overlayClassName="bg-white/80 backdrop-blur-0 supports-backdrop-filter:backdrop-blur-0"
        className="fixed inset-0 top-0 left-0 z-50 flex h-dvh w-dvw max-w-none translate-x-0 translate-y-0 items-center justify-center overflow-hidden rounded-none bg-white/90 p-6 ring-0 outline-none sm:max-w-none"
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
