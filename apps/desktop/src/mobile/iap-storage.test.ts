import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACTIVE_SUBSCRIPTION_STORAGE_KEY,
  IAP_ENVIRONMENT_STORAGE_KEY,
  readActiveSubscriptionSeed,
  readIapEnvironmentSeed,
  writeActiveSubscriptionSeed,
  writeIapEnvironmentSeed,
} from './iap-storage'

function createStorage(): Storage {
  const values = new Map<string, string>()
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

let storage: Storage

beforeEach(() => {
  storage = createStorage()
  vi.stubGlobal('window', { localStorage: storage })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('IAP environment seed', () => {
  it('round-trips valid values including a normalized unknown channel', () => {
    writeIapEnvironmentSeed('Sandbox')
    expect(readIapEnvironmentSeed()).toBe('Sandbox')

    writeIapEnvironmentSeed(null)
    expect(readIapEnvironmentSeed()).toBeNull()
  })

  it('ignores missing, invalid JSON, and schema-invalid values', () => {
    expect(readIapEnvironmentSeed()).toBeUndefined()
    storage.setItem(IAP_ENVIRONMENT_STORAGE_KEY, '{')
    expect(readIapEnvironmentSeed()).toBeUndefined()
    storage.setItem(IAP_ENVIRONMENT_STORAGE_KEY, JSON.stringify('Moon'))
    expect(readIapEnvironmentSeed()).toBeUndefined()
  })
})

describe('active subscription seed', () => {
  it('round-trips a fresh validated envelope', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T00:00:00Z'))
    writeActiveSubscriptionSeed('yearly')
    expect(readActiveSubscriptionSeed()).toEqual({
      value: 'yearly',
      updatedAt: Date.now(),
    })
  })

  it('ignores expired and schema-invalid envelopes', () => {
    storage.setItem(
      ACTIVE_SUBSCRIPTION_STORAGE_KEY,
      JSON.stringify({ value: 'yearly', updatedAt: Date.now() - 3 * 24 * 60 * 60 * 1000 }),
    )
    expect(readActiveSubscriptionSeed()).toBeUndefined()
    storage.setItem(
      ACTIVE_SUBSCRIPTION_STORAGE_KEY,
      JSON.stringify({ value: 'weekly', updatedAt: Date.now() }),
    )
    expect(readActiveSubscriptionSeed()).toBeUndefined()
  })
})

describe('storage failures', () => {
  it('fails soft when localStorage is unavailable or throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('SecurityError')
      },
    })
    expect(readIapEnvironmentSeed()).toBeUndefined()
    expect(() => writeActiveSubscriptionSeed('monthly')).not.toThrow()

    vi.stubGlobal('window', { localStorage: storage })
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(readIapEnvironmentSeed()).toBeUndefined()
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => writeIapEnvironmentSeed('Production')).not.toThrow()
    expect(error).toHaveBeenCalledTimes(4)
  })
})
