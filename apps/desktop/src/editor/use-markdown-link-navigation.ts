import { useCallback } from 'react'
import { errorMessage, resolveExistingMarkdownTarget } from '@reflect/core'
import { reportAmbiguousNoteTitle } from '@/editor/ambiguous-note-feedback'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation'
import { startOperation } from '@/lib/operations'
import { useLinkIntentGuard } from '@/lib/windows/use-link-intent-guard'
import { routeForPath } from '@/routing/route'

/**
 * Navigation for a clicked Markdown note link (`[Plan](./Plan.md)`), the
 * counterpart of {@link useWikiLinkNavigation} for CommonMark hrefs. The href
 * resolves source-relative from `sourcePath` (vault-root for a leading `/`),
 * with the same branch shape as wiki links except that `missing` is a no-op:
 * an unqualified href has two candidate physical locations, so creation would
 * have to guess where the file belongs.
 */
export function useMarkdownLinkNavigation(
  generation: number | null,
  sourcePath: string,
): (options: { href: string; openInNewWindow: boolean }) => void {
  const navigateNoteLink = useNoteLinkNavigation()
  const beginLinkIntent = useLinkIntentGuard()

  return useCallback(
    ({ href, openInNewWindow }: { href: string; openInNewWindow: boolean }) => {
      if (generation === null) {
        return
      }
      const isStale = beginLinkIntent()
      void (async () => {
        try {
          const resolution = await resolveExistingMarkdownTarget(href, sourcePath, generation)
          if (isStale()) {
            return
          }
          if (resolution.kind === 'resolved') {
            navigateNoteLink({ target: routeForPath(resolution.path), openInNewWindow })
          } else if (resolution.kind === 'ambiguous') {
            reportAmbiguousNoteTitle('Opening link', href)
          } else if (resolution.kind === 'unavailable') {
            startOperation('Opening link').fail(
              `Couldn’t open “${href}” because a matching note is currently unavailable. Try again when it is available on this device.`,
            )
          }
        } catch (err) {
          console.error('markdown-link resolution failed:', err)
          startOperation('Opening link').fail(errorMessage(err))
        }
      })()
    },
    [beginLinkIntent, generation, navigateNoteLink, sourcePath],
  )
}
