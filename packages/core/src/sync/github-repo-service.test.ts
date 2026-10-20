import { describe, expect, it } from 'vitest'
import { createTestHttpService, type TestHttpReply } from '../testing/index.ts'
import {
  createGithubRepoService,
  newRepoUrl,
  parseRepoInput,
  suggestRepoName,
} from './github-repo-service.ts'

/**
 * A `GithubRepoService` whose every request gets `reply`.
 */
function repos(reply: TestHttpReply) {
  const http = createTestHttpService([{ method: '*', url: () => true, reply }])
  return { http, service: createGithubRepoService({ http }) }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('parseRepoInput', () => {
  it('accepts owner/name and full GitHub URLs', () => {
    expect(parseRepoInput('alex/notes')).toEqual({ owner: 'alex', name: 'notes' })
    expect(parseRepoInput('  alex/notes  ')).toEqual({ owner: 'alex', name: 'notes' })
    expect(parseRepoInput('https://github.com/alex/notes.git')).toEqual({
      owner: 'alex',
      name: 'notes',
    })
    expect(parseRepoInput('my-org/notes.backup')).toEqual({
      owner: 'my-org',
      name: 'notes.backup',
    })
  })

  it('rejects anything that is neither', () => {
    expect(parseRepoInput('')).toBeNull()
    expect(parseRepoInput('just-a-name')).toBeNull()
    expect(parseRepoInput('a/b/c')).toBeNull()
    expect(parseRepoInput('git@github.com:alex/notes.git')).toBeNull()
    expect(parseRepoInput('https://gitlab.com/alex/notes')).toBeNull()
  })
})

describe('suggestRepoName', () => {
  it('slugs the graph name and appends -backup', () => {
    expect(suggestRepoName('Alex Notes')).toBe('alex-notes-backup')
    expect(suggestRepoName('  Déjà vu!  ')).toBe('d-j-vu-backup')
  })

  it('falls back when the name has no sluggable characters', () => {
    expect(suggestRepoName(undefined)).toBe('reflect-backup')
    expect(suggestRepoName('***')).toBe('reflect-backup')
  })
})

describe('GithubRepoService.createRepo', () => {
  const REPO_RESPONSE = {
    full_name: 'alex/notes-backup',
    private: true,
    default_branch: 'main',
    html_url: 'https://github.com/alex/notes-backup',
  }

  it('creates a private repo and normalizes the response', async () => {
    const { http, service } = repos(jsonResponse(REPO_RESPONSE, 201))
    const repo = await service.createRepo('tok', 'notes-backup')
    expect(JSON.parse(http.requests()[0]?.body ?? '')).toMatchObject({
      name: 'notes-backup',
      private: true,
    })
    expect(repo).toEqual({
      fullName: 'alex/notes-backup',
      isPrivate: true,
      defaultBranch: 'main',
      htmlUrl: 'https://github.com/alex/notes-backup',
    })
  })

  it('maps a rejected token to an auth error', async () => {
    const { service } = repos(jsonResponse({ message: 'Bad credentials' }, 401))
    await expect(service.createRepo('tok', 'notes-backup')).rejects.toMatchObject({
      kind: 'auth',
    })
  })

  it('returns null when the token type cannot create repos (fine-grained 403)', async () => {
    const { service } = repos(
      jsonResponse({ message: 'Resource not accessible by personal access token' }, 403),
    )
    expect(await service.createRepo('github_pat_x', 'backup')).toBeNull()
  })

  it('still throws auth for a genuinely rejected token', async () => {
    const { service } = repos(jsonResponse({ message: 'Bad credentials' }, 401))
    await expect(service.createRepo('ghp_bad', 'backup')).rejects.toMatchObject({
      kind: 'auth',
    })
  })
})

describe('GithubRepoService.getRepo', () => {
  const REF = { owner: 'alex', name: 'notes-backup' }

  it('returns null for a missing repo (the connect dialog explains, not throws)', async () => {
    const { service } = repos(jsonResponse({ message: 'Not Found' }, 404))
    expect(await service.getRepo('tok', REF)).toBeNull()
  })

  it('maps a rejected token to an auth error', async () => {
    const { service } = repos(jsonResponse({ message: 'Bad credentials' }, 403))
    await expect(service.getRepo('tok', REF)).rejects.toMatchObject({ kind: 'auth' })
  })
})

describe('newRepoUrl', () => {
  it('prefills name, private visibility, and the backup description', () => {
    const url = new URL(newRepoUrl('my notes-backup'))
    expect(url.origin + url.pathname).toBe('https://github.com/new')
    expect(url.searchParams.get('name')).toBe('my notes-backup')
    expect(url.searchParams.get('visibility')).toBe('private')
    expect(url.searchParams.get('description')).toBe('Reflect notes backup')
  })
})
