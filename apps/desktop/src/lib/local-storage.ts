import { pickStorage, StorageStore } from '@/lib/storage'

const localStorageStores = new Map<string, StorageStore>()

/** The localStorage store for `key`, created on first use and shared from then on. */
export function getLocalStorageStore(key: string): StorageStore {
  const existing = localStorageStores.get(key)
  if (existing !== undefined) {
    return existing
  }
  const store = new StorageStore(
    key,
    pickStorage(() => window.localStorage),
  )
  localStorageStores.set(key, store)
  return store
}

/** Test seam: forget every local store so the next read reaches localStorage. */
export function resetLocalStorageStores(): void {
  localStorageStores.clear()
}
