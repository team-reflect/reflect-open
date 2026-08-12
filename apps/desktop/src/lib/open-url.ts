import { openUrl } from '@tauri-apps/plugin-opener'
import { errorMessage } from '@reflect/core'

/**
 * Fire-and-forget `openUrl` for sync UI handlers that have no use for the
 * promise. A rejection (no handler for the scheme, or the opener capability
 * denies it) is logged instead of becoming an unhandled rejection; callers
 * that surface failures in the UI call `openUrl` directly.
 */
export function openUrlSync(url: string): void {
  void openUrl(url).catch((cause: unknown) => {
    console.error(`failed to open ${url}:`, errorMessage(cause))
  })
}
