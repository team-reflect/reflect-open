import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestHttpService } from '../testing/index.ts'
import { createBrowserHttpService } from './http-service.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createBrowserHttpService', () => {
  it('delegates to the global fetch read at call time', async () => {
    const service = createBrowserHttpService()
    const globalFetch = vi.fn<typeof fetch>(() => {
      return Promise.resolve(new Response('ok', { status: 201 }))
    })
    vi.stubGlobal('fetch', globalFetch)
    const init: RequestInit = { method: 'POST', body: 'payload' }

    const response = await service.fetch('https://example.com/a', init)

    expect(response.status).toBe(201)
    expect(globalFetch).toHaveBeenCalledWith('https://example.com/a', init)
  })
})
describe('createTestHttpService', () => {
  it('answers an unmatched request with 404', async () => {
    const http = createTestHttpService()

    const response = await http.fetch('https://example.com/missing')

    expect(response.status).toBe(404)
  })

  it('answers from a JSON reply', async () => {
    const http = createTestHttpService([
      {
        method: 'GET',
        url: 'https://api.github.com/user',
        reply: { status: 200, json: { id: 7 } },
      },
    ])

    const response = await http.fetch('https://api.github.com/user')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: 7 })
  })

  it('matches the method case-insensitively, and `*` matches any method', async () => {
    const http = createTestHttpService()
    http.on('post', 'https://example.com/a', { status: 201 })
    http.on('*', /\/b$/, { status: 202 })

    expect((await http.fetch('https://example.com/a', { method: 'POST' })).status).toBe(201)
    expect((await http.fetch('https://example.com/a')).status).toBe(404)
    expect((await http.fetch('https://example.com/b', { method: 'DELETE' })).status).toBe(202)
  })

  it('lets a later route win over an earlier one', async () => {
    const http = createTestHttpService()
    http.on('GET', () => true, { status: 500 })
    http.on('GET', 'https://example.com/a', { status: 200 })

    expect((await http.fetch('https://example.com/a')).status).toBe(200)
    expect((await http.fetch('https://example.com/other')).status).toBe(500)
  })

  it('serves a fresh copy of a `Response` reply for every match', async () => {
    const http = createTestHttpService()
    http.on('GET', 'https://example.com/a', new Response('body'))

    expect(await (await http.fetch('https://example.com/a')).text()).toBe('body')
    expect(await (await http.fetch('https://example.com/a')).text()).toBe('body')
  })

  it('passes the request to a handler', async () => {
    const http = createTestHttpService()
    http.on(
      'POST',
      'https://example.com/echo',
      async (request) => new Response(await request.text()),
    )

    const response = await http.fetch('https://example.com/echo', { method: 'POST', body: 'hi' })

    expect(await response.text()).toBe('hi')
  })

  it('records every request', async () => {
    const http = createTestHttpService()

    await http.fetchFn('https://example.com/a', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok' },
      body: JSON.stringify({ a: 1 }),
    })
    await http.fetch(new URL('https://example.com/b'))

    const [first, second] = http.requests()
    expect(first).toMatchObject({ method: 'POST', url: 'https://example.com/a', body: '{"a":1}' })
    expect(first?.headers.get('Authorization')).toBe('Bearer tok')
    expect(second).toMatchObject({ method: 'GET', url: 'https://example.com/b', body: null })
  })
})
