import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createTestLoggerService } from '../testing/logger.ts'
import { createTestStorageService } from '../testing/storage.ts'
import { createWebStorageService, getJson, setJson } from './storage-service.ts'

function createStorage(entries: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(entries))
  const storage: Storage & { length: number } = {
    length: values.size,
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
      storage.length = values.size
    },
    removeItem: (key) => {
      values.delete(key)
      storage.length = values.size
    },
    clear: () => {
      values.clear()
      storage.length = 0
    },
  }
  return storage
}

describe('createWebStorageService', () => {
  it('reads, writes, and removes keys in the matching area', () => {
    const localStorage = createStorage({ key: 'local' })
    const sessionStorage = createStorage({ key: 'session' })
    const storage = createWebStorageService({
      logger: createTestLoggerService(),
      localStorage,
      sessionStorage,
    })

    expect(storage.local.get('key')).toBe('local')
    expect(storage.session.get('key')).toBe('session')

    storage.local.set('key', 'written')
    expect(localStorage.getItem('key')).toBe('written')
    expect(sessionStorage.getItem('key')).toBe('session')

    storage.session.set('key', null)
    expect(sessionStorage.getItem('key')).toBeNull()
    expect(storage.session.get('key')).toBeNull()
  })

  it('notifies the listeners of a key only when its value changes', () => {
    const storage = createWebStorageService({
      logger: createTestLoggerService(),
      localStorage: createStorage(),
      sessionStorage: null,
    })
    const listener = vi.fn()
    const other = vi.fn()
    const unsubscribe = storage.local.subscribe('key', listener)
    storage.local.subscribe('other', other)

    storage.local.set('key', 'written')
    storage.local.set('key', 'written')
    expect(listener).toHaveBeenCalledOnce()
    expect(other).not.toHaveBeenCalled()

    unsubscribe()
    storage.local.set('key', null)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('keeps values in memory when an area is missing', () => {
    const storage = createWebStorageService({
      logger: createTestLoggerService(),
      localStorage: null,
      sessionStorage: null,
    })

    expect(storage.session.get('key')).toBeNull()
    storage.session.set('key', 'written')
    expect(storage.session.get('key')).toBe('written')
  })

  it('degrades to memory with one warning when storage throws', () => {
    const localStorage = createStorage()
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const logger = createTestLoggerService()
    const storage = createWebStorageService({ logger, localStorage, sessionStorage: null })

    expect(storage.local.get('key')).toBeNull()
    expect(() => storage.local.set('key', 'written')).not.toThrow()
    expect(storage.local.get('key')).toBe('written')
    expect(logger.getWarnings()).toHaveLength(1)
  })
})

describe('getJson and setJson', () => {
  const schema = z.object({ value: z.string() })

  it('round-trips schema-validated JSON', () => {
    const storage = createTestStorageService()
    setJson(storage.local, 'key', schema, { value: 'stored' })
    expect(storage.dump().local).toEqual({ key: '{"value":"stored"}' })
    expect(getJson(storage.local, 'key', schema)).toEqual({ value: 'stored' })
  })

  it('returns undefined for missing, malformed, or invalid JSON', () => {
    const storage = createTestStorageService({ local: { malformed: '{', invalid: '{"value":1}' } })
    expect(getJson(storage.local, 'missing', schema)).toBeUndefined()
    expect(getJson(storage.local, 'malformed', schema)).toBeUndefined()
    expect(getJson(storage.local, 'invalid', schema)).toBeUndefined()
  })

  it('does not write a value that fails the schema', () => {
    const storage = createTestStorageService()
    setJson(storage.local, 'key', z.string().min(2), 'x')
    expect(storage.local.get('key')).toBeNull()
  })
})
