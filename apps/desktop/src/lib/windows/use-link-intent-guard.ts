import { useCallback, useEffect, useRef } from 'react'
import {
  beginLinkNavigationIntent,
  isCurrentLinkNavigationIntent,
} from '@/lib/windows/link-navigation-intent'
import { useNavigationRevision } from '@/routing/router'

/** Start one link activation; the returned probe answers "did it go stale?". */
export type BeginLinkIntent = () => () => boolean

/**
 * The shared staleness guard behind every deferred link action — a declined
 * new-window open falling back in-window, a wiki resolution navigating after
 * its index round trip. An activation is stale once any of these happened
 * since it began:
 *
 * - its host component unmounted (the user already left the surface),
 * - a newer link activation superseded it (the app-wide intent token moved),
 * - the router's navigation revision advanced (any navigate/back/forward,
 *   even one that re-arrived on the same route).
 *
 * Callers begin the intent synchronously in the activation handler — even for
 * plain clicks, so a new activation supersedes older pending ones — and probe
 * staleness after each await before acting on the result.
 *
 * Reads the nullable revision getter on purpose: low-level rendered-link
 * hosts (markdown previews in standalone test harnesses) render outside a
 * full router, where the unmount and intent-token legs still guard correctly.
 */
export function useLinkIntentGuard(): BeginLinkIntent {
  const navigationRevision = useNavigationRevision()

  const unmountedRef = useRef(false)
  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
    }
  }, [])

  return useCallback(() => {
    const intent = beginLinkNavigationIntent()
    const startedAtRevision = navigationRevision?.() ?? null
    return () =>
      unmountedRef.current ||
      !isCurrentLinkNavigationIntent(intent) ||
      (navigationRevision !== null && navigationRevision() !== startedAtRevision)
  }, [navigationRevision])
}
