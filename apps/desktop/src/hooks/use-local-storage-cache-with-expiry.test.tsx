import { renderHook } from 'vitest-browser-react'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLocalStorageCacheWithExpiry } from '@/hooks/use-local-storage-cache-with-expiry'
import { resetStorageStores } from '@/lib/storage'

/**
 * What the shelf life adds: a value that reads as `null` once it is too old,
 * including when it falls due while the app is still open.
 */

const schema = z.object({ name: z.string() })
const KEY = 'test-expiry'

const MINUTE_MS = 60_000

beforeEach(() => {
  localStorage.clear()
  resetStorageStores()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useLocalStorageCacheWithExpiry', () => {
  it('serves a value inside its shelf life', async () => {
    const { result, act } = await renderHook(() =>
      useLocalStorageCacheWithExpiry(KEY, schema, MINUTE_MS),
    )
    await act(() => {
      result.current[1]({ name: 'reflect' })
    })
    expect(result.current[0]).toEqual({ name: 'reflect' })
  })

  it('hands back the value alone, with no timestamp on it', async () => {
    const { result, act } = await renderHook(() =>
      useLocalStorageCacheWithExpiry(KEY, schema, MINUTE_MS),
    )
    await act(() => {
      result.current[1]({ name: 'reflect' })
    })
    expect(Object.keys(result.current[0] ?? {})).toEqual(['name'])
  })

  it('answers null for a value past its shelf life', async () => {
    const stale = await renderHook(() => useLocalStorageCacheWithExpiry(KEY, schema, MINUTE_MS))
    await stale.act(() => {
      stale.result.current[1]({ name: 'reflect' })
    })
    await stale.unmount()

    // Nothing is fresh under a negative shelf life, so this reads the entry
    // the first hook stored as already expired.
    const { result } = await renderHook(() => useLocalStorageCacheWithExpiry(KEY, schema, -1))
    expect(result.current[0]).toBeNull()
  })

  it('lets go of a value that falls due while the app is open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { result, act } = await renderHook(() =>
      useLocalStorageCacheWithExpiry(KEY, schema, MINUTE_MS),
    )
    await act(() => {
      result.current[1]({ name: 'reflect' })
    })
    expect(result.current[0]).toEqual({ name: 'reflect' })
    await act(() => {
      vi.advanceTimersByTime(2 * MINUTE_MS)
    })
    expect(result.current[0]).toBeNull()
  })
})
