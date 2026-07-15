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
    expect(wikiNotePath('/absolute/secret')).toBeNull()
    expect(wikiNotePath('//server/share')).toBeNull()
    expect(wikiNotePath('C:/Users/secret')).toBeNull()
    expect(wikiNotePath('file:///private/secret')).toBeNull()
    expect(wikiNotePath('https://example.com/secret')).toBeNull()
    expect(wikiNotePath('https%3A%2F%2Fexample.com/secret')).toBeNull()
    expect(wikiNotePath('%2Fabsolute/secret')).toBeNull()
    expect(wikiNotePath('Projects/%2Ehidden/secret')).toBeNull()
  })

  it('returns a decoded bare title without extension or fragment', () => {
    expect(bareWikiTitle('Launch%20Plan.md#Scope')).toBe('Launch Plan')
    expect(bareWikiTitle('Projects/Plan')).toBeNull()
    expect(bareWikiTitle('C:relative.md')).toBe('C:relative')
    expect(bareWikiTitle('https:')).toBe('https:')
    expect(bareWikiTitle('.NET')).toBe('.NET')
    expect(bareWikiTitle('mailto:foo')).toBe('mailto:foo')
    expect(bareWikiTitle('Project:Alpha')).toBe('Project:Alpha')
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

  it('distinguishes an encoded question mark in a filename from query syntax', () => {
    expect(indexMarkdownNoteReference('Today.md', 'Plans/What%3F.md')).toEqual({
      targetKey: '',
      pathKey: 'plans/what?.md',
      alternatePathKey: null,
      fragment: null,
    })
    expect(
      indexMarkdownNoteReference('Today.md', 'Plans/What.md?download=1'),
    ).toBeNull()
  })

  it('rejects traversal, hidden paths, malformed escapes, and remote links', () => {
    expect(indexMarkdownNoteReference('Today.md', '../outside.md')).toBeNull()
    expect(indexMarkdownNoteReference('Today.md', '.private/secret.md')).toBeNull()
    expect(indexMarkdownNoteReference('Today.md', 'bad%2')).toBeNull()
    expect(indexMarkdownNoteReference('Today.md', 'https://example.com/a.md')).toBeNull()
    expect(
      indexMarkdownNoteReference('Today.md', 'https%3A%2F%2Fexample.com%2Fa.md'),
    ).toBeNull()
    expect(indexMarkdownNoteReference('Today.md', '%2F%2Fserver%2Fshare.md')).toBeNull()
    expect(indexMarkdownNoteReference('Today.md', 'C%3A%2Fsecret.md')).toBeNull()
    expect(indexMarkdownNoteReference('Today.md', 'Projects/%2Ehidden/secret.md')).toBeNull()
    expect(indexMarkdownNoteReference('Today.md', 'assets/manual.pdf')).toBeNull()
    expect(indexMarkdownNoteReference('Today.md', 'assets/secret.md')).toBeNull()
    expect(indexWikiNoteReference('Today.md', '../outside')).toBeNull()
    expect(indexWikiNoteReference('Today.md', '.obsidian/secret')).toBeNull()
    expect(indexWikiNoteReference('Today.md', 'Projects/report.pdf')).toBeNull()
    expect(indexWikiNoteReference('Today.md', 'C:relative.md')?.targetKey).toBe('c:relative')
    expect(indexWikiNoteReference('Today.md', 'https://example.com/secret')).toBeNull()
    expect(indexWikiNoteReference('Today.md', 'Projects/%00secret')).toBeNull()
  })
})
