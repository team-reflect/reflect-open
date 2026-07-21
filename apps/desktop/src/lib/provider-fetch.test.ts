import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { providerFetch } from './provider-fetch'

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
const httpFetch = vi.mocked(tauriFetch)

afterEach(() => {
  setBridge(null)
  httpFetch.mockReset()
  vi.unstubAllGlobals()
})

function installBridge(): void {
  setBridge({ invoke: async () => null, listen: async () => () => {} })
}

describe('providerFetch', () => {
  it('sends an explicit empty Origin so the plugin drops the header', async () => {
    installBridge()
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
    installBridge()
    httpFetch.mockResolvedValue(new Response(null, { status: 200 }))

    await providerFetch('https://api.anthropic.com/v1/models', {
      headers: { Origin: 'https://reflect.example' },
    })

    const [, init] = httpFetch.mock.calls[0]!
    expect(new Headers(init?.headers).get('Origin')).toBe('https://reflect.example')
  })

  it('falls back to the global fetch (untouched init) without a bridge', async () => {
    const globalFetch = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', globalFetch)

    await providerFetch('https://api.anthropic.com/v1/models', undefined)

    expect(globalFetch).toHaveBeenCalledWith('https://api.anthropic.com/v1/models', undefined)
    expect(httpFetch).not.toHaveBeenCalled()
  })
})
