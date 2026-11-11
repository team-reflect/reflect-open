import { describe, expect, it } from 'vitest'
import { createSwiftIpcTransport } from './swift-ipc.ts'

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

function fetchAnswering(response: Response): { fetchFn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetchFn: typeof fetch = (input, init) => {
    calls.push({ url: String(input), init })
    return Promise.resolve(response)
  }
  return { fetchFn, calls }
}

describe('createSwiftIpcTransport', () => {
  it('posts JSON args to the command route and reads the JSON reply', async () => {
    const { fetchFn, calls } = fetchAnswering(Response.json({ text: '# Today' }))

    const reply = await createSwiftIpcTransport(fetchFn).invoke('plugin:recording|start', {
      notePath: 'daily/2026-11-10.md',
    })

    expect(reply).toEqual({ text: '# Today' })
    expect(calls[0]!.url).toBe('reflect-app://localhost/__ipc/plugin%3Arecording%7Cstart')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.init?.headers).toEqual({ 'content-type': 'application/json' })
    expect(calls[0]!.init?.body).toBe('{"notePath":"daily/2026-11-10.md"}')
  })

  it('posts a binary body with its headers', async () => {
    const { fetchFn, calls } = fetchAnswering(Response.json(null))

    await createSwiftIpcTransport(fetchFn).invokeBinary!(
      'asset_upload_append',
      new Uint8Array([1, 2, 3]),
      { 'x-upload-id': 'u1' },
    )

    expect(calls[0]!.url).toBe('reflect-app://localhost/__ipc/asset_upload_append')
    expect(calls[0]!.init?.headers).toEqual({
      'x-upload-id': 'u1',
      'content-type': 'application/octet-stream',
    })
    expect(calls[0]!.init?.body).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('reads an `application/octet-stream` reply as an `ArrayBuffer`', async () => {
    const { fetchFn } = fetchAnswering(
      new Response(new Uint8Array([7, 8]), {
        headers: { 'content-type': 'application/octet-stream' },
      }),
    )

    const reply = await createSwiftIpcTransport(fetchFn).invoke('asset_read_binary', {})

    expect(reply).toBeInstanceOf(ArrayBuffer)
    expect(new Uint8Array(reply as ArrayBuffer)).toEqual(new Uint8Array([7, 8]))
  })

  it('throws the `{ kind, message }` of an error reply', async () => {
    const { fetchFn } = fetchAnswering(
      Response.json(
        { kind: 'notFound', message: 'no such note' },
        { headers: { 'x-reflect-response': 'error' } },
      ),
    )

    await expect(
      createSwiftIpcTransport(fetchFn).invoke('note_read', { path: 'gone.md' }),
    ).rejects.toMatchObject({ kind: 'notFound', message: 'no such note' })
  })

  it('throws a `parse` error for a reply that is not JSON', async () => {
    const { fetchFn } = fetchAnswering(new Response('<html>'))

    await expect(createSwiftIpcTransport(fetchFn).invoke('app_version', {})).rejects.toMatchObject({
      kind: 'parse',
    })
  })

  it('throws an `io` error for a non-2xx status', async () => {
    const { fetchFn } = fetchAnswering(new Response(null, { status: 404 }))

    await expect(createSwiftIpcTransport(fetchFn).invoke('app_version', {})).rejects.toMatchObject({
      kind: 'io',
    })
  })
})
