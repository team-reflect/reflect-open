import { deriveStore, type Store } from '@reflect/core'
import { useCallback, useMemo, useSyncExternalStore } from 'react'

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

export function useSelector<T, U>(
  store: Store<T>,
  selector: (state: T) => U,
  isEqual?: (a: U, b: U) => boolean,
): U {
  // FIXME: use comment to indicate that "selector" and "isEqual" should be stable.

  const derivedStore: Store<U> = useMemo(() => {
    return deriveStore(store, selector, isEqual)
  }, [store, selector, isEqual])

  return useStore(derivedStore)
}
