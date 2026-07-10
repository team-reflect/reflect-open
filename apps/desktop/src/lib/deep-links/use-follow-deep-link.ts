import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { dispatchDeepLink } from '@/lib/deep-links/intake'
import {
  isNewWindowClick,
  openDeepLinkInNewWindow,
  type NewWindowClickEvent,
} from '@/lib/windows/open-in-new-window'
import {
  beginLinkNavigationIntent,
  isCurrentLinkNavigationIntent,
} from '@/lib/windows/link-navigation-intent'
import { useNavigationRevision } from '@/routing/router'

/** Follow one validated `reflect://` link. */
export type FollowDeepLink = (href: string, event?: NewWindowClickEvent) => void

/**
 * Follow an in-app deep link, applying the note-link modifier convention to
 * address-like links while leaving capture links as writes in this window.
 * A failed window open falls back only while its host and router intent are
 * still current.
 */
export function useFollowDeepLink(): FollowDeepLink {
  const navigationRevision = useNavigationRevision()
  const navigationRevisionRef = useRef(navigationRevision)
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useLayoutEffect(() => {
    navigationRevisionRef.current = navigationRevision
  }, [navigationRevision])

  return useCallback(
    (href, event) => {
      const intent = beginLinkNavigationIntent()
      if (!isNewWindowClick(event)) {
        dispatchDeepLink(href)
        return
      }

      const revision = navigationRevisionRef.current
      const startedAtRevision = revision?.() ?? null
      void openDeepLinkInNewWindow(href).then((opened) => {
        if (
          opened ||
          !mountedRef.current ||
          !isCurrentLinkNavigationIntent(intent) ||
          navigationRevisionRef.current !== revision ||
          (revision !== null && revision() !== startedAtRevision)
        ) {
          return
        }
        dispatchDeepLink(href)
      })
    },
    [],
  )
}
