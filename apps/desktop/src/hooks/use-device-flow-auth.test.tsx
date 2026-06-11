import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openUrl } from '@tauri-apps/plugin-opener'
import { runDeviceFlow, ReflectError, type GithubAuth } from '@reflect/core'
import { useDeviceFlowAuth } from './use-device-flow-auth'

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => {}) }))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  runDeviceFlow: vi.fn(),
}))

const mockFlow = vi.mocked(runDeviceFlow)
const AUTH: GithubAuth = { kind: 'pat', token: 'ghp_abc' }

afterEach(() => {
  cleanup()
  mockFlow.mockReset()
})

describe('useDeviceFlowAuth', () => {
  it('surfaces the user code, opens the browser, and resolves true on success', async () => {
    mockFlow.mockImplementation(async (options) => {
      options.onCode({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' })
      return AUTH
    })
    const { result } = renderHook(() => useDeviceFlowAuth())

    let authed = false
    await act(async () => {
      authed = await result.current.signIn()
    })

    expect(authed).toBe(true)
    expect(result.current.view).toEqual({
      view: 'code',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
    })
    expect(vi.mocked(openUrl)).toHaveBeenCalledWith('https://github.com/login/device')
    expect(result.current.busy).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('returns to the idle view with a message when the flow fails', async () => {
    mockFlow.mockImplementation(async (options) => {
      options.onCode({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' })
      throw new ReflectError('auth', 'GitHub sign-in was denied.')
    })
    const { result } = renderHook(() => useDeviceFlowAuth())

    let authed = true
    await act(async () => {
      authed = await result.current.signIn()
    })

    expect(authed).toBe(false)
    expect(result.current.view).toEqual({ view: 'idle' })
    expect(result.current.error).toBe('GitHub sign-in was denied.')
  })

  it('resolves false without an error when the flow is aborted (dialog closed)', async () => {
    mockFlow.mockResolvedValue(null)
    const { result } = renderHook(() => useDeviceFlowAuth())

    let authed = true
    await act(async () => {
      authed = await result.current.signIn()
    })

    expect(authed).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('aborts the polling when the owning component unmounts', async () => {
    let signal: AbortSignal | undefined
    mockFlow.mockImplementation(async (options) => {
      signal = options.signal
      return null
    })
    const { result, unmount } = renderHook(() => useDeviceFlowAuth())

    await act(async () => {
      await result.current.signIn()
    })
    expect(signal?.aborted).toBe(false)

    unmount()
    expect(signal?.aborted).toBe(true)
  })
})
