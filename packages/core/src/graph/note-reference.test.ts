import { describe, expect, it } from 'vitest'
import { markdownNoteReference, noteBasenameKey, wikiNoteReference } from './note-reference'

describe('wikiNoteReference', () => {
  it('reads a bare target as a folded name key', () => {
    expect(wikiNoteReference('  Weekly Plan  ')).toEqual({ kind: 'key', key: 'weekly plan' })
  })

  it('drops a trailing .md from a bare target', () => {
    expect(wikiNoteReference('Plan.md')).toEqual({ kind: 'key', key: 'plan' })
  })

  it('reads a slashed target as a vault-root path, never source-relative', () => {
    expect(wikiNoteReference('Projects/Plan')).toEqual({
      kind: 'path',
      path: 'Projects/Plan.md',
    })
  })

  it('strips a fragment so it never reaches the lookup', () => {
    expect(wikiNoteReference('Plan#Next steps')).toEqual({ kind: 'key', key: 'plan' })
    expect(wikiNoteReference('Projects/Plan#Next')).toEqual({
      kind: 'path',
      path: 'Projects/Plan.md',
    })
  })

  it('reads a fragment-only target as the source note, never as a new note', () => {
    // Guards note creation: a `missing` here would make clicking `[[#Next]]`
    // create a note called `#Next`.
    expect(wikiNoteReference('#Next')).toEqual({ kind: 'self' })
  })

  it('collapses . and .. inside a vault path', () => {
    expect(wikiNoteReference('Projects/./sub/../Plan')).toEqual({
      kind: 'path',
      path: 'Projects/Plan.md',
    })
  })

  it('treats a percent sign as a literal character', () => {
    expect(wikiNoteReference('100%')).toEqual({ kind: 'key', key: '100%' })
    expect(wikiNoteReference('50% off')).toEqual({ kind: 'key', key: '50% off' })
    expect(wikiNoteReference('Projects/100% Off')).toEqual({
      kind: 'path',
      path: 'Projects/100% Off.md',
    })
    // No decoding: this names a file literally called `My%20Plan.md`.
    expect(wikiNoteReference('Projects/My%20Plan')).toEqual({
      kind: 'path',
      path: 'Projects/My%20Plan.md',
    })
  })

  it.each([
    ['escapes the vault', '../outside/Plan'],
    ['hides behind a dot component', '.obsidian/Plan'],
    ['names another scheme', 'https://example.com/Plan'],
    ['uses a backslash separator', 'Projects\\Plan'],
    ['carries a non-Markdown extension', 'Media/photo.png'],
    ['is empty', '   '],
  ])('refuses a target that %s', (_reason, target) => {
    expect(wikiNoteReference(target)).toBeNull()
  })
})

describe('markdownNoteReference', () => {
  it('resolves relative to the source note', () => {
    expect(markdownNoteReference('Projects/deep/Note.md', './Plan.md')).toEqual({
      kind: 'path',
      path: 'Projects/deep/Plan.md',
    })
    expect(markdownNoteReference('Projects/deep/Note.md', '../Plan.md')).toEqual({
      kind: 'path',
      path: 'Projects/Plan.md',
    })
  })

  it('treats an unqualified href as source-relative, not vault-root', () => {
    expect(markdownNoteReference('Projects/Note.md', 'Plan.md')).toEqual({
      kind: 'path',
      path: 'Projects/Plan.md',
    })
  })

  it('treats a leading slash as vault-root', () => {
    expect(markdownNoteReference('Projects/Note.md', '/Plan.md')).toEqual({
      kind: 'path',
      path: 'Plan.md',
    })
  })

  it('strips a fragment and reads a bare one as the source note', () => {
    expect(markdownNoteReference('Note.md', 'Plan.md#Next')).toEqual({
      kind: 'path',
      path: 'Plan.md',
    })
    expect(markdownNoteReference('Note.md', '#Next')).toEqual({ kind: 'self' })
  })

  it('percent-decodes the authored href', () => {
    expect(markdownNoteReference('Projects/Note.md', 'My%20Plan.md')).toEqual({
      kind: 'path',
      path: 'Projects/My Plan.md',
    })
  })

  it('reaches a hash-named file, the only spelling that can', () => {
    expect(markdownNoteReference('Note.md', 'c%23-notes.md')).toEqual({
      kind: 'path',
      path: 'c#-notes.md',
    })
  })

  it.each([
    ['an external scheme', 'https://example.com/x.md'],
    ['a protocol-relative href', '//example.com/x.md'],
    ['a query string', 'Plan.md?raw=1'],
    ['an attachment', '../Media/photo.png'],
    ['an escape above the vault root', '../../outside.md'],
    ['a malformed percent escape', '%zz.md'],
  ])('refuses %s', (_reason, href) => {
    expect(markdownNoteReference('Projects/Note.md', href)).toBeNull()
  })
})

describe('noteBasenameKey', () => {
  it('folds the filename stem', () => {
    expect(noteBasenameKey('Projects/Weekly Plan.md')).toBe('weekly plan')
    // NFD filename (as macOS reports it), NFC key: the fold normalizes.
    expect(noteBasenameKey('Cafe\u0301.md')).toBe('caf\u00e9')
    expect(noteBasenameKey('Caf\u00e9.md')).toBe('caf\u00e9')
  })
})
