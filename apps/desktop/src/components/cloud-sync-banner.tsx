import type { ReactElement } from 'react'

/** Human labels for the cloud-sync providers Rust detects under a graph root. */
const CLOUD_LABELS: Record<string, string> = {
  icloud: 'iCloud Drive',
  dropbox: 'Dropbox',
  googleDrive: 'Google Drive',
  oneDrive: 'OneDrive',
}

interface CloudSyncBannerProps {
  /** The detected provider id (`GraphInfo.cloudSync`); unknown ids show as-is. */
  provider: string
}

/**
 * Full-width warning strip shown when the open graph lives inside a
 * cloud-synced folder: Reflect syncs via GitHub, and a second sync layer can
 * corrupt the local index. Persistent (not dismissible) by design — the fix is
 * moving the folder, not hiding the banner.
 */
export function CloudSyncBanner({ provider }: CloudSyncBannerProps): ReactElement {
  const label = CLOUD_LABELS[provider] ?? provider
  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-6 py-2 text-xs text-amber-700 dark:text-amber-300">
      This graph is inside {label}. Reflect syncs via GitHub — a cloud-synced
      folder is unsupported and can corrupt the local index. Consider moving it to a
      non-synced location.
    </div>
  )
}
