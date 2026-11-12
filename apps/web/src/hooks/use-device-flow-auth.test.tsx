import { act } from '@/test-utils/act.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError, type GithubAuth, type GithubAuthService } from '@reflect/core'
import { createTestCoreServices } from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useDeviceFlowAuth } from './use-device-flow-auth.ts'

const mockFlow = vi.fn<GithubAuthService['runDeviceFlow']>()
const AUTH: GithubAuth = { kind: 'pat', token: 'ghp_abc' }

/**
 * Render the hook over an app whose GitHub device flow is `mockFlow`.
 */
async function mount() {
  const core = createTestCoreServices({ database: createWasmTestDatabaseService() })
  core.githubAuth.onRunDeviceFlow(mockFlow)
  return await renderHookInApp(() => useDeviceFlowAuth(), { core })
}

afterEach(() => {
  mockFlow.mockReset()
})

describe('useDeviceFlowAuth', () => {
  it('surfaces the user code and resolves true on success', async () => {
    // No browser side effects here: the surface opens GitHub only after the
    // user has the code (copy first, then hand off).
    mockFlow.mockImplementation((options) => {
      return Promise.try(() => {
        options.onCode({
          userCode: 'ABCD-1234',
          verificationUri: 'https://github.com/login/device',
        })
        return AUTH
      })
    })
    const { result } = await mount()

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
    expect(result.current.busy).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('returns to the idle view with a message when the flow fails', async () => {
    mockFlow.mockImplementation((options) => {
      return Promise.try(() => {
        options.onCode({
          userCode: 'ABCD-1234',
          verificationUri: 'https://github.com/login/device',
        })
        throw new AppError('auth', 'GitHub sign-in was denied.')
      })
    })
    const { result } = await mount()

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
    const { result } = await mount()

    let authed = true
    await act(async () => {
      authed = await result.current.signIn()
    })

    expect(authed).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('aborts the polling when the owning component unmounts', async () => {
    let signal: AbortSignal | undefined
    mockFlow.mockImplementation((options) => {
      signal = options.signal
      return Promise.resolve(null)
    })
    const { result, unmount } = await mount()

    await act(async () => {
      await result.current.signIn()
    })
    expect(signal?.aborted).toBe(false)

    await unmount()
    expect(signal?.aborted).toBe(true)
  })
})
