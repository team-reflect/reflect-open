import { useCallback } from 'react'
import { dispatchDeepLink } from '@/lib/deep-links/intake'
import { parseDeepLink } from '@/lib/deep-links/parse'
import {
  isNewWindowClick,
  openDeepLinkInNewWindow,
  type NewWindowClickEvent,
} from '@/lib/windows/open-in-new-window'
import { useLinkIntentGuard } from '@/lib/windows/use-link-intent-guard'

/** Follow one in-app `reflect://` link. */
export type FollowDeepLink = (href: string, event?: NewWindowClickEvent) => void

/**
 * Follow an in-app deep link, applying the note-link modifier convention to
 * address-like links while leaving capture links as writes in this window.
 * A failed window open falls back only while the shared link intent
 * ({@link useLinkIntentGuard}) is still current.
 */
export function useFollowDeepLink(): FollowDeepLink {
  const beginLinkIntent = useLinkIntentGuard()

  return useCallback(
    (href, event) => {
      const link = parseDeepLink(href)
      // A capture or rejected URL still dispatches so the graph-scoped handler
      // can write it or surface the error, but it cannot supersede navigation.
      if (link === null || link.kind === 'capture') {
        dispatchDeepLink(href)
        return
      }

      const isStale = beginLinkIntent()
      if (!isNewWindowClick(event)) {
        dispatchDeepLink(href)
        return
      }

      void (async () => {
        let opened = false
        try {
          opened = await openDeepLinkInNewWindow(href)
        } catch {
          // Treat a native open failure like a declined open and fall back below.
        }
        if (opened || isStale()) {
          return
        }
        dispatchDeepLink(href)
      })()
    },
    [beginLinkIntent],
  )
}
