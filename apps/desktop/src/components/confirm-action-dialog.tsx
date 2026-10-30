import { useCallback, useRef, type ReactElement, type ReactNode } from 'react'
import { InlineAlert } from '@/components/inline-alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog.tsx'
import { useAsyncAction } from '@/hooks/use-async-action.ts'

interface ConfirmActionDialogProps {
  title: string
  description: ReactNode
  confirmLabel: string
  pendingLabel: string
  variant?: 'default' | 'destructive'
  /** An extra guard on confirm, e.g. a typed-name check. */
  confirmDisabled?: boolean
  /** Focus the confirm button on open instead of the dialog's default target. */
  focusConfirm?: boolean
  /** Rejects to show its message inline; resolves to close the dialog. */
  onConfirm: () => Promise<unknown>
  onClose: () => void
  /** Extra controls between the description and the error, e.g. a name input. */
  children?: (controls: { confirm: () => void; pending: boolean }) => ReactNode
}

/**
 * A confirm dialog whose confirm button runs an async action. Render it only
 * while open (`{open ? <ConfirmActionDialog … /> : null}`): each mount starts
 * with a clean pending/error state, so callers never reset anything. While
 * the action runs, the dialog can't be dismissed and both buttons are dead.
 */
export function ConfirmActionDialog({
  title,
  description,
  confirmLabel,
  pendingLabel,
  variant = 'default',
  confirmDisabled = false,
  focusConfirm = false,
  onConfirm,
  onClose,
  children,
}: ConfirmActionDialogProps): ReactElement {
  const { run, pending, error } = useAsyncAction()
  const confirmButtonRef = useRef<HTMLButtonElement>(null)

  const confirm = useCallback((): void => {
    if (confirmDisabled) {
      return
    }
    void run(async () => {
      await onConfirm()
      onClose()
    })
  }, [confirmDisabled, run, onConfirm, onClose])

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) {
          onClose()
        }
      }}
    >
      <DialogContent
        showCloseButton={!pending}
        initialFocus={focusConfirm ? confirmButtonRef : undefined}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="min-w-0">{description}</DialogDescription>
        {children?.({ confirm, pending })}
        {error !== null ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        <DialogFooter>
          <DialogClose
            render={
              <Button variant="ghost" disabled={pending}>
                Cancel
              </Button>
            }
          />
          <Button
            ref={confirmButtonRef}
            variant={variant}
            disabled={confirmDisabled || pending}
            onClick={confirm}
          >
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
