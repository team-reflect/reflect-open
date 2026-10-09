import { describe, expect, it } from 'vitest'
import { readNoteAliases, rejectAlias, withAlias, withoutAlias } from './note-aliases.ts'

describe('readNoteAliases', () => {
  it('splits frontmatter aliases from title segments, dropping the display title', () => {
    const source = '---\naliases:\n  - QBR\n---\n\n# Quarterly Budget Review // Budget\n'
    expect(readNoteAliases('notes/qbr.md', source)).toEqual({
      title: 'Quarterly Budget Review // Budget',
      frontmatter: ['QBR'],
      fromTitle: ['Budget'],
    })
  })

  it('reports none for a plain note', () => {
    expect(readNoteAliases('notes/plain.md', '# Plain\n')).toEqual({
      title: 'Plain',
      frontmatter: [],
      fromTitle: [],
    })
  })
})

describe('rejectAlias', () => {
  const aliases = {
    title: 'Quarterly Budget Review // Budget',
    frontmatter: ['QBR'],
    fromTitle: ['Budget'],
  }

  it('accepts a new name', () => {
    expect(rejectAlias('  Q4 review ', aliases)).toBeNull()
  })

  it('refuses blanks, link syntax, and names the note already has', () => {
    expect(rejectAlias('   ', aliases)).toBe('empty')
    expect(rejectAlias('a|b', aliases)).toBe('invalid')
    expect(rejectAlias('[[a]]', aliases)).toBe('invalid')
    expect(rejectAlias('a // b', aliases)).toBe('invalid')
    expect(rejectAlias('qbr', aliases)).toBe('duplicate')
    expect(rejectAlias('budget', aliases)).toBe('duplicate')
    expect(rejectAlias('Quarterly Budget Review', aliases)).toBe('duplicate')
  })
})

describe('withAlias / withoutAlias', () => {
  it('appends trimmed and removes case-insensitively', () => {
    expect(withAlias(['QBR'], ' Budget ')).toEqual(['QBR', 'Budget'])
    expect(withoutAlias(['QBR', 'Budget'], 'qbr')).toEqual(['Budget'])
  })
})
