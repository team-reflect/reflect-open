import { describe, expect, it } from 'vitest'
import { AppError } from '../errors.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import { createTestSecretStoreService } from '../testing/secrets.ts'
import { createTestGitRepositoryService, createTestGitSyncService } from '../testing/sync.ts'
import { createGitHostCredentialService } from './git-host-credential-service.ts'
import { createHostConnector } from './host-connector.ts'

const GENERATION = 3
const URL = 'https://gitlab.com/alex/notes.git'
const INPUT = { remoteUrl: URL, username: 'alex', token: 'glpat-1' }

function setup({ keychainLocked = false } = {}) {
  const git = createTestGitRepositoryService({ initialized: false, remoteUrl: null })
  const secretStore = createTestSecretStoreService()
  const hostCredentials = createGitHostCredentialService({
    secretStore: keychainLocked
      ? {
          get: (name) => secretStore.get(name),
          set: () => Promise.reject(new Error('keychain locked')),
          delete: (name) => secretStore.delete(name),
        }
      : secretStore,
    logger: createTestLoggerService(),
  })
  const gitSync = createTestGitSyncService()
  const connector = createHostConnector({ git, hostCredentials, gitSync, generation: GENERATION })
  return { git, secretStore, gitSync, connector }
}

describe('HostConnector', () => {
  it('probes the host with the sign-in, then stores it and connects', async () => {
    const { git, secretStore, gitSync, connector } = setup()
    git.onRemoteHead(() => ({ remoteOid: 'a', trackingOid: null, defaultBranch: 'master' }))

    await connector.connectHost({ ...INPUT, remoteUrl: `  ${URL}  `, token: ' glpat-1 ' })

    expect(git.calls().map((call) => call.method)).toEqual(['setup', 'remoteHead'])
    expect(git.calls()[1]?.args).toEqual([{ username: 'alex', secret: 'glpat-1' }, GENERATION, URL])
    expect(secretStore.snapshot()).toEqual({
      'git-credential:https://gitlab.com': JSON.stringify({ username: 'alex', secret: 'glpat-1' }),
    })
    // The remote already holds notes on `master`: the local branch takes that name.
    expect(gitSync.calls()).toEqual([{ method: 'connectRemote', remoteUrl: URL, branch: 'master' }])
  })

  it('stores nothing when the host refuses the sign-in', async () => {
    const { git, secretStore, gitSync, connector } = setup()
    git.onRemoteHead(() => {
      throw new AppError('auth', 'the host rejected the stored sign-in')
    })

    await expect(connector.connectHost(INPUT)).rejects.toThrow('rejected')
    expect(secretStore.snapshot()).toEqual({})
    expect(gitSync.calls()).toEqual([])
  })

  it('connects nothing when the keychain refuses the sign-in', async () => {
    const { git, gitSync, connector } = setup({ keychainLocked: true })

    await expect(connector.connectHost(INPUT)).rejects.toThrow('keychain locked')
    expect(git.calls().map((call) => call.method)).toEqual(['setup', 'remoteHead'])
    expect(gitSync.calls()).toEqual([])
  })

  it('accepts an upper-case scheme', async () => {
    const { gitSync, connector } = setup()
    await connector.connectHost({ ...INPUT, remoteUrl: 'HTTPS://gitlab.com/alex/notes.git' })
    expect(gitSync.calls()).toEqual([
      { method: 'connectRemote', remoteUrl: 'HTTPS://gitlab.com/alex/notes.git', branch: null },
    ])
  })

  it('refuses GitHub, plain http, a sign-in in the URL, SSH, and empty fields before touching anything', async () => {
    const { git, secretStore, connector } = setup()
    const refused = [
      { ...INPUT, remoteUrl: 'https://github.com/alex/notes.git' },
      { ...INPUT, remoteUrl: 'http://gitlab.com/alex/notes.git' },
      { ...INPUT, remoteUrl: 'https://alex:glpat-1@gitlab.com/alex/notes.git' },
      { ...INPUT, remoteUrl: 'git@gitlab.com:alex/notes.git' },
      { ...INPUT, remoteUrl: '/Volumes/NAS/notes.git' },
      { ...INPUT, username: ' ' },
      { ...INPUT, token: '' },
    ]
    for (const input of refused) {
      await expect(connector.connectHost(input)).rejects.toThrow(AppError)
    }
    expect(git.calls()).toEqual([])
    expect(secretStore.snapshot()).toEqual({})
  })

  it('connects an empty remote without a branch to align', async () => {
    const { gitSync, connector } = setup()
    await connector.connectHost(INPUT)
    expect(gitSync.calls()).toEqual([{ method: 'connectRemote', remoteUrl: URL, branch: null }])
  })
})
