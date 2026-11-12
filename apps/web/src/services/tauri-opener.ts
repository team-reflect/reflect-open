import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import type { OpenerTransport } from '@reflect/app'

/**
 * URL and file manager handoff through `@tauri-apps/plugin-opener`.
 */
export function createTauriOpenerTransport(): OpenerTransport {
  return {
    openUrl: (url) => openUrl(url),
    revealItemInDir: (path) => revealItemInDir(path),
  }
}
