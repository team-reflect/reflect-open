import { useCallback, useSyncExternalStore } from 'react'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * One sessionStorage key as React state, as the raw string it is stored as.
 * `null` means nothing is stored, or storage could not be read; passing
 * `null` to the setter removes the key.
 */
export function useSessionStorageExternalStore(
  key: string,
): [value: string | null, setValue: (value: string | null) => void] {
  const { storage } = useCoreServices()
  const session = storage.session
  const subscribe = useCallback(
    (listener: () => void) => session.subscribe(key, listener),
    [session, key],
  )
  const get = useCallback(() => session.get(key), [session, key])
  const set = useCallback(
    (value: string | null) => {
      session.set(key, value)
    },
    [session, key],
  )
  const value = useSyncExternalStore(subscribe, get, get)
  return [value, set]
}
