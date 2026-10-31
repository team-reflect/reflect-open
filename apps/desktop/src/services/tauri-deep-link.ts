import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import type { DeepLinkSource } from '@reflect/core'

/**
 * `reflect://` delivery through `@tauri-apps/plugin-deep-link`.
 */
export function createTauriDeepLinkSource(): DeepLinkSource {
  return {
    onOpenUrl: (listener) => onOpenUrl(listener),
    getCurrent: () => getCurrent(),
  }
}
