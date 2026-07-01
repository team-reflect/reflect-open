import type { ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog'
import type { PendingLargeAttachment } from '@/editor/use-attachment-persistence'

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

interface LargeAttachmentDialogProps {
  /** The paused save, from `useAttachmentPersistence`; null renders nothing. */
  pending: PendingLargeAttachment | null
}

/**
 * Confirm before a large file joins the graph. The size itself is fine —
 * it's the user's disk — but git keeps every version of a binary forever and
 * GitHub rejects files over 100 MB, so the go-ahead is explicit. Dismissing
 * the dialog declines the save.
 */
export function LargeAttachmentDialog({
  pending = null,
}: LargeAttachmentDialogProps): ReactElement {
  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) {
          pending?.respond(false)
        }
      }}
    >
      <DialogContent>
        <DialogTitle>Add large file?</DialogTitle>
        <DialogDescription>
          {pending !== null
            ? `“${pending.file.name}” is ${formatMegabytes(pending.file.size)}. Large files stay in the graph's git history forever, and GitHub rejects files over 100 MB.`
            : ''}
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => pending?.respond(false)}>
            Cancel
          </Button>
          <Button onClick={() => pending?.respond(true)}>Add file</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
