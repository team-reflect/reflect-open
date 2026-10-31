import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { createTauriHttpService } from './tauri-http.ts'

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
const httpFetch = vi.mocked(tauriFetch)

afterEach(() => {
  httpFetch.mockReset()
})

describe('createTauriHttpService', () => {
  it('sends an explicit empty Origin so the plugin drops the header', async () => {
    httpFetch.mockResolvedValue(new Response(null, { status: 200 }))

    await createTauriHttpService().fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': 'sk-ant-test' },
    })

    const [input, init] = httpFetch.mock.calls[0]!
    expect(input).toBe('https://api.anthropic.com/v1/models')
    const headers = new Headers(init?.headers)
    expect(headers.get('Origin')).toBe('')
    expect(headers.get('x-api-key')).toBe('sk-ant-test')
  })

  it('leaves a caller-set Origin alone', async () => {
    httpFetch.mockResolvedValue(new Response(null, { status: 200 }))

    await createTauriHttpService().fetch('https://api.anthropic.com/v1/models', {
      headers: { Origin: 'https://reflect.example' },
    })

    const [, init] = httpFetch.mock.calls[0]!
    expect(new Headers(init?.headers).get('Origin')).toBe('https://reflect.example')
  })

  it('keeps the rest of the request init', async () => {
    httpFetch.mockResolvedValue(new Response(null, { status: 200 }))

    await createTauriHttpService().fetch('https://api.openai.com/v1/models', {
      method: 'POST',
      body: 'payload',
    })

    const [, init] = httpFetch.mock.calls[0]!
    expect(init).toMatchObject({ method: 'POST', body: 'payload' })
  })
})
