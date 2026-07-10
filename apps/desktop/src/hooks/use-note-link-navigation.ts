import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import {
  isNewWindowClick,
  openRouteInNewWindow,
  type NewWindowClickEvent,
} from '@/lib/windows/open-in-new-window'
import {
  beginLinkNavigationIntent,
  isCurrentLinkNavigationIntent,
} from '@/lib/windows/link-navigation-intent'
import type { NoteRoute } from '@/routing/route'
import { useRouter } from '@/routing/router'

/** Open one concrete note from a link-like UI control. */
export type NoteLinkNavigation = (
  route: NoteRoute,
  event?: NewWindowClickEvent,
) => void

/**
 * Apply the app-wide note-link convention: a plain click navigates in the
 * current window, while ⌘/Ctrl-click opens the note in a secondary window.
 *
 * A native open can be declined (browser/mobile) or fail. In that case the
 * click falls back to ordinary in-window navigation, unless its host unmounted
 * or a newer navigation intent already moved the user elsewhere.
 *
 * @param scopeKey optional surface-local navigation state that should also
 *   invalidate a pending fallback (for example, the daily stream's focused
 *   date, which can change without a router navigation).
 */
export function useNoteLinkNavigation(scopeKey?: string | number | null): NoteLinkNavigation {
  const { navigate, navigationRevision } = useRouter()
  const mountedRef = useRef(false)
  const scopeKeyRef = useRef(scopeKey)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useLayoutEffect(() => {
    scopeKeyRef.current = scopeKey
  }, [scopeKey])

  return useCallback(
    (target, event) => {
      const intent = beginLinkNavigationIntent()
      if (!isNewWindowClick(event)) {
        navigate(target)
        return
      }

      const startedAtRevision = navigationRevision()
      const startedInScope = scopeKeyRef.current
      void openRouteInNewWindow(target).then((opened) => {
        if (
          opened ||
          !mountedRef.current ||
          !isCurrentLinkNavigationIntent(intent) ||
          navigationRevision() !== startedAtRevision ||
          !Object.is(scopeKeyRef.current, startedInScope)
        ) {
          return
        }
        navigate(target)
      })
    },
    [navigate, navigationRevision],
  )
}
