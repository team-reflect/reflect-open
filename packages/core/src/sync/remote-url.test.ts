import { describe, expect, it } from 'vitest'
import { classifyRemote, githubRemoteUrl, githubRepoOf, type GitRemote } from './remote-url.ts'

describe('classifyRemote', () => {
  const cases: Array<[string, GitRemote]> = [
    [
      'https://github.com/alex/notes.git',
      { kind: 'github', repo: { owner: 'alex', name: 'notes' } },
    ],
    ['https://github.com/alex/notes/', { kind: 'github', repo: { owner: 'alex', name: 'notes' } }],
    ['https://github.com/alex/notes', { kind: 'github', repo: { owner: 'alex', name: 'notes' } }],
    ['http://github.com/alex/notes.git', { kind: 'https', origin: 'http://github.com' }],
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
    ['/Volumes/NAS/notes.git', { kind: 'path' }],
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
