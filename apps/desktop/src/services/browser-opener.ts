import type { OpenerTransport } from '@reflect/app'

/**
 * Plain-browser dev opens URLs in a new tab and has no file manager.
 */
export function createBrowserOpenerTransport(): OpenerTransport {
  return {
    openUrl: (url) => {
      window.open(url, '_blank', 'noopener')
    },
    revealItemInDir: (path) => {
      throw new Error(`cannot reveal ${path}: the browser has no file manager`)
    },
  }
}
