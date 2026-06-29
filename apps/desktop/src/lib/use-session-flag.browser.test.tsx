import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from 'vitest-browser-react'
import { act } from '@/test-utils/act'
import { useSessionFlag } from './use-session-flag'

beforeEach(() => {
  window.sessionStorage.clear()
})

describe('useSessionFlag', () => {
  it('falls back to the default until set, then persists for the session', async () => {
    const first = await renderHook(() => useSessionFlag('reflect.test-flag', true))
    expect(first.result.current[0]).toBe(true)

    act(() => first.result.current[1](false))
    expect(first.result.current[0]).toBe(false)
    await first.unmount()

    const second = await renderHook(() => useSessionFlag('reflect.test-flag', true))
    expect(second.result.current[0]).toBe(false)
  })

  it('updates every mounted subscriber of the same key', async () => {
    const view = await renderHook(() => ({
      one: useSessionFlag('reflect.test-flag', true),
      other: useSessionFlag('reflect.test-flag', true),
      unrelated: useSessionFlag('reflect.other-flag', true),
    }))

    act(() => view.result.current.one[1](false))
    expect(view.result.current.one[0]).toBe(false)
    expect(view.result.current.other[0]).toBe(false)
    expect(view.result.current.unrelated[0]).toBe(true)
  })
})
