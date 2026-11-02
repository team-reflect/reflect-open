import { useCallback } from 'react'
import { useStore } from '@/lib/use-store.ts'
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
  const set = useCallback(
    (value: string | null) => {
      session.set(key, value)
    },
    [session, key],
  )
  const value = useStore(session.store(key))
  return [value, set]
}
