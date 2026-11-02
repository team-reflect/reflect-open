import type { Store } from '@reflect/core'
import { useCallback, useSyncExternalStore } from 'react'

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

export function useSelector<T, U>(store: Store<T>, selector: (state: T) => U): U {
  // FIXME: use comment to indicate that selector should be stable.
  const getSnapshot = useCallback(() => selector(store.get()), [store, selector])
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}
