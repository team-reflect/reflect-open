import type { LinkClickHandler } from '@meowdown/core'
import { openUrl } from '@tauri-apps/plugin-opener'

/**
 * Open a rendered Markdown link in the OS browser instead of letting the click
 * navigate the app's WebView frame. The static `MarkdownView` surfaces aren't
 * contenteditable, so an `<a href>` click would otherwise unload the whole app.
 */
export const openExternalLink: LinkClickHandler = ({ href, event }) => {
  event.preventDefault()
  if (/^https?:\/\//i.test(href)) {
    void openUrl(href)
  }
}
