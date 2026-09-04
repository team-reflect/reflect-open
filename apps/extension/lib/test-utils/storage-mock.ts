/**
 * An in-memory `chrome.storage.local` faithful to the calls the extension
 * makes: `get(null | key | keys)`, `set(items)`, `remove(key | keys)`. Use
 * inside a `vi.mock('wxt/browser', …)` factory with a `vi.hoisted` map so
 * each test can inspect and reset the store directly.
 */
export function createStorageLocalMock(store: Map<string, unknown>) {
  return {
    get: (keys: string | string[] | null) => {
      if (keys === null) {
        return Promise.resolve(Object.fromEntries(store))
      }
      const wanted = Array.isArray(keys) ? keys : [keys]
      return Promise.resolve(
        Object.fromEntries(
          wanted.filter((key) => store.has(key)).map((key) => [key, store.get(key)]),
        ),
      )
    },
    set: (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) {
        store.set(key, value)
      }
      return Promise.resolve()
    },
    remove: (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        store.delete(key)
      }
      return Promise.resolve()
    },
  }
}
