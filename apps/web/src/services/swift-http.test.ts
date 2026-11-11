import { describe, expect, it } from 'vitest'
import { createSwiftHttpService } from './swift-http.ts'

function fetchCapturing(): { fetchFn: typeof fetch; requests: Request[] } {
  const requests: Request[] = []
  const fetchFn: typeof fetch = (input, init) => {
    requests.push(new Request(input, init))
    return Promise.resolve(new Response('data: hello\n\n', { status: 200 }))
  }
  return { fetchFn, requests }
}

describe('createSwiftHttpService', () => {
  it('sends the request to the proxy route with the target in `url`', async () => {
    const { fetchFn, requests } = fetchCapturing()

    await createSwiftHttpService(fetchFn).fetch('https://api.openai.com/v1/responses?stream=1', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: '{"model":"gpt-5"}',
    })

    const request = requests[0]!
    expect(request.url).toBe(
      'reflect-app://localhost/__http?url=https%3A%2F%2Fapi.openai.com%2Fv1%2Fresponses%3Fstream%3D1',
    )
    expect(request.method).toBe('POST')
    expect(request.headers.get('authorization')).toBe('Bearer sk-test')
    expect(request.headers.get('content-type')).toBe('application/json')
    expect(await request.text()).toBe('{"model":"gpt-5"}')
  })

  it('reads the target, method, headers and body of a `Request` input', async () => {
    const { fetchFn, requests } = fetchCapturing()

    await createSwiftHttpService(fetchFn).fetch(
      new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': 'sk-ant-test' },
        body: 'payload',
      }),
    )

    const request = requests[0]!
    expect(request.url).toBe(
      'reflect-app://localhost/__http?url=https%3A%2F%2Fapi.anthropic.com%2Fv1%2Fmessages',
    )
    expect(request.method).toBe('POST')
    expect(request.headers.get('x-api-key')).toBe('sk-ant-test')
    expect(await request.text()).toBe('payload')
  })

  it('aborts the proxied request with the caller signal', async () => {
    const { fetchFn, requests } = fetchCapturing()
    const controller = new AbortController()

    await createSwiftHttpService(fetchFn).fetch('https://example.com/stream', {
      signal: controller.signal,
    })
    controller.abort()

    expect(requests[0]!.signal.aborted).toBe(true)
  })
})
