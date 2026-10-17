import { AppError } from '@reflect/core'
import { act } from '@/test-utils/act.ts'
import { describe, expect, it } from 'vitest'
import { renderHook } from 'vitest-browser-react'
import { useAsyncAction } from './use-async-action.ts'

describe('useAsyncAction', () => {
  it('flips pending for the duration of the action', async () => {
    const { result } = await renderHook(() => useAsyncAction())
    const gate = Promise.withResolvers<void>()

    let running: Promise<void> = Promise.resolve()
    await act(() => {
      running = result.current.run(() => gate.promise)
    })
    expect(result.current.pending).toBe(true)

    gate.resolve()
    await act(async () => {
      await running
    })
    expect(result.current.pending).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('captures a failure as a message and clears it on the next run', async () => {
    const { result } = await renderHook(() => useAsyncAction())

    await act(async () => {
      await result.current.run(async () => {
        throw new AppError('auth', 'token rejected')
      })
    })
    expect(result.current.error).toBe('token rejected')
    expect(result.current.pending).toBe(false)

    await act(async () => {
      await result.current.run(async () => {})
    })
    expect(result.current.error).toBeNull()
  })

  it('setError surfaces a validation message without running anything', async () => {
    const { result } = await renderHook(() => useAsyncAction())
    await act(() => {
      result.current.setError('Name the new repository.')
    })
    expect(result.current.error).toBe('Name the new repository.')
    expect(result.current.pending).toBe(false)
  })
})
