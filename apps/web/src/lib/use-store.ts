import { deriveStore, type Store } from '@reflect/core'
import { useMemo, useSyncExternalStore } from 'react'

/**
 * Returns the value of `store`, re-rendered when it changes.
 */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/**
 * Returns the value of a derived store, re-rendered only when the selected value changes.
 *
 * `selector` and `isEqual` must be stable: module-level functions, or wrapped in `useCallback`. Never pass an inline arrow.
 */
export function useSelector<T, U>(
  store: Store<T>,
  selector: (state: T) => U,
  isEqual?: (a: U, b: U) => boolean,
): U {
  const derivedStore: Store<U> = useMemo(
    () => deriveStore(store, selector, isEqual),
    [store, selector, isEqual],
  )

  return useStore(derivedStore)
}
