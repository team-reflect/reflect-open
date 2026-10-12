import { useCallback } from 'react'
import type { LinkClickHandler } from '@meowdown/core'
import { isOpenableExternalUrl } from '@/editor/open-external-link.ts'
import { openAssetOrReveal, resolveAssetOpenPath } from '@/editor/use-asset-persistence.ts'
import { useMarkdownLinkNavigation } from '@/editor/use-markdown-link-navigation.ts'
import { useNoteAttachments } from '@/editor/use-note-attachments.ts'
import { isDeepLinkUrl } from '@/lib/deep-links/parse.ts'
import { useFollowDeepLink } from '@/lib/deep-links/use-follow-deep-link.ts'
import { openUrlSync } from '@/lib/open-url.ts'

/**
 * The click policy for a rendered Markdown link, shared by every Markdown
 * surface. An attachment href opens through the generation-pinned asset
 * command, a `reflect://` link routes through the in-app deep-link pipeline,
 * any other URL with an allowed scheme goes to the OS opener, and a
 * scheme-less href is a note link that resolves from `sourcePath`.
 *
 * The handler always blocks the default action: a static `<a href>` click
 * would otherwise navigate the app's WebView frame and unload the app.
 *
 * @param generation the open graph's write generation, or `null` when no
 *   graph is open. Attachment and note links then do nothing.
 * @param sourcePath graph-relative path of the note the Markdown comes from,
 *   or `null` when it belongs to no note. Attachment and note links then do
 *   nothing.
 * @returns a handler that changes identity only with `generation` or
 *   `sourcePath`.
 */
export function useMarkdownLinkClick(
  generation: number | null,
  sourcePath: string | null,
): LinkClickHandler {
  const followDeepLink = useFollowDeepLink()
  const navigateNoteLink = useMarkdownLinkNavigation(generation, sourcePath ?? '')
  const { resolveAttachmentPath } = useNoteAttachments(generation, sourcePath ?? '')

  return useCallback<LinkClickHandler>(
    ({ href, event, mod }) => {
      event.preventDefault()
      if (generation !== null && sourcePath !== null) {
        const assetPath = resolveAssetOpenPath(href, resolveAttachmentPath)
        if (assetPath !== null) {
          void openAssetOrReveal(assetPath, generation)
          return
        }
      }
      if (isDeepLinkUrl(href)) {
        followDeepLink({ href, openInNewWindow: mod })
        return
      }
      if (isOpenableExternalUrl(href)) {
        openUrlSync(href)
        return
      }
      if (sourcePath !== null) {
        navigateNoteLink({ href, openInNewWindow: mod })
      }
    },
    [followDeepLink, generation, navigateNoteLink, resolveAttachmentPath, sourcePath],
  )
}
