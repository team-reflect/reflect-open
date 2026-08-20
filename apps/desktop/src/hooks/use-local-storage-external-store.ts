import { useMemo, useSyncExternalStore } from 'react'
import { getLocalStorageStore } from '@/lib/local-storage'

/**
 * One localStorage key as React state, as the raw string it is stored as.
 * `null` means nothing is stored, or storage could not be read; passing
 * `null` to the setter removes the key.
 */
export function useLocalStorageExternalStore(
  key: string,
): [value: string | null, setValue: (value: string | null) => void] {
  const store = useMemo(() => getLocalStorageStore(key), [key])
  const value = useSyncExternalStore(store.subscribe, store.get, store.get)
  return [value, store.set]
}
