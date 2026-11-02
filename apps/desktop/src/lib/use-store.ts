import { deriveStore, type Store } from '@reflect/core'
import { useMemo, useSyncExternalStore } from 'react'

/**
 * The value of `store`, re-rendered when it changes.
 */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/**
 * `selector(store.get())`, re-rendered only when the selected value changes
 * (`Object.is`, or `isEqual` when given).
 *
 * `selector` and `isEqual` MUST be stable: module-level functions, or wrapped
 * in `useCallback`. Never pass an inline arrow. Each new function builds a new
 * derived store, which drops its cache and resubscribes on every render, and
 * a selector that returns a new object then re-renders the component every time.
 */
export function useSelector<T, U>(
  store: Store<T>,
  selector: (state: T) => U,
  isEqual?: (a: U, b: U) => boolean,
): U {
  const derivedStore: Store<U> = useMemo(() => {
    return deriveStore(store, selector, isEqual)
  }, [store, selector, isEqual])

  return useStore(derivedStore)
}
