import { useCallback, useSyncExternalStore } from 'react'

interface ServiceStore {
  readonly subscribe: (listener: () => void) => () => void
}

/**
 * What `read` returns, re-rendered on every change `service` reports.
 * TODO: useServiceState will be replaced by useStore and useSelector once all services are migrated to Store.
 */
export function useServiceState<S>(service: ServiceStore, read: () => S): S {
  const subscribe = useCallback((listener: () => void) => service.subscribe(listener), [service])
  return useSyncExternalStore(subscribe, read, read)
}
