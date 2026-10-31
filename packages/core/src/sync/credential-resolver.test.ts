import { describe, expect, it } from 'vitest'
import { createTestLoggerService } from '../testing/logger.ts'
import { createTestSecretStoreService } from '../testing/secrets.ts'
import { createTestGithubAuthService } from '../testing/sync.ts'
import { createCredentialResolver } from './credential-resolver.ts'
import { createGitHostCredentialService } from './git-host-credential-service.ts'
import { GITHUB_AUTH_SECRET } from './github-auth-service.ts'
import type { GitRemote } from './remote-url.ts'

const GITHUB: GitRemote = { kind: 'github', repo: { owner: 'alex', name: 'notes' } }
const GITLAB: GitRemote = { kind: 'https', origin: 'https://gitlab.com' }

function setup(secrets: Record<string, string> = {}) {
  const secretStore = createTestSecretStoreService(secrets)
  const logger = createTestLoggerService()
  const githubAuth = createTestGithubAuthService({ secretStore })
  const gitHostCredentials = createGitHostCredentialService({ secretStore, logger })
  const resolver = createCredentialResolver({ githubAuth, gitHostCredentials, logger })
  return { githubAuth, gitHostCredentials, resolver }
}

describe('CredentialResolver', () => {
  it('is missing for a GitHub remote while signed out, and ready once signed in', async () => {
    const { githubAuth, resolver } = setup()
    expect(await resolver.resolve(GITHUB)).toEqual({ kind: 'missing' })

    await githubAuth.save({ kind: 'pat', token: 'ghp_1' })
    const resolved = await resolver.resolve(GITHUB)
    expect(resolved.kind).toBe('ready')
    if (resolved.kind === 'ready') {
      expect(await resolved.get()).toEqual({
        origin: 'https://github.com',
        username: 'x-access-token',
        secret: 'ghp_1',
      })
      // The lookup follows the stored token, so a rotation reaches the engine.
      await githubAuth.save({ kind: 'pat', token: 'ghp_2' })
      expect(await resolved.get()).toEqual({
        origin: 'https://github.com',
        username: 'x-access-token',
        secret: 'ghp_2',
      })
    }
  })

  it('never offers the GitHub sign-in to another host', async () => {
    const { resolver } = setup({
      [GITHUB_AUTH_SECRET]: JSON.stringify({ kind: 'pat', token: 'ghp_1' }),
    })
    expect(await resolver.resolve(GITLAB)).toEqual({ kind: 'missing' })
  })

  it('resolves an HTTPS host from its own entry, re-read per cycle', async () => {
    const { gitHostCredentials, resolver } = setup()
    await gitHostCredentials.save('https://gitlab.com', { username: 'alex', secret: 'glpat-1' })
    const resolved = await resolver.resolve(GITLAB)
    expect(resolved.kind).toBe('ready')
    if (resolved.kind === 'ready') {
      expect(await resolved.get()).toEqual({
        origin: 'https://gitlab.com',
        username: 'alex',
        secret: 'glpat-1',
      })
      await gitHostCredentials.save('https://gitlab.com', { username: 'alex', secret: 'glpat-2' })
      expect(await resolved.get()).toEqual({
        origin: 'https://gitlab.com',
        username: 'alex',
        secret: 'glpat-2',
      })
    }
    expect(await resolver.resolve({ kind: 'https', origin: 'https://gitlab.com:8443' })).toEqual({
      kind: 'missing',
    })
  })

  it('never offers a host sign-in over plain http', async () => {
    const { gitHostCredentials, resolver } = setup()
    await gitHostCredentials.save('http://gitea.local', { username: 'alex', secret: 'tok' })
    expect(await resolver.resolve({ kind: 'https', origin: 'http://gitea.local' })).toEqual({
      kind: 'missing',
    })
  })

  it('gives SSH and path remotes no sign-in', async () => {
    const { resolver } = setup()
    for (const remote of [{ kind: 'ssh', host: 'gitlab.com' }, { kind: 'path' }] as const) {
      const resolved = await resolver.resolve(remote)
      expect(resolved.kind).toBe('ready')
      if (resolved.kind === 'ready') {
        expect(await resolved.get()).toBeNull()
      }
    }
  })
})
