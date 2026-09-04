import type { ReactElement } from 'react'
import type { GraphImportProgress, GraphImportSummary } from '@reflect/core'
import { DialogDescription } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import type { V1ImportState } from '@/providers/v1-import-provider'

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

/** Progress and outcome details for the workspace's durable import operation. */
export function V1ImportStatus({ state }: { state: V1ImportState }): ReactElement | null {
  switch (state.phase) {
    case 'idle':
      return null
    case 'running':
      return (
        <>
          <DialogDescription role="status">{stageText(state.progress)}</DialogDescription>
          <Progress value={stagePercent(state.progress) ?? null} />
        </>
      )
    case 'done':
      return <DialogDescription role="status">{summaryText(state.summary)}</DialogDescription>
    case 'failed':
      return <DialogDescription role="alert">{state.message}</DialogDescription>
  }
}
