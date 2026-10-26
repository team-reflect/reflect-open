import { describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'
import { createTestLoggerService } from '../testing/logger.ts'
import { createTestSecretStoreService } from '../testing/secrets.ts'
import {
  createGitHostCredentialService,
  gitHostCredentialSecretName,
} from './git-host-credential-service.ts'

const ORIGIN = 'https://gitlab.com'

function setup(secrets: Record<string, string> = {}) {
  const secretStore = createTestSecretStoreService(secrets)
  const logger = createTestLoggerService()
  const gitHostCredentials = createGitHostCredentialService({ secretStore, logger })
  return { secretStore, logger, gitHostCredentials }
}

describe('GitHostCredentialService', () => {
  it('stores one sign-in per origin and reads it back', async () => {
    const { secretStore, gitHostCredentials } = setup()
    await gitHostCredentials.save(ORIGIN, { username: 'alex', secret: 'glpat-1' })
    await gitHostCredentials.save('https://gitlab.com:8443', {
      username: 'alex',
      secret: 'glpat-2',
    })

    expect(await gitHostCredentials.load(ORIGIN)).toEqual({
      origin: ORIGIN,
      username: 'alex',
      secret: 'glpat-1',
    })
    expect(await gitHostCredentials.load('https://gitlab.com:8443')).toEqual({
      origin: 'https://gitlab.com:8443',
      username: 'alex',
      secret: 'glpat-2',
    })
    expect(await gitHostCredentials.load('http://gitlab.com')).toBeNull()
    expect(Object.keys(secretStore.snapshot())).toEqual([
      gitHostCredentialSecretName(ORIGIN),
      gitHostCredentialSecretName('https://gitlab.com:8443'),
    ])
  })

  it('treats a keychain read failure as absent and logs it', async () => {
    const { secretStore, logger, gitHostCredentials } = setup()
    vi.spyOn(secretStore, 'get').mockRejectedValueOnce(new Error('keychain locked'))

    expect(await gitHostCredentials.load(ORIGIN)).toBeNull()
    expect(logger.getErrors()).toHaveLength(1)
  })

  it('treats an unreadable entry as absent and logs it', async () => {
    const { logger, gitHostCredentials } = setup({
      [gitHostCredentialSecretName(ORIGIN)]: 'not json',
      [gitHostCredentialSecretName('https://gitea.local')]: JSON.stringify({ username: 'alex' }),
    })
    expect(await gitHostCredentials.load(ORIGIN)).toBeNull()
    expect(await gitHostCredentials.load('https://gitea.local')).toBeNull()
    expect(logger.getErrors()).toHaveLength(2)
  })

  it('refuses an empty username or secret', async () => {
    const { secretStore, gitHostCredentials } = setup()
    await expect(gitHostCredentials.save(ORIGIN, { username: '', secret: 'x' })).rejects.toThrow(
      ZodError,
    )
    await expect(gitHostCredentials.save(ORIGIN, { username: 'alex', secret: '' })).rejects.toThrow(
      ZodError,
    )
    expect(secretStore.snapshot()).toEqual({})
  })

  it('notifies subscribers on save and delete', async () => {
    const { gitHostCredentials } = setup()
    const listener = vi.fn()
    const unlisten = gitHostCredentials.subscribe(listener)
    await gitHostCredentials.save(ORIGIN, { username: 'alex', secret: 'glpat-1' })
    await gitHostCredentials.delete(ORIGIN)
    await gitHostCredentials.delete(ORIGIN)
    expect(listener).toHaveBeenCalledTimes(3)
    expect(await gitHostCredentials.load(ORIGIN)).toBeNull()
    unlisten()
    await gitHostCredentials.save(ORIGIN, { username: 'alex', secret: 'glpat-1' })
    expect(listener).toHaveBeenCalledTimes(3)
  })
})
