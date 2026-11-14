import { useCallback, useEffect, type ReactElement, type ReactNode } from 'react'
import { useAllSearch } from '@/mobile/all-search.tsx'
import { DeepLinkProvider } from '@/providers/deep-link-provider.tsx'
import { useRouterActions } from '@/routing/router.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * In the Swift shell, takes the `reflect://` URLs that the system opens the
 * app with and routes them into the open graph. It renders inside the router
 * of the graph. Other hosts deliver no URLs to the mobile app, and render
 * the children only. A search link lands on All with its query in the
 * search field, and adds no history entry of its own.
 */
export function MobileDeepLinks({ children }: { children: ReactNode }): ReactElement {
  const { deepLinkIntake, logger, platform } = useCoreServices()
  const enabled = platform.isSwiftMobile
  const [, setAllQuery] = useAllSearch()
  const { selectSection } = useRouterActions()
  const search = useCallback(
    (query: string): void => {
      setAllQuery(query)
      selectSection('all')
    },
    [setAllQuery, selectSection],
  )

  useEffect(() => {
    if (!enabled) {
      return
    }
    deepLinkIntake.startListener().catch((cause: unknown) => {
      logger.error('deep link listener failed to start:', cause)
    })
  }, [enabled, deepLinkIntake, logger])

  return enabled ? <DeepLinkProvider search={search}>{children}</DeepLinkProvider> : <>{children}</>
}
