import { describe, expect, it } from 'vitest'
import { parseRepoInput, suggestRepoName } from './github-repos'

describe('parseRepoInput', () => {
  it('accepts owner/name and full GitHub URLs', () => {
    expect(parseRepoInput('alex/notes')).toEqual({ owner: 'alex', name: 'notes' })
    expect(parseRepoInput('  alex/notes  ')).toEqual({ owner: 'alex', name: 'notes' })
    expect(parseRepoInput('https://github.com/alex/notes.git')).toEqual({
      owner: 'alex',
      name: 'notes',
    })
    expect(parseRepoInput('my-org/notes.backup')).toEqual({
      owner: 'my-org',
      name: 'notes.backup',
    })
  })

  it('rejects anything that is neither form', () => {
    expect(parseRepoInput('')).toBeNull()
    expect(parseRepoInput('just-a-name')).toBeNull()
    expect(parseRepoInput('a/b/c')).toBeNull()
    expect(parseRepoInput('git@github.com:alex/notes.git')).toBeNull()
    expect(parseRepoInput('https://gitlab.com/alex/notes')).toBeNull()
  })
})

describe('suggestRepoName', () => {
  it('slugs the graph name with a -backup suffix', () => {
    expect(suggestRepoName('Alex Notes')).toBe('alex-notes-backup')
    expect(suggestRepoName('  Déjà vu!  ')).toBe('d-j-vu-backup')
  })

  it('falls back when the name slugs away to nothing', () => {
    expect(suggestRepoName(undefined)).toBe('reflect-backup')
    expect(suggestRepoName('***')).toBe('reflect-backup')
  })
})
