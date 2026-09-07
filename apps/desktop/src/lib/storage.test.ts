import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createStorage } from '@/test-utils/storage'
import { StorageStore } from './storage'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('StorageStore', () => {
  it('reads, writes, removes, and notifies only when the value changes', () => {
    const storage = createStorage({ key: 'stored' })
    const store = new StorageStore('key', storage)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    expect(store.get()).toBe('stored')
    store.set('written')
    store.set('written')
    expect(storage.getItem('key')).toBe('written')
    expect(listener).toHaveBeenCalledOnce()

    unsubscribe()
    store.set(null)
    expect(storage.getItem('key')).toBeNull()
    expect(listener).toHaveBeenCalledOnce()
  })

  it('fails soft when storage reads or writes throw', () => {
    const storage = createStorage()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })

    const store = new StorageStore('key', storage)
    expect(store.get()).toBeNull()

    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => store.set('written')).not.toThrow()
    expect(store.get()).toBe('written')
    expect(error).toHaveBeenCalledTimes(2)
  })

  it('reads and writes schema-validated JSON', () => {
    const storage = createStorage()
    const store = new StorageStore('key', storage)
    const schema = z.object({ value: z.string() })

    store.setJson(schema, { value: 'stored' })
    expect(store.getJson(schema)).toEqual({ value: 'stored' })
    expect(new StorageStore('key', createStorage({ key: '{' })).getJson(schema)).toBeUndefined()
  })
})
