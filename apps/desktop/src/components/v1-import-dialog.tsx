import type { ReactElement } from 'react'
import type { GraphImportProgress, GraphImportSummary } from '@reflect/core'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import type { V1ImportState } from '@/providers/v1-import-provider'

interface V1ImportDialogProps {
  state: V1ImportState
  onCancel: () => void
  onDismiss: () => void
}

function count(quantity: number, singular: string, plural: string): string {
  return `${quantity} ${quantity === 1 ? singular : plural}`
}

/** The one-line result the dialog shows once an import completes. */
export function summaryText(summary: GraphImportSummary): string {
  const parts = [`${count(summary.importedFiles, 'file', 'files')} imported`]
  if (summary.mergedFiles > 0) {
    parts.push(`${count(summary.mergedFiles, 'daily note', 'daily notes')} merged`)
  }
  if (summary.renamedFiles > 0) {
    parts.push(`${summary.renamedFiles} renamed to avoid a name clash`)
  }
  if (summary.skippedFiles > 0) {
    parts.push(`${summary.skippedFiles} already present`)
  }
  if (summary.downloadedAssets > 0) {
    parts.push(`${count(summary.downloadedAssets, 'attachment', 'attachments')} downloaded`)
  }
  const text = `${parts.join(', ')}.`
  if (summary.failedAssetDownloads === 0) {
    return text
  }
  if (summary.failedAssetDownloads === 1) {
    return `${text} 1 attachment couldn't be downloaded and still links to Reflect V1.`
  }
  return `${text} ${summary.failedAssetDownloads} attachments couldn't be downloaded and still link to Reflect V1.`
}

function stageText(progress: GraphImportProgress | null): string {
  if (progress === null) {
    return 'Reading the export…'
  }
  if (progress.stage === 'downloading') {
    return `Downloading attachments… ${progress.done} of ${progress.total}`
  }
  return `Adding notes… ${progress.done} of ${progress.total}`
}

function stagePercent(progress: GraphImportProgress | null): number | undefined {
  if (progress === null || progress.total === 0) {
    return undefined
  }
  return Math.round((progress.done / progress.total) * 100)
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
            <DialogDescription role="status">{stageText(state.progress)}</DialogDescription>
            <Progress value={stagePercent(state.progress) ?? null} />
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
            <DialogDescription role="status">{summaryText(state.summary)}</DialogDescription>
            <DialogFooter>
              <Button onClick={onDismiss}>Done</Button>
            </DialogFooter>
          </>
        ) : null}
        {state.phase === 'failed' ? (
          <>
            <DialogTitle>Import failed</DialogTitle>
            <DialogDescription role="alert">{state.message}</DialogDescription>
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
