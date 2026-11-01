import { AppError } from '@reflect/core'
import { act } from '@/test-utils/act.ts'
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from 'vitest-browser-react'
import { useAsyncAction } from './use-async-action.ts'

describe('useAsyncAction', () => {
  it('flips pending for the duration of the action', async () => {
    const { result } = await renderHook(() => useAsyncAction())
    const gate = Promise.withResolvers<void>()

    let running: Promise<boolean> = Promise.resolve(false)
    await act(() => {
      running = result.current.run(() => gate.promise)
    })
    expect(result.current.pending).toBe(true)

    gate.resolve()
    await act(async () => {
      expect(await running).toBe(true)
    })
    expect(result.current.pending).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('captures a failure as a message and clears it on the next run', async () => {
    const { result } = await renderHook(() => useAsyncAction())

    await act(async () => {
      await result.current.run(() => Promise.reject(new AppError('auth', 'token rejected')))
    })
    expect(result.current.error).toBe('token rejected')
    expect(result.current.pending).toBe(false)

    await act(async () => {
      await result.current.run(async () => {})
    })
    expect(result.current.error).toBeNull()
  })

  it('ignores a run that starts while another is in flight', async () => {
    const { result } = await renderHook(() => useAsyncAction())
    const gate = Promise.withResolvers<void>()
    const second = vi.fn()

    let first: Promise<boolean> = Promise.resolve(false)
    let secondRan = true
    await act(async () => {
      first = result.current.run(() => gate.promise)
      secondRan = await result.current.run(second)
    })
    expect(secondRan).toBe(false)
    expect(second).not.toHaveBeenCalled()
    expect(result.current.pending).toBe(true)

    gate.resolve()
    await act(async () => {
      expect(await first).toBe(true)
    })
    expect(result.current.pending).toBe(false)

    await act(async () => {
      expect(await result.current.run(second)).toBe(true)
    })
    expect(second).toHaveBeenCalledOnce()
  })

  it('reset clears the error without running anything', async () => {
    const { result } = await renderHook(() => useAsyncAction())
    await act(async () => {
      await result.current.run(() => Promise.reject(new Error('Paste a token first.')))
    })
    expect(result.current.error).toBe('Paste a token first.')

    await act(() => {
      result.current.reset()
    })
    expect(result.current.error).toBeNull()
    expect(result.current.pending).toBe(false)
  })
})
