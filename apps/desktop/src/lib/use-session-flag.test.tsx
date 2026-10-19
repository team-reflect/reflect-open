import { act } from '@/test-utils/act.ts'
import { describe, expect, it } from 'vitest'
import { createTestCoreServices } from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useSessionFlag } from './use-session-flag.ts'

describe('useSessionFlag', () => {
  it('falls back to the default until set, then persists for the session', async () => {
    const app = createTestCoreServices({ database: createWasmTestDatabaseService() })
    const first = await renderHookInApp(() => useSessionFlag('reflect.test-flag', true), { app })
    expect(first.result.current[0]).toBe(true)

    await act(() => first.result.current[1](false))
    expect(first.result.current[0]).toBe(false)
    await first.unmount()

    const second = await renderHookInApp(() => useSessionFlag('reflect.test-flag', true), { app })
    expect(second.result.current[0]).toBe(false)
    await second.unmount()
  })

  it('updates every mounted subscriber of the same key', async () => {
    const view = await renderHookInApp(() => ({
      one: useSessionFlag('reflect.test-flag', true),
      other: useSessionFlag('reflect.test-flag', true),
      unrelated: useSessionFlag('reflect.other-flag', true),
    }))

    await act(() => view.result.current.one[1](false))
    expect(view.result.current.one[0]).toBe(false)
    expect(view.result.current.other[0]).toBe(false)
    expect(view.result.current.unrelated[0]).toBe(true)
    await view.unmount()
  })
})
