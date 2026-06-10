import type { ReactElement } from 'react'

interface ModelDownloadProgressProps {
  /** Bytes fetched so far, when an active download has reported them. */
  downloadedBytes?: number
  /** Bytes the download will fetch in total, reported alongside the above. */
  totalBytes?: number
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`
}

/**
 * The embedding-model download as a progress bar: determinate while the
 * runtime reports byte counts, an indeterminate shimmer in the unmeasured
 * moments around them (before the first progress event, and the model-load
 * phase after the last byte lands).
 */
export function ModelDownloadProgress({
  downloadedBytes,
  totalBytes,
}: ModelDownloadProgressProps): ReactElement {
  const fraction =
    downloadedBytes !== undefined && totalBytes !== undefined && totalBytes > 0
      ? Math.min(downloadedBytes / totalBytes, 1)
      : null
  const label =
    downloadedBytes !== undefined && totalBytes !== undefined && fraction !== null && fraction < 1
      ? `Downloading the model — ${formatMegabytes(downloadedBytes)} of ${formatMegabytes(totalBytes)}`
      : 'Preparing the model…'

  return (
    <div>
      <div
        role="progressbar"
        aria-label="Semantic search model download"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fraction !== null ? Math.round(fraction * 100) : undefined}
        className="h-1.5 overflow-hidden rounded-full bg-accent-soft"
      >
        {fraction !== null ? (
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-200"
            style={{ width: `${fraction * 100}%` }}
          />
        ) : (
          <div className="h-full w-full animate-pulse rounded-full bg-accent/40" />
        )}
      </div>
      <p className="mt-1.5 text-xs text-text-muted">{label}</p>
    </div>
  )
}
