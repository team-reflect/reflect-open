import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLocalStorageStore, resetLocalStorageStores } from './local-storage'

function createStorage(entries: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(entries))
  return {
    get length() {
      return values.size
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
    clear: () => {
      values.clear()
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('window', { localStorage: createStorage({ key: 'local' }) })
  resetLocalStorageStores()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getLocalStorageStore', () => {
  it('shares one store per key and reads localStorage', () => {
    expect(getLocalStorageStore('key').get()).toBe('local')
    expect(getLocalStorageStore('key')).toBe(getLocalStorageStore('key'))
    expect(getLocalStorageStore('key')).not.toBe(getLocalStorageStore('other'))
  })

  it('returns an empty store when localStorage is unavailable', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('SecurityError')
      },
    })
    resetLocalStorageStores()

    expect(getLocalStorageStore('key').get()).toBeNull()
    expect(error).toHaveBeenCalledOnce()
  })
})
