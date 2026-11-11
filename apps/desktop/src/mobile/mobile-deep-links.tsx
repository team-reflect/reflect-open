import { useEffect, type ReactElement, type ReactNode } from 'react'
import { DeepLinkProvider } from '@/providers/deep-link-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * In the Swift shell, takes the `reflect://` URLs that the system opens the
 * app with and routes them into the open graph. It renders inside the router
 * of the graph. Other hosts deliver no URLs to the mobile app, and render
 * the children only.
 */
export function MobileDeepLinks({ children }: { children: ReactNode }): ReactElement {
  const { deepLinkIntake, logger, platform } = useCoreServices()
  const enabled = platform.isSwiftMobile

  useEffect(() => {
    if (!enabled) {
      return
    }
    deepLinkIntake.startListener().catch((cause: unknown) => {
      logger.error('deep link listener failed to start:', cause)
    })
  }, [enabled, deepLinkIntake, logger])

  return enabled ? <DeepLinkProvider>{children}</DeepLinkProvider> : <>{children}</>
}
