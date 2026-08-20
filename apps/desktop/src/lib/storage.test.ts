import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLocalStorageStore, getSessionStorageStore, resetStorageStores } from './storage'

/**
 * The store's two jobs: hold one key's value in memory, and let every failure
 * storage can produce end as "nothing stored".
 */

function createStorage(entries: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(entries))
  return {
    get length() {
      return map.size
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
    removeItem: (key) => {
      map.delete(key)
    },
    clear: () => {
      map.clear()
    },
  }
}

const KEY = 'test-key'

let storage: Storage

beforeEach(() => {
  storage = createStorage()
  vi.stubGlobal('window', { localStorage: storage })
  resetStorageStores()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getLocalStorageStore', () => {
  it('hands out one store per key', () => {
    expect(getLocalStorageStore(KEY)).toBe(getLocalStorageStore(KEY))
    expect(getLocalStorageStore(KEY)).not.toBe(getLocalStorageStore('other-key'))
  })

  it('reads what is already stored', () => {
    storage.setItem(KEY, 'stored')
    expect(getLocalStorageStore(KEY).get()).toBe('stored')
  })

  it('reads null for a key with nothing under it', () => {
    expect(getLocalStorageStore(KEY).get()).toBeNull()
  })

  it('writes through and tells its subscribers', () => {
    const store = getLocalStorageStore(KEY)
    const listener = vi.fn()
    store.subscribe(listener)
    store.set('written')
    expect(storage.getItem(KEY)).toBe('written')
    expect(store.get()).toBe('written')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when the value does not change', () => {
    const store = getLocalStorageStore(KEY)
    const listener = vi.fn()
    store.subscribe(listener)
    store.set('same')
    store.set('same')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('removes the key when set to null', () => {
    const store = getLocalStorageStore(KEY)
    store.set('written')
    store.set(null)
    expect(storage.getItem(KEY)).toBeNull()
    expect(store.get()).toBeNull()
  })

  it('stops telling a listener that unsubscribed', () => {
    const store = getLocalStorageStore(KEY)
    const listener = vi.fn()
    store.subscribe(listener)()
    store.set('written')
    expect(listener).not.toHaveBeenCalled()
  })

  it('serves the value it already read, not what storage says later', () => {
    const store = getLocalStorageStore(KEY)
    expect(store.get()).toBeNull()
    // A store assumes it is the only writer of its key; this documents what
    // happens when that assumption is broken.
    storage.setItem(KEY, 'behind its back')
    expect(store.get()).toBeNull()
  })

  it('reads null when storage refuses, and says so once', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(getLocalStorageStore(KEY).get()).toBeNull()
    expect(error).toHaveBeenCalledOnce()
  })

  it('keeps its value when the write fails', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const store = getLocalStorageStore(KEY)
    expect(() => {
      store.set('written')
    }).not.toThrow()
    expect(error).toHaveBeenCalledOnce()
  })

  it('reads null with no window to read from', () => {
    vi.stubGlobal('window', undefined)
    const store = getLocalStorageStore(KEY)
    expect(store.get()).toBeNull()
    expect(() => {
      store.set('written')
    }).not.toThrow()
  })
})

describe('getSessionStorageStore', () => {
  it('reads from sessionStorage, under its own store per key', () => {
    const session = createStorage({ [KEY]: 'from session' })
    vi.stubGlobal('window', { localStorage: storage, sessionStorage: session })
    resetStorageStores()

    expect(getSessionStorageStore(KEY).get()).toBe('from session')
    expect(getSessionStorageStore(KEY)).not.toBe(getLocalStorageStore(KEY))
  })
})
