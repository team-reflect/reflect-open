import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge.ts'
import {
  deleteGitCredential,
  gitCredentialSecretName,
  githubCredential,
  loadGitCredential,
  remoteCredentialOrigin,
  saveGitCredential,
} from './git-credentials.ts'

afterEach(() => {
  setBridge(null)
})

/** Keychain fake over the bridge: one in-memory secret store. */
function fakeKeychain(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  setBridge({
    invoke: async (command, args) => {
      const name = args['name'] as string
      if (command === 'secret_get') {
        return store.get(name) ?? null
      }
      if (command === 'secret_set') {
        store.set(name, args['value'] as string)
        return null
      }
      if (command === 'secret_delete') {
        store.delete(name)
        return null
      }
      throw new Error(`unexpected command ${command}`)
    },
    listen: async () => () => {},
  })
  return store
}

const CREDENTIAL = { username: 'alex', secret: 'pat' }

describe('remoteCredentialOrigin', () => {
  it('keys a credential by scheme, host and port', () => {
    expect(remoteCredentialOrigin('https://git.example.com:8443/alex/notes.git')).toBe(
      'https://git.example.com:8443',
    )
    expect(remoteCredentialOrigin('http://git.example.com:8443/alex/notes.git')).toBe(
      'http://git.example.com:8443',
    )
  })

  it('normalises case and the default port, so equivalent URLs share a credential', () => {
    expect(remoteCredentialOrigin('HTTPS://Git.Example.com:443/alex/notes.git')).toBe(
      'https://git.example.com',
    )
  })

  it('gives SSH, path and unparsable remotes no credential identity', () => {
    expect(remoteCredentialOrigin('git@git.example.com:alex/notes.git')).toBeNull()
    expect(remoteCredentialOrigin('ssh://git@git.example.com/alex/notes.git')).toBeNull()
    expect(remoteCredentialOrigin('/srv/backups/notes.git')).toBeNull()
    expect(remoteCredentialOrigin('https://exa mple.com/notes.git')).toBeNull()
  })
})

describe('the credential store', () => {
  it('round-trips a credential for the remote it was saved against', async () => {
    fakeKeychain()
    await saveGitCredential('https://git.example.com/alex/notes.git', CREDENTIAL)

    expect(await loadGitCredential('https://git.example.com/alex/notes.git')).toEqual(CREDENTIAL)
    // Same origin, different repository: the credential is per host, not per repo.
    expect(await loadGitCredential('https://git.example.com/alex/work.git')).toEqual(CREDENTIAL)
  })

  it('never hands an https credential to the http form of the same host', async () => {
    fakeKeychain()
    await saveGitCredential('https://git.example.com/alex/notes.git', CREDENTIAL)

    expect(await loadGitCredential('http://git.example.com/alex/notes.git')).toBeNull()
  })

  it('never hands a credential to another port on the same host', async () => {
    fakeKeychain()
    await saveGitCredential('https://git.example.com:8443/alex/notes.git', CREDENTIAL)

    expect(await loadGitCredential('https://git.example.com/alex/notes.git')).toBeNull()
  })

  it('treats a corrupt entry as absent, and says so', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    fakeKeychain({ [gitCredentialSecretName('https://git.example.com')]: 'not json' })

    expect(await loadGitCredential('https://git.example.com/alex/notes.git')).toBeNull()
    expect(errorSpy).toHaveBeenCalledOnce()
    errorSpy.mockRestore()
  })

  it('refuses to store a credential for a remote that takes none', async () => {
    fakeKeychain()
    await expect(
      saveGitCredential('git@git.example.com:alex/notes.git', CREDENTIAL),
    ).rejects.toThrow('takes no credential')
  })

  it('forgets a credential, idempotently', async () => {
    const store = fakeKeychain()
    await saveGitCredential('https://git.example.com/alex/notes.git', CREDENTIAL)
    await deleteGitCredential('https://git.example.com/alex/notes.git')
    await deleteGitCredential('https://git.example.com/alex/notes.git')

    expect(store.size).toBe(0)
  })
})

describe('githubCredential', () => {
  it('presents the managed sign-in as x-access-token basic auth', () => {
    expect(githubCredential('ghs_token')).toEqual({
      username: 'x-access-token',
      secret: 'ghs_token',
    })
  })
})
