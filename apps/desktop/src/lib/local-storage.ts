import { StorageStore } from '@/lib/storage'

const localStorageStores = new Map<string, StorageStore>()

/** The localStorage store for `key`, created on first use and shared from then on. */
export function getLocalStorageStore(key: string): StorageStore {
  const existing = localStorageStores.get(key)
  if (existing !== undefined) {
    return existing
  }
  let storage: Storage | null = null
  if (typeof window !== 'undefined') {
    try {
      storage = window.localStorage
    } catch (error) {
      console.error('reaching localStorage failed', error)
    }
  }
  const store = new StorageStore(key, storage)
  localStorageStores.set(key, store)
  return store
}

/** Test seam: forget every local store so the next read reaches localStorage. */
export function resetLocalStorageStores(): void {
  localStorageStores.clear()
}
