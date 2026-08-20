import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSessionStorageStore, resetSessionStorageStores } from './session-storage'

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
  vi.stubGlobal('window', { sessionStorage: createStorage({ key: 'session' }) })
  resetSessionStorageStores()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getSessionStorageStore', () => {
  it('shares one store per key and reads sessionStorage', () => {
    expect(getSessionStorageStore('key').get()).toBe('session')
    expect(getSessionStorageStore('key')).toBe(getSessionStorageStore('key'))
    expect(getSessionStorageStore('key')).not.toBe(getSessionStorageStore('other'))
  })

  it('returns an empty store when sessionStorage is unavailable', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('window', {
      get sessionStorage(): Storage {
        throw new Error('SecurityError')
      },
    })
    resetSessionStorageStores()

    expect(getSessionStorageStore('key').get()).toBeNull()
    expect(error).toHaveBeenCalledOnce()
  })
})
