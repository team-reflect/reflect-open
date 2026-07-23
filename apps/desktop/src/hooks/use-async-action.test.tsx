import { describe, expect, it } from 'vitest'
import { renderHook } from 'vitest-browser-react'
import { useAsyncAction } from './use-async-action'

describe('useAsyncAction', () => {
  it('flips pending for the duration of the action', async () => {
    const { result, act } = await renderHook(() => useAsyncAction())
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    let running: Promise<void> = Promise.resolve()
    await act(() => {
      running = result.current.run(() => gate)
    })
    expect(result.current.pending).toBe(true)

    release()
    await act(async () => {
      await running
    })
    expect(result.current.pending).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('captures a failure as a message and clears it on the next run', async () => {
    const { result, act } = await renderHook(() => useAsyncAction())

    await act(async () => {
      await result.current.run(async () => {
        throw { kind: 'auth', message: 'token rejected' }
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
    const { result, act } = await renderHook(() => useAsyncAction())
    await act(() => {
      result.current.setError('Name the new repository.')
    })
    expect(result.current.error).toBe('Name the new repository.')
    expect(result.current.pending).toBe(false)
  })
})
