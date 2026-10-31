import { describe, expect, it } from 'vitest'
import { createTestHttpService, type TestHttpReply } from '../testing/index.ts'
import { createGistService } from './gist-service.ts'
import { isAppError } from '../errors.ts'

const GIST = { id: 'g1', html_url: 'https://gist.github.com/alex/g1' }

function github(reply: TestHttpReply) {
  return createTestHttpService([{ method: '*', url: () => true, reply }])
}

describe('GistService.create', () => {
  it('posts a secret single-file gist and returns its id and url', async () => {
    const http = github({ status: 201, json: GIST })
    const published = await createGistService({ http }).create('tok', {
      name: 'A.md',
      content: '# A\n',
    })

    expect(published).toEqual({ id: 'g1', htmlUrl: 'https://gist.github.com/alex/g1' })
    const [request] = http.requests()
    expect(request?.url).toBe('https://api.github.com/gists')
    expect(request?.method).toBe('POST')
    expect(request?.headers.get('Authorization')).toBe('Bearer tok')
    expect(JSON.parse(request?.body ?? '')).toEqual({
      public: false,
      files: { 'A.md': { content: '# A\n' } },
    })
  })

  it('maps 404 to a reconnect-and-grant auth error (missing gist permission)', async () => {
    const http = github({ status: 404, json: { message: 'Not Found' } })
    const service = createGistService({ http })
    const promise = service.create('tok', { name: 'A.md', content: 'x' })
    await expect(promise).rejects.toSatisfy((error: unknown) => {
      return isAppError(error) && error.kind === 'auth' && /reconnect/i.test(error.message)
    })
  })

  it('maps 401 to a rejected-token auth error', async () => {
    const http = github({ status: 401, json: { message: 'Bad credentials' } })
    const service = createGistService({ http })
    const promise = service.create('tok', { name: 'A.md', content: 'x' })
    await expect(promise).rejects.toSatisfy((error: unknown) => {
      return isAppError(error) && error.kind === 'auth'
    })
  })

  it('surfaces other failures with the response body', async () => {
    const http = github(new Response('Validation Failed', { status: 422 }))
    const service = createGistService({ http })
    const promise = service.create('tok', { name: 'A.md', content: 'x' })
    await expect(promise).rejects.toSatisfy((error: unknown) => {
      return isAppError(error) && error.kind === 'io' && error.message.includes('422')
    })
  })
})

describe('GistService.update', () => {
  it('patches the file under its previous name, renaming to the current one', async () => {
    const http = github({ status: 200, json: GIST })
    const published = await createGistService({ http }).update('tok', 'g1', 'Old Title.md', {
      name: 'New Title.md',
      content: 'body',
    })

    expect(published).toEqual({ id: 'g1', htmlUrl: 'https://gist.github.com/alex/g1' })
    const [request] = http.requests()
    expect(request?.url).toBe('https://api.github.com/gists/g1')
    expect(request?.method).toBe('PATCH')
    expect(JSON.parse(request?.body ?? '')).toEqual({
      files: { 'Old Title.md': { filename: 'New Title.md', content: 'body' } },
    })
  })

  it('returns null on 404 — the gist is gone and the caller re-creates', async () => {
    const http = github({ status: 404, json: { message: 'Not Found' } })
    await expect(
      createGistService({ http }).update('tok', 'g1', 'A.md', { name: 'A.md', content: 'x' }),
    ).resolves.toBeNull()
  })

  it('maps 403 to an auth error', async () => {
    const http = github({ status: 403, json: { message: 'Forbidden' } })
    const service = createGistService({ http })
    const promise = service.update('tok', 'g1', 'A.md', { name: 'A.md', content: 'x' })
    await expect(promise).rejects.toSatisfy((error: unknown) => {
      return isAppError(error) && error.kind === 'auth'
    })
  })
})

describe('GistService.delete', () => {
  it('issues the DELETE and resolves on success', async () => {
    const http = github({ status: 204 })
    await expect(createGistService({ http }).delete('tok', 'g1')).resolves.toBeUndefined()
    const [request] = http.requests()
    expect(request?.url).toBe('https://api.github.com/gists/g1')
    expect(request?.method).toBe('DELETE')
  })

  it('treats 404 as success — already gone is the goal state', async () => {
    const http = github({ status: 404, json: { message: 'Not Found' } })
    await expect(createGistService({ http }).delete('tok', 'g1')).resolves.toBeUndefined()
  })

  it('maps 401/403 to auth errors', async () => {
    const http = github({ status: 403, json: { message: 'Forbidden' } })
    const service = createGistService({ http })
    const promise = service.delete('tok', 'g1')
    await expect(promise).rejects.toSatisfy((error: unknown) => {
      return isAppError(error) && error.kind === 'auth'
    })
  })
})
