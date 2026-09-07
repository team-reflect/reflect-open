export const X_ORIGINS = ['https://*.x.com/*', 'https://*.twitter.com/*']
export const X_SETTINGS_KEY = 'x-capture-settings'
export const X_CONTENT_SCRIPT = '/content-scripts/x-capture.js'

export interface XSettings {
  bookmarks: boolean
  likes: boolean
}

export const X_DEFAULT_SETTINGS: XSettings = { bookmarks: false, likes: false }

export function isXPage(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'https:' &&
      /^(?:(?:www|mobile)\.)?(?:x|twitter)\.com$/.test(parsed.hostname)
    )
  } catch {
    return false
  }
}
