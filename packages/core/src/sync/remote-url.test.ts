import { describe, expect, it } from 'vitest'
import {
  classifyRemote,
  githubRemoteUrl,
  githubRepoOf,
  redactRemoteUrl,
  type GitRemote,
} from './remote-url.ts'

describe('classifyRemote', () => {
  const cases: Array<[string, GitRemote]> = [
    [
      'https://github.com/alex/notes.git',
      { kind: 'github', repo: { owner: 'alex', name: 'notes' } },
    ],
    ['https://github.com/alex/notes/', { kind: 'github', repo: { owner: 'alex', name: 'notes' } }],
    ['https://github.com/alex/notes', { kind: 'github', repo: { owner: 'alex', name: 'notes' } }],
    ['http://github.com/alex/notes.git', { kind: 'https', origin: 'http://github.com' }],
    [
      'HTTPS://GitHub.com/alex/notes.git',
      { kind: 'github', repo: { owner: 'alex', name: 'notes' } },
    ],
    [
      'https://alex@github.com:443/alex/notes.git',
      { kind: 'github', repo: { owner: 'alex', name: 'notes' } },
    ],
    ['https://github.com/alex', { kind: 'https', origin: 'https://github.com' }],
    ['https://ghe.corp.com/alex/notes.git', { kind: 'https', origin: 'https://ghe.corp.com' }],
    [
      'https://gitlab.com:8443/alex/notes.git',
      { kind: 'https', origin: 'https://gitlab.com:8443' },
    ],
    ['https://GitLab.com:443/alex/notes.git', { kind: 'https', origin: 'https://gitlab.com' }],
    ['http://gitea.local/alex/notes.git', { kind: 'https', origin: 'http://gitea.local' }],
    [
      'https://alex:token@gitlab.com/alex/notes.git',
      { kind: 'https', origin: 'https://gitlab.com' },
    ],
    ['git@gitlab.com:alex/notes.git', { kind: 'ssh', host: 'gitlab.com' }],
    ['gitlab.com:alex/notes.git', { kind: 'ssh', host: 'gitlab.com' }],
    ['ssh://git@nas:2222/notes.git', { kind: 'ssh', host: 'nas' }],
    ['git@nas:/srv/git/notes.git', { kind: 'ssh', host: 'nas' }],
    ['/Volumes/NAS/notes.git', { kind: 'path' }],
    ['C:/repos/notes.git', { kind: 'path' }],
    [String.raw`C:\repos\notes.git`, { kind: 'path' }],
    ['git://nas/notes.git', { kind: 'path' }],
    ['file:///tmp/notes.git', { kind: 'path' }],
    ['../notes.git', { kind: 'path' }],
    ['https://', { kind: 'path' }],
  ]

  it.each(cases)('%s', (url, expected) => {
    expect(classifyRemote(url)).toEqual(expected)
  })
})

describe('githubRepoOf', () => {
  it('is the repo of a GitHub remote and null otherwise', () => {
    expect(githubRepoOf(classifyRemote(githubRemoteUrl({ owner: 'alex', name: 'notes' })))).toEqual(
      {
        owner: 'alex',
        name: 'notes',
      },
    )
    expect(githubRepoOf({ kind: 'ssh', host: 'gitlab.com' })).toBeNull()
  })
})

describe('redactRemoteUrl', () => {
  it('drops the user info a URL-form remote embeds', () => {
    expect(redactRemoteUrl('https://alex:token@gitlab.com/alex/notes.git')).toBe(
      'https://gitlab.com/alex/notes.git',
    )
    expect(redactRemoteUrl('ssh://git@nas:2222/notes.git')).toBe('ssh://nas:2222/notes.git')
  })

  it('still drops the user info when the URL does not parse', () => {
    expect(redactRemoteUrl('https://alex:token@bad host/notes.git')).toBe(
      'https://bad host/notes.git',
    )
  })

  it('leaves every other form alone', () => {
    expect(redactRemoteUrl('https://gitlab.com/alex/notes.git')).toBe(
      'https://gitlab.com/alex/notes.git',
    )
    expect(redactRemoteUrl('git@gitlab.com:alex/notes.git')).toBe('git@gitlab.com:alex/notes.git')
    expect(redactRemoteUrl('/srv/git/notes.git')).toBe('/srv/git/notes.git')
  })
})
