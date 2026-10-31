import { useEffect, type ReactElement, type ReactNode } from 'react'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useRouter } from '@/routing/router.tsx'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * Routes incoming `reflect://` URLs into the open graph session: has the
 * `DeepLinkRouter` serve this workspace, which replays anything
 * that arrived before a graph was open. No UI — outcomes surface as
 * navigation or a toast inside the service's handler.
 */

interface DeepLinkProviderProps {
  children: ReactNode
}

export function DeepLinkProvider({ children }: DeepLinkProviderProps): ReactElement {
  const { navigate } = useRouter()
  const { deepLinkRouter, linkNavigation } = useAppServices()
  // Serve again for each graph session: the service acts on the session open
  // when `serve` is called.
  const { session } = useGraph()

  useEffect(() => {
    return deepLinkRouter.serve({
      navigate,
      beginNavigationIntent: () => linkNavigation.beginIntent(),
    })
  }, [deepLinkRouter, linkNavigation, navigate, session])

  return <>{children}</>
}
