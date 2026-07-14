import { useCallback, useLayoutEffect, useRef } from 'react'
import {
  isNewWindowClick,
  openRouteInNewWindow,
  type NewWindowClickEvent,
} from '@/lib/windows/open-in-new-window'
import { useLinkIntentGuard } from '@/lib/windows/use-link-intent-guard'
import type { NoteRoute } from '@/routing/route'
import { useRouter } from '@/routing/router'

/** Open one concrete note from a link-like UI control. */
export type NoteLinkNavigation = (
  route: NoteRoute,
  event?: NewWindowClickEvent,
  /** Runs only when this window will navigate, immediately before the route change. */
  beforeInWindowNavigate?: () => void,
) => void

/**
 * Apply the app-wide note-link convention: a plain click navigates in the
 * current window, while ⌘/Ctrl-click opens the note in a secondary window.
 *
 * A native open can be declined (browser/mobile) or fail. In that case the
 * click falls back to ordinary in-window navigation, unless the shared link
 * intent went stale ({@link useLinkIntentGuard}) or the host surface changed
 * scope while the open was in flight.
 *
 * @param scopeKey optional surface-local navigation state that should also
 *   invalidate a pending fallback (for example, the daily stream's focused
 *   date, which can change without a router navigation).
 */
export function useNoteLinkNavigation(scopeKey?: string | number | null): NoteLinkNavigation {
  const { navigate } = useRouter()
  const beginLinkIntent = useLinkIntentGuard()
  const scopeKeyRef = useRef(scopeKey)

  useLayoutEffect(() => {
    scopeKeyRef.current = scopeKey
  }, [scopeKey])

  return useCallback(
    (target, event, beforeInWindowNavigate) => {
      const isStale = beginLinkIntent()
      if (!isNewWindowClick(event)) {
        beforeInWindowNavigate?.()
        navigate(target)
        return
      }

      const startedInScope = scopeKeyRef.current
      void (async () => {
        let opened = false
        try {
          opened = await openRouteInNewWindow(target)
        } catch {
          // Treat a native open failure like a declined open and fall back below.
        }
        if (opened || isStale() || !Object.is(scopeKeyRef.current, startedInScope)) {
          return
        }
        beforeInWindowNavigate?.()
        navigate(target)
      })()
    },
    [beginLinkIntent, navigate],
  )
}
