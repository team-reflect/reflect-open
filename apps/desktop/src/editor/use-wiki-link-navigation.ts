import { useCallback } from 'react'
import { useLinkNavigationHost } from '@/hooks/use-link-navigation-host.ts'
import { useAppServices } from '@/services/services-provider.tsx'

export type WikiLinkNavigation = (options: { target: string; openInNewWindow: boolean }) => void

/**
 * Navigation for a clicked `[[wiki link]]`. Calendar-valid ISO dates preserve
 * ordinary resolution precedence, then open their lazy daily route on a miss.
 * Every other writable title goes through the ambiguity-preserving index +
 * disk resolver before it opens or creates, so an indexed duplicate cannot
 * bypass the same guard used for an index miss. With `readOnly`, or with no
 * graph open, existing titles still use the read-only index resolver and
 * unresolved titles are a no-op.
 *
 * An `openInNewWindow` request (a ⌘-click or a spare-`mod` keyboard follow,
 * decided at the editor boundary from meowdown's `mod` flag) opens the
 * resolved target in a secondary note window instead, falling back to
 * in-window navigation whenever the surface can't (browser dev, mobile), so
 * the request never makes a link do nothing.
 *
 * Resolution is async, and the host pane can unmount or the user can act
 * again while it's in flight — a late navigate would yank the user somewhere
 * they've already left, so every navigation is gated on the shared link
 * intent (`useLinkIntentGuard`).
 *
 * @returns a stable click handler for the editor's wiki-link extension.
 */
export function useWikiLinkNavigation(options?: { readOnly?: boolean }): WikiLinkNavigation {
  const { linkNavigation } = useAppServices()
  const host = useLinkNavigationHost()
  const readOnly = options?.readOnly ?? false

  return useCallback(
    ({ target, openInNewWindow }) => {
      linkNavigation.followWikiLink({ target, openInNewWindow, readOnly }, host)
    },
    [host, linkNavigation, readOnly],
  )
}
