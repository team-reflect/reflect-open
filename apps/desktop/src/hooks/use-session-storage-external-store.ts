import { useMemo, useSyncExternalStore } from 'react'
import { getSessionStorageStore } from '@/lib/storage'

/**
 * One sessionStorage key as React state, as the raw string it is stored as.
 * `null` means nothing is stored, or storage could not be read; passing
 * `null` to the setter removes the key.
 */
export function useSessionStorageExternalStore(
  key: string,
): [value: string | null, setValue: (value: string | null) => void] {
  const store = useMemo(() => getSessionStorageStore(key), [key])
  const value = useSyncExternalStore(store.subscribe, store.get, store.get)
  return [value, store.set]
}
