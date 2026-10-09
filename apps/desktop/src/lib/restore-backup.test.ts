import { describe, expect, it } from 'vitest'
import { parseBackupSource } from './restore-backup.ts'

describe('parseBackupSource', () => {
  it('reads owner/name as a GitHub repository', () => {
    expect(parseBackupSource(' alex/notes ')).toEqual({
      url: 'https://github.com/alex/notes.git',
      name: 'notes',
      github: true,
    })
    expect(parseBackupSource('alex/notes.git')?.name).toBe('notes')
  })

  it('reads a full URL and names the folder after the repository', () => {
    expect(parseBackupSource('https://gitlab.com/alex/my-notes.git')).toEqual({
      url: 'https://gitlab.com/alex/my-notes.git',
      name: 'my-notes',
      github: false,
    })
    expect(parseBackupSource('git@github.com:alex/notes.git')).toMatchObject({
      name: 'notes',
      github: false, // an SSH remote uses the agent, not the GitHub sign-in
    })
    expect(parseBackupSource('https://github.com/alex/notes')).toMatchObject({ github: true })
  })

  it('rejects anything that is neither', () => {
    expect(parseBackupSource('')).toBeNull()
    expect(parseBackupSource('notes')).toBeNull()
    expect(parseBackupSource('https://gitlab.com/')).toBeNull()
    expect(parseBackupSource('a/b/c')).toBeNull()
  })
})
