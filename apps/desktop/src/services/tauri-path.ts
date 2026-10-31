import { homeDir, join } from '@tauri-apps/api/path'
import type { PathTransport } from '@reflect/core'

/**
 * Path building in the host platform's syntax through `@tauri-apps/api/path`.
 */
export function createTauriPathTransport(): PathTransport {
  return {
    join: (...parts) => join(...parts),
    homeDir: () => homeDir(),
  }
}
