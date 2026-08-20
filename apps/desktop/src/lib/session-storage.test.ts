import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStorage } from '@/test-utils/storage'
import { getSessionStorageStore, resetSessionStorageStores } from './session-storage'

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
