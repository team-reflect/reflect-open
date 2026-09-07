import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStorage } from '@/test-utils/storage'
import { getLocalStorageStore, resetLocalStorageStores } from './local-storage'

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
