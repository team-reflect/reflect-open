import { describe, expect, it } from 'vitest'
import {
  bareWikiTitle,
  indexMarkdownNoteReference,
  indexWikiNoteReference,
  noteBasenameKey,
  notePathKey,
  wikiNotePath,
} from './local-note-reference'

describe('local note references', () => {
  it('derives stable path and basename keys', () => {
    expect(notePathKey('Projects/Caf\u00e9.md')).toBe('projects/caf\u00e9.md')
    expect(notePathKey('Projects/Cafe\u0301.md')).toBe('projects/caf\u00e9.md')
    expect(noteBasenameKey('Projects/Launch Plan.md')).toBe('launch plan')
  })

  it('indexes bare wiki targets for ranked title, alias, and basename lookup', () => {
    expect(indexWikiNoteReference('Work/Today.md', ' Plan.md#Next steps ')).toEqual({
      targetKey: 'plan',
      pathKey: null,
      alternatePathKey: null,
      fragment: 'Next steps',
    })
  })

  it('indexes path-qualified wiki targets from the vault root', () => {
    expect(indexWikiNoteReference('Work/Today.md', 'Projects/Launch%20Plan#Scope')).toEqual({
      targetKey: '',
      pathKey: 'projects/launch plan.md',
      alternatePathKey: null,
      fragment: 'Scope',
    })
  })

  it('returns the safe authored path for exact-path creation', () => {
    expect(wikiNotePath('Projects/Launch%20Plan#Scope')).toBe('Projects/Launch Plan.md')
    expect(wikiNotePath('../outside')).toBeNull()
    expect(wikiNotePath('assets/secret')).toBeNull()
  })

  it('returns a decoded bare title without extension or fragment', () => {
    expect(bareWikiTitle('Launch%20Plan.md#Scope')).toBe('Launch Plan')
    expect(bareWikiTitle('Projects/Plan')).toBeNull()
  })

  it('indexes same-note wiki heading links', () => {
    expect(indexWikiNoteReference('Work/Today.md', '#Next%20steps')).toEqual({
      targetKey: '',
      pathKey: 'work/today.md',
      alternatePathKey: null,
      fragment: 'Next steps',
    })
  })

  it('honors explicit Markdown root and relative paths', () => {
    expect(indexMarkdownNoteReference('Projects/Today.md', '/People/Ada.md#Bio')).toEqual({
      targetKey: '',
      pathKey: 'people/ada.md',
      alternatePathKey: null,
      fragment: 'Bio',
    })
    expect(indexMarkdownNoteReference('Projects/Today.md', '../People/Ada')).toEqual({
      targetKey: '',
      pathKey: 'people/ada.md',
      alternatePathKey: null,
      fragment: null,
    })
  })

  it('retains both interpretations of an unqualified Markdown path', () => {
    expect(indexMarkdownNoteReference('Projects/Today.md', 'Plans/Q3.md')).toEqual({
      targetKey: '',
      pathKey: 'projects/plans/q3.md',
      alternatePathKey: 'plans/q3.md',
      fragment: null,
    })
  })

  it('collapses equivalent root and source-relative candidates', () => {
    expect(indexMarkdownNoteReference('Today.md', 'Plans/Q3')).toEqual({
      targetKey: '',
      pathKey: 'plans/q3.md',
      alternatePathKey: null,
      fragment: null,
    })
  })

  it('rejects traversal, hidden paths, malformed escapes, and remote links', () => {
    expect(indexMarkdownNoteReference('Today.md', '../outside.md')).toBeNull()
    expect(indexMarkdownNoteReference('Today.md', '.private/secret.md')).toBeNull()
    expect(indexMarkdownNoteReference('Today.md', 'bad%2')).toBeNull()
    expect(indexMarkdownNoteReference('Today.md', 'https://example.com/a.md')).toBeNull()
    expect(indexMarkdownNoteReference('Today.md', 'assets/manual.pdf')).toBeNull()
    expect(indexMarkdownNoteReference('Today.md', 'assets/secret.md')).toBeNull()
    expect(indexWikiNoteReference('Today.md', '../outside')).toBeNull()
    expect(indexWikiNoteReference('Today.md', '.obsidian/secret')).toBeNull()
    expect(indexWikiNoteReference('Today.md', 'Projects/report.pdf')).toBeNull()
  })
})
