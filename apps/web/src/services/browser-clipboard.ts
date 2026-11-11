import type { ClipboardService } from '@reflect/app'

class NavigatorClipboardServiceImpl implements ClipboardService {
  writeText(text: string): Promise<void> {
    return navigator.clipboard.writeText(text)
  }
}

/**
 * The web clipboard API, which the Tauri webview also provides.
 */
export function createNavigatorClipboardService(): ClipboardService {
  return new NavigatorClipboardServiceImpl()
}
