import type { ReactElement } from 'react'
import { createDeferredFeature } from '@/components/deferred-feature'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import type { V1ImportState } from '@/providers/v1-import-provider'

const V1ImportStatus = createDeferredFeature(
  async () => ({ default: (await import('./v1-import-status')).V1ImportStatus }),
  { name: 'import details' },
)

interface V1ImportDialogProps {
  state: V1ImportState
  onCancel: () => void
  onDismiss: () => void
}

/**
 * The modal face of a running Reflect V1 import. While the import runs the
 * dialog cannot be dismissed (there is nothing else to do in the graph until
 * it settles) — but it can be cancelled up until writing starts, because
 * nothing lands in the graph before then. Once finished it reports the
 * outcome and closes on demand.
 */
export function V1ImportDialog({ state, onCancel, onDismiss }: V1ImportDialogProps): ReactElement {
  const running = state.phase === 'running'
  // Cancelling mid-write would leave a half-imported graph; the native side
  // only honours cancellation before writes start, so the button goes with it.
  const cancellable = running && (state.progress === null || state.progress.stage === 'downloading')

  return (
    <Dialog
      open={state.phase !== 'idle'}
      onOpenChange={(next, eventDetails) => {
        if (next) {
          return
        }
        if (running || eventDetails.reason === 'outside-press') {
          eventDetails.cancel()
          return
        }
        onDismiss()
      }}
    >
      <DialogContent showCloseButton={false}>
        {state.phase === 'running' ? (
          <>
            <DialogTitle>Importing from Reflect V1</DialogTitle>
            <V1ImportStatus state={state} />
            {cancellable ? (
              <DialogFooter>
                <Button variant="ghost" disabled={state.cancelling} onClick={onCancel}>
                  {state.cancelling ? 'Cancelling…' : 'Cancel'}
                </Button>
              </DialogFooter>
            ) : null}
          </>
        ) : null}
        {state.phase === 'done' ? (
          <>
            <DialogTitle>Import complete</DialogTitle>
            <V1ImportStatus state={state} />
            <DialogFooter>
              <Button onClick={onDismiss}>Done</Button>
            </DialogFooter>
          </>
        ) : null}
        {state.phase === 'failed' ? (
          <>
            <DialogTitle>Import failed</DialogTitle>
            <V1ImportStatus state={state} />
            <DialogFooter>
              <Button variant="ghost" onClick={onDismiss}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
