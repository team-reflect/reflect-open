import type { LinkClickHandler } from '@meowdown/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { dispatchDeepLink } from '@/lib/deep-links/intake'
import { isDeepLinkUrl } from '@/lib/deep-links/parse'

/**
 * Schemes that must never reach the OS opener: script and data URIs carry
 * executable content rather than an address, and `file:`/`blob:` open
 * arbitrary local content a synced or captured note could point at.
 */
const BLOCKED_SCHEMES: ReadonlySet<string> = new Set([
  'javascript',
  'vbscript',
  'data',
  'blob',
  'about',
  'file',
])

/**
 * Whether `href` is an absolute URL that may be handed to the OS opener.
 * Any app scheme qualifies (`https:`, `x-devonthink-item:`, `bear:`, …) —
 * the OS resolves the handler — but the blocked schemes and scheme-less
 * relative hrefs never do. The opener capability mirrors this policy
 * (`*://*` allowed, `file://*` denied) as the Rust-side backstop.
 */
export function isOpenableExternalUrl(href: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]
  return scheme !== undefined && !BLOCKED_SCHEMES.has(scheme.toLowerCase())
}

/**
 * Open a rendered Markdown link in its OS default app instead of letting the
 * click navigate the app's WebView frame. The static `MarkdownView` surfaces
 * aren't contenteditable, so an `<a href>` click would otherwise unload the
 * whole app. A `reflect://` link routes through the in-app deep-link pipeline
 * instead — the OS opener denies the scheme.
 */
export const openExternalLink: LinkClickHandler = ({ href, event }) => {
  event.preventDefault()
  if (isDeepLinkUrl(href)) {
    dispatchDeepLink(href)
    return
  }
  if (isOpenableExternalUrl(href)) {
    void openUrl(href)
  }
}
