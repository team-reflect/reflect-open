import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { providerFetch } from './provider-fetch'

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
const isNativeShell = vi.hoisted(() => vi.fn(() => false))
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  isNativeShell,
}))
const httpFetch = vi.mocked(tauriFetch)

afterEach(() => {
  isNativeShell.mockReturnValue(false)
  httpFetch.mockReset()
  vi.unstubAllGlobals()
})

describe('providerFetch', () => {
  it('sends an explicit empty Origin so the plugin drops the header', async () => {
    isNativeShell.mockReturnValue(true)
    httpFetch.mockResolvedValue(new Response(null, { status: 200 }))

    await providerFetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': 'sk-ant-test' },
    })

    const [, init] = httpFetch.mock.calls[0]!
    const headers = new Headers(init?.headers)
    expect(headers.get('Origin')).toBe('')
    expect(headers.get('x-api-key')).toBe('sk-ant-test')
  })

  it('leaves a caller-set Origin alone', async () => {
    isNativeShell.mockReturnValue(true)
    httpFetch.mockResolvedValue(new Response(null, { status: 200 }))

    await providerFetch('https://api.anthropic.com/v1/models', {
      headers: { Origin: 'https://reflect.example' },
    })

    const [, init] = httpFetch.mock.calls[0]!
    expect(new Headers(init?.headers).get('Origin')).toBe('https://reflect.example')
  })

  it('falls back to the global fetch (untouched init) outside the native shell', async () => {
    const globalFetch = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', globalFetch)

    await providerFetch('https://api.anthropic.com/v1/models', undefined)

    expect(globalFetch).toHaveBeenCalledWith('https://api.anthropic.com/v1/models', undefined)
    expect(httpFetch).not.toHaveBeenCalled()
  })
})
