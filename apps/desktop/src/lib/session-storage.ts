import { StorageStore } from '@/lib/storage'

const sessionStorageStores = new Map<string, StorageStore>()

/** The sessionStorage store for `key`, created on first use and shared from then on. */
export function getSessionStorageStore(key: string): StorageStore {
  const existing = sessionStorageStores.get(key)
  if (existing !== undefined) {
    return existing
  }
  let storage: Storage | null = null
  if (typeof window !== 'undefined') {
    try {
      storage = window.sessionStorage
    } catch (error) {
      console.error('reaching sessionStorage failed', error)
    }
  }
  const store = new StorageStore(key, storage)
  sessionStorageStores.set(key, store)
  return store
}

/** Test seam: forget every session store so the next read reaches sessionStorage. */
export function resetSessionStorageStores(): void {
  sessionStorageStores.clear()
}
