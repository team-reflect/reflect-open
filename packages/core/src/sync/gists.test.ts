import { describe, expect, it, vi } from 'vitest'
import { createGist, deleteGist, updateGist } from './gists'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const GIST = { id: 'g1', html_url: 'https://gist.github.com/alex/g1' }

describe('createGist', () => {
  it('posts a secret single-file gist and returns its id and url', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(GIST, 201))
    const published = await createGist('tok', { name: 'A.md', content: '# A\n' }, fetchFn)

    expect(published).toEqual({ id: 'g1', htmlUrl: 'https://gist.github.com/alex/g1' })
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.github.com/gists')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body as string)).toEqual({
      public: false,
      files: { 'A.md': { content: '# A\n' } },
    })
  })

  it('maps 404 to a reconnect-and-grant auth error (missing gist permission)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ message: 'Not Found' }, 404))
    await expect(createGist('tok', { name: 'A.md', content: 'x' }, fetchFn)).rejects.toMatchObject({
      kind: 'auth',
      message: expect.stringMatching(/reconnect/i),
    })
  })

  it('maps 401 to a rejected-token auth error', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ message: 'Bad credentials' }, 401))
    await expect(createGist('tok', { name: 'A.md', content: 'x' }, fetchFn)).rejects.toMatchObject({
      kind: 'auth',
    })
  })

  it('surfaces other failures with the response body', async () => {
    const fetchFn = vi.fn(async () => new Response('Validation Failed', { status: 422 }))
    await expect(createGist('tok', { name: 'A.md', content: 'x' }, fetchFn)).rejects.toMatchObject({
      kind: 'io',
      message: expect.stringContaining('422'),
    })
  })
})

describe('updateGist', () => {
  it('patches the file under its previous name, renaming to the current one', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(GIST))
    const published = await updateGist(
      'tok',
      'g1',
      'Old Title.md',
      { name: 'New Title.md', content: 'body' },
      fetchFn,
    )

    expect(published).toEqual({ id: 'g1', htmlUrl: 'https://gist.github.com/alex/g1' })
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.github.com/gists/g1')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({
      files: { 'Old Title.md': { filename: 'New Title.md', content: 'body' } },
    })
  })

  it('returns null on 404 — the gist is gone and the caller re-creates', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ message: 'Not Found' }, 404))
    await expect(
      updateGist('tok', 'g1', 'A.md', { name: 'A.md', content: 'x' }, fetchFn),
    ).resolves.toBeNull()
  })

  it('maps 403 to an auth error', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ message: 'Forbidden' }, 403))
    await expect(
      updateGist('tok', 'g1', 'A.md', { name: 'A.md', content: 'x' }, fetchFn),
    ).rejects.toMatchObject({ kind: 'auth' })
  })
})

describe('deleteGist', () => {
  it('issues the DELETE and resolves on success', async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }))
    await expect(deleteGist('tok', 'g1', fetchFn)).resolves.toBeUndefined()
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.github.com/gists/g1')
    expect(init.method).toBe('DELETE')
  })

  it('treats 404 as success — already gone is the goal state', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ message: 'Not Found' }, 404))
    await expect(deleteGist('tok', 'g1', fetchFn)).resolves.toBeUndefined()
  })

  it('maps 401/403 to auth errors', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ message: 'Forbidden' }, 403))
    await expect(deleteGist('tok', 'g1', fetchFn)).rejects.toMatchObject({ kind: 'auth' })
  })
})
