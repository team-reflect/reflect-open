import type { Store } from '@reflect/core'
import { useSyncExternalStore } from 'react'

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

export function useSelector<T, U>(store: Store<T>, selector: (state: T) => U): U {
  const getSnapshot = () => selector(store.get())
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}
