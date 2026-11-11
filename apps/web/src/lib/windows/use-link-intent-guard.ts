import { useCallback, useEffect, useRef } from 'react'
import { useAppServices } from '@/services/services-provider.tsx'

/** Start one link activation; the returned probe answers "did it go stale?". */
export type BeginLinkIntent = () => () => boolean

/**
 * The shared staleness guard behind every deferred link action — a declined
 * new-window open falling back in-window, a wiki resolution navigating after
 * its index round trip. An activation is stale once its host component
 * unmounted (the user already left the surface) or the service's intent
 * probe says so.
 *
 * Callers begin the intent synchronously in the activation handler — even for
 * plain clicks, so a new activation supersedes older pending ones — and probe
 * staleness after each await before acting on the result.
 */
export function useLinkIntentGuard(): BeginLinkIntent {
  const { linkNavigation } = useAppServices()

  const unmountedRef = useRef(false)
  useEffect(() => {
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
    }
  }, [])

  return useCallback(() => {
    const isStale = linkNavigation.beginIntent()
    return () => unmountedRef.current || isStale()
  }, [linkNavigation])
}
