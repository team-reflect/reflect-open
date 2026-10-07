import { afterEach, describe, expect, it } from 'vitest'
import { setBridge } from '../ipc/bridge.ts'
import {
  clearHostCredential,
  loadHostCredential,
  remoteHost,
  saveHostCredential,
} from './host-credentials.ts'

afterEach(() => {
  setBridge(null)
})

/** A keychain fake keyed by secret name. */
function fakeKeychain(): Map<string, string> {
  const store = new Map<string, string>()
  setBridge({
    invoke: async (command, args) => {
      const name = String(args['name'])
      switch (command) {
        case 'secret_set':
          store.set(name, String(args['value']))
          return null
        case 'secret_get':
          return store.get(name) ?? null
        case 'secret_delete':
          store.delete(name)
          return null
        default:
          return null
      }
    },
    listen: async () => () => {},
  })
  return store
}

describe('remoteHost', () => {
  it('names the host of an HTTPS remote, lowercase, with its port', () => {
    expect(remoteHost('https://GitLab.com/alex/notes.git')).toBe('gitlab.com')
    expect(remoteHost('https://git.example.org:8443/team/notes')).toBe('git.example.org:8443')
    expect(remoteHost('http://alex@gitea.local/notes.git')).toBe('gitea.local')
  })

  it('is null for ssh and path remotes', () => {
    expect(remoteHost('git@gitlab.com:alex/notes.git')).toBeNull()
    expect(remoteHost('ssh://git@gitlab.com/alex/notes.git')).toBeNull()
    expect(remoteHost('/Volumes/NAS/notes.git')).toBeNull()
  })
})

describe('host credentials', () => {
  it('round-trips one entry per host and clears it', async () => {
    const store = fakeKeychain()
    await saveHostCredential('GitLab.com', { username: 'alex', secret: 'glpat' })
    expect([...store.keys()]).toEqual(['git-host:gitlab.com'])
    expect(await loadHostCredential('gitlab.com')).toEqual({ username: 'alex', secret: 'glpat' })
    await clearHostCredential('gitlab.com')
    expect(await loadHostCredential('gitlab.com')).toBeNull()
  })

  it('treats an unreadable entry as absent', async () => {
    const store = fakeKeychain()
    store.set('git-host:gitea.local', 'not json')
    expect(await loadHostCredential('gitea.local')).toBeNull()
  })
})
