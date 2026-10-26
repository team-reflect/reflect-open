import { createContext, use, type ReactElement, type ReactNode } from 'react'
import type { AppServices } from '@reflect/app'
import type { CoreServices, GraphServices } from '@reflect/core'

const CoreServicesContext = createContext<CoreServices | null>(null)
const AppServicesContext = createContext<AppServices | null>(null)
const GraphServicesContext = createContext<GraphServices | null>(null)

export function CoreServicesProvider({
  services,
  children,
}: {
  services: CoreServices
  children: ReactNode
}): ReactElement {
  return <CoreServicesContext value={services}>{children}</CoreServicesContext>
}

/**
 * Provides the app-layer services of this webview.
 */
export function AppServicesProvider({
  services,
  children,
}: {
  services: AppServices
  children: ReactNode
}): ReactElement {
  return <AppServicesContext value={services}>{children}</AppServicesContext>
}

export function GraphServicesProvider({
  services,
  children,
}: {
  services: GraphServices | null
  children: ReactNode
}): ReactElement {
  return <GraphServicesContext value={services}>{children}</GraphServicesContext>
}

/**
 * The {@link CoreServices} of the nearest `CoreServicesProvider`.
 */
export function useCoreServices(): CoreServices {
  const services = use(CoreServicesContext)
  if (services === null) {
    throw new Error('useCoreServices() must be called inside an <CoreServicesProvider>')
  }
  return services
}

/**
 * The {@link AppServices} of the nearest `AppServicesProvider`.
 */
export function useAppServices(): AppServices {
  const services = use(AppServicesContext)
  if (services === null) {
    throw new Error('useAppServices() must be called inside an <AppServicesProvider>')
  }
  return services
}

/**
 * The {@link GraphServices} of the open graph. Throws while no graph session is open; use `useMaybeGraphServices` where that can happen.
 */
export function useGraphServices(): GraphServices {
  const services = useMaybeGraphServices()
  if (services === null) {
    throw new Error(
      'useGraphServices() needs an open graph: no graph session is active (or no <GraphServicesProvider> is mounted above)',
    )
  }
  return services
}

/**
 * The {@link GraphServices} of the nearest `GraphServicesProvider`, or `null`
 * while no graph session is open.
 */
export function useMaybeGraphServices(): GraphServices | null {
  return use(GraphServicesContext)
}
