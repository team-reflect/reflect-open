import { useLayoutEffect, useMemo, useRef } from 'react'
import type { LinkNavigationHost } from '@reflect/app'
import { useLinkIntentGuard } from '@/lib/windows/use-link-intent-guard.ts'
import { useRouter } from '@/routing/router.tsx'

/**
 * What the calling component gives a link activation of `LinkNavigationService`:
 * the router's `navigate`, and the shared staleness guard
 * ({@link useLinkIntentGuard}).
 *
 * @param scopeKey optional surface-local navigation state that should also
 *   make a pending activation stale (for example, the daily stream's focused
 *   date, which can change without a router navigation).
 */
export function useLinkNavigationHost(scopeKey?: string | number | null): LinkNavigationHost {
  const { navigate } = useRouter()
  const beginLinkIntent = useLinkIntentGuard()
  const scopeKeyRef = useRef(scopeKey)

  useLayoutEffect(() => {
    scopeKeyRef.current = scopeKey
  }, [scopeKey])

  return useMemo(
    () => ({
      navigate,
      beginIntent: () => {
        const isStale = beginLinkIntent()
        const startedInScope = scopeKeyRef.current
        return () => isStale() || !Object.is(scopeKeyRef.current, startedInScope)
      },
    }),
    [beginLinkIntent, navigate],
  )
}
