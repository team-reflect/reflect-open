import { describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'
import { createTestLoggerService } from '../testing/logger.ts'
import { createTestSecretStoreService } from '../testing/secrets.ts'
import {
  createGitHostCredentialService,
  hostCredentialSecretName,
} from './git-host-credential-service.ts'

const ORIGIN = 'https://gitlab.com'

function setup(secrets: Record<string, string> = {}) {
  const secretStore = createTestSecretStoreService(secrets)
  const logger = createTestLoggerService()
  const hostCredentials = createGitHostCredentialService({ secretStore, logger })
  return { secretStore, logger, hostCredentials }
}

describe('GitHostCredentialService', () => {
  it('stores one sign-in per origin and reads it back', async () => {
    const { secretStore, hostCredentials } = setup()
    await hostCredentials.save(ORIGIN, { username: 'alex', secret: 'glpat-1' })
    await hostCredentials.save('https://gitlab.com:8443', { username: 'alex', secret: 'glpat-2' })

    expect(await hostCredentials.load(ORIGIN)).toEqual({ username: 'alex', secret: 'glpat-1' })
    expect(await hostCredentials.load('https://gitlab.com:8443')).toEqual({
      username: 'alex',
      secret: 'glpat-2',
    })
    expect(await hostCredentials.load('http://gitlab.com')).toBeNull()
    expect(Object.keys(secretStore.snapshot())).toEqual([
      hostCredentialSecretName(ORIGIN),
      hostCredentialSecretName('https://gitlab.com:8443'),
    ])
  })

  it('treats a keychain read failure as absent and logs it', async () => {
    const { secretStore, logger, hostCredentials } = setup()
    vi.spyOn(secretStore, 'get').mockRejectedValueOnce(new Error('keychain locked'))

    expect(await hostCredentials.load(ORIGIN)).toBeNull()
    expect(logger.getErrors()).toHaveLength(1)
  })

  it('treats an unreadable entry as absent and logs it', async () => {
    const { logger, hostCredentials } = setup({
      [hostCredentialSecretName(ORIGIN)]: 'not json',
      [hostCredentialSecretName('https://gitea.local')]: JSON.stringify({ username: 'alex' }),
    })
    expect(await hostCredentials.load(ORIGIN)).toBeNull()
    expect(await hostCredentials.load('https://gitea.local')).toBeNull()
    expect(logger.getErrors()).toHaveLength(2)
  })

  it('refuses an empty username or secret', async () => {
    const { secretStore, hostCredentials } = setup()
    await expect(hostCredentials.save(ORIGIN, { username: '', secret: 'x' })).rejects.toThrow(
      ZodError,
    )
    await expect(hostCredentials.save(ORIGIN, { username: 'alex', secret: '' })).rejects.toThrow(
      ZodError,
    )
    expect(secretStore.snapshot()).toEqual({})
  })

  it('notifies subscribers on save and delete', async () => {
    const { hostCredentials } = setup()
    const listener = vi.fn()
    const unlisten = hostCredentials.subscribe(listener)
    await hostCredentials.save(ORIGIN, { username: 'alex', secret: 'glpat-1' })
    await hostCredentials.delete(ORIGIN)
    await hostCredentials.delete(ORIGIN)
    expect(listener).toHaveBeenCalledTimes(3)
    expect(await hostCredentials.load(ORIGIN)).toBeNull()
    unlisten()
    await hostCredentials.save(ORIGIN, { username: 'alex', secret: 'glpat-1' })
    expect(listener).toHaveBeenCalledTimes(3)
  })
})
