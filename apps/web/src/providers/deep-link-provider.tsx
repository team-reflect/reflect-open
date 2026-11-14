import { useEffect, type ReactElement, type ReactNode } from 'react'
import { useGraphSession } from '@/providers/graph-provider.tsx'
import { useRouterActions } from '@/routing/router.tsx'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * Routes incoming `reflect://` URLs into the open graph session: has the
 * `DeepLinkRouter` serve this workspace, which replays anything
 * that arrived before a graph was open. No UI — outcomes surface as
 * navigation or a toast inside the service's handler.
 */

interface DeepLinkProviderProps {
  /**
   * Shows the results of a `reflect://search` link.
   */
  search: (query: string) => void
  children: ReactNode
}

export function DeepLinkProvider({ search, children }: DeepLinkProviderProps): ReactElement {
  const { navigate } = useRouterActions()
  const { deepLinkRouter, linkNavigation } = useAppServices()
  // Serve again for each graph session: the service acts on the session open
  // when `serve` is called.
  const session = useGraphSession()

  useEffect(() => {
    return deepLinkRouter.serve({
      navigate,
      search,
      beginNavigationIntent: () => linkNavigation.beginIntent(),
    })
  }, [deepLinkRouter, linkNavigation, navigate, search, session])

  return <>{children}</>
}
