import { describe, expect, it } from 'vitest'
import { remoteLabel } from './remote-label.ts'

describe('remoteLabel', () => {
  it('names a GitHub repository by owner and name', () => {
    expect(
      remoteLabel(
        { kind: 'github', repo: { owner: 'alex', name: 'notes' } },
        'https://github.com/alex/notes.git',
      ),
    ).toBe('alex/notes on GitHub')
  })

  it('names another host by host and path, without scheme, suffix or sign-in', () => {
    expect(
      remoteLabel(
        { kind: 'https', origin: 'https://gitlab.com' },
        'https://alex:glpat-1@gitlab.com/alex/notes.git',
      ),
    ).toBe('gitlab.com/alex/notes')
    expect(
      remoteLabel(
        { kind: 'https', origin: 'https://gitlab.com' },
        'https://gitlab.com/alex/notes.GIT/',
      ),
    ).toBe('gitlab.com/alex/notes')
    expect(
      remoteLabel(
        { kind: 'https', origin: 'https://gitlab.com' },
        'https://gitlab.com/alex/notes.git?token=glpat-1#x',
      ),
    ).toBe('gitlab.com/alex/notes')
  })

  it('keeps SSH and path remotes as written, less any sign-in', () => {
    expect(remoteLabel({ kind: 'ssh', host: 'nas' }, 'git@nas:notes.git')).toBe('git@nas:notes.git')
    expect(remoteLabel({ kind: 'ssh', host: 'nas' }, 'ssh://alex:pw@nas/notes.git')).toBe(
      'ssh://nas/notes.git',
    )
    expect(remoteLabel({ kind: 'path' }, '/Volumes/NAS/notes.git')).toBe('/Volumes/NAS/notes.git')
  })
})
