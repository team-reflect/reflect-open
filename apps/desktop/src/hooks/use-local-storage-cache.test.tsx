import { z } from 'zod'
import { renderHook } from 'vitest-browser-react'
import { beforeEach, describe, expect, it } from 'vitest'
import { CACHE_KEY_PREFIX, useLocalStorageCache } from '@/hooks/use-local-storage-cache'
import { resetLocalStorageStores } from '@/lib/local-storage'
import { useLocalStorageExternalStore } from '@/hooks/use-local-storage-external-store'

/**
 * The contract every caller leans on: an entry the schema cannot vouch for
 * reads as `null`, and no two hook instances of one key can disagree.
 */

const schema = z.object({ name: z.string() })
const KEY = 'test-cache'

beforeEach(() => {
  localStorage.clear()
  resetLocalStorageStores()
})

describe('useLocalStorageCache', () => {
  it('reads back what it stored', async () => {
    const { result, act } = await renderHook(() => useLocalStorageCache(KEY, schema))
    expect(result.current[0]).toBeNull()
    await act(() => {
      result.current[1]({ name: 'reflect' })
    })
    expect(result.current[0]).toEqual({ name: 'reflect' })
  })

  it('drops the entry when set to null', async () => {
    const { result, act } = await renderHook(() => useLocalStorageCache(KEY, schema))
    await act(() => {
      result.current[1]({ name: 'reflect' })
    })
    await act(() => {
      result.current[1](null)
    })
    expect(result.current[0]).toBeNull()
  })

  it('answers null for an entry the schema rejects', async () => {
    const { result, act } = await renderHook(() => ({
      strict: useLocalStorageCache(KEY, schema),
      anything: useLocalStorageCache<unknown>(KEY, z.unknown()),
    }))
    await act(() => {
      result.current.anything[1]({ name: 42 })
    })
    expect(result.current.strict[0]).toBeNull()
  })

  it('answers null for an entry that is not JSON', async () => {
    const { result, act } = await renderHook(() => ({
      cache: useLocalStorageCache(KEY, schema),
      raw: useLocalStorageExternalStore(CACHE_KEY_PREFIX + KEY),
    }))
    await act(() => {
      result.current.raw[1]('{{')
    })
    expect(result.current.cache[0]).toBeNull()
  })

  it('refuses to store a value the schema rejects', async () => {
    const { result, act } = await renderHook(() => ({
      cache: useLocalStorageCache(KEY, schema),
      raw: useLocalStorageExternalStore(CACHE_KEY_PREFIX + KEY),
    }))
    await act(() => {
      // Only reachable from untyped code, which is exactly who would do it.
      result.current.cache[1]({ name: 42 } as unknown as { name: string })
    })
    expect(result.current.raw[0]).toBeNull()
  })

  it('keeps every instance of one key in agreement', async () => {
    const { result, act } = await renderHook(() => ({
      a: useLocalStorageCache(KEY, schema),
      b: useLocalStorageCache(KEY, schema),
    }))
    await act(() => {
      result.current.a[1]({ name: 'reflect' })
    })
    expect(result.current.b[0]).toEqual({ name: 'reflect' })
  })
})
