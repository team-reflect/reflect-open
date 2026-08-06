import { describe, expect, it } from 'vitest'
import { markdownNoteReference, noteBasenameKey, wikiNoteReference } from './note-reference'

describe('wikiNoteReference', () => {
  it('reads a bare target as a folded name key', () => {
    expect(wikiNoteReference('  Weekly Plan  ')).toEqual({ kind: 'key', key: 'weekly plan' })
  })

  it('drops a trailing .md from a bare target', () => {
    expect(wikiNoteReference('Plan.md')).toEqual({ kind: 'key', key: 'plan' })
  })

  it('reads a slashed target as a path with a name fallback, never source-relative', () => {
    expect(wikiNoteReference('Projects/Plan')).toEqual({
      kind: 'pathOrKey',
      path: 'Projects/Plan.md',
      key: 'projects/plan',
    })
  })

  it('strips a fragment so it never reaches the lookup', () => {
    expect(wikiNoteReference('Plan#Next steps')).toEqual({ kind: 'key', key: 'plan' })
    expect(wikiNoteReference('Projects/Plan#Next')).toEqual({
      kind: 'pathOrKey',
      path: 'Projects/Plan.md',
      key: 'projects/plan',
    })
  })

  it('reads a fragment-only target as the source note, never as a new note', () => {
    // Guards note creation: a `missing` here would make clicking `[[#Next]]`
    // create a note called `#Next`.
    expect(wikiNoteReference('#Next')).toEqual({ kind: 'self' })
  })

  it('collapses . and .. inside a vault path', () => {
    expect(wikiNoteReference('Projects/./sub/../Plan')).toEqual({
      kind: 'pathOrKey',
      path: 'Projects/Plan.md',
      key: 'projects/./sub/../plan',
    })
  })

  it('keeps a loose slash inside a name, like a v1 subject alias', () => {
    // `[[Tim MacCaw // Dad]]` is a name with a `//` separator, not a path:
    // path segments are never empty or wrapped in spaces.
    expect(wikiNoteReference('Tim MacCaw // Dad')).toEqual({
      kind: 'key',
      key: 'tim maccaw // dad',
    })
    expect(wikiNoteReference('a / b')).toEqual({ kind: 'key', key: 'a / b' })
    // An explicit leading slash is always a strict path, even for a root-level file.
    expect(wikiNoteReference('/Plan')).toEqual({ kind: 'path', path: 'Plan.md' })
  })

  it('keeps a colon inside a bare name, only refusing a real authority form', () => {
    expect(wikiNoteReference('Test: Long With Parens & Ampersand Follow-up')).toEqual({
      kind: 'key',
      key: 'test: long with parens & ampersand follow-up',
    })
    expect(wikiNoteReference('Test:Colon NoSpace Link')).toEqual({
      kind: 'key',
      key: 'test:colon nospace link',
    })
    expect(wikiNoteReference('C: drive')).toEqual({ kind: 'key', key: 'c: drive' })
    expect(wikiNoteReference('9:30 standup')).toEqual({ kind: 'key', key: '9:30 standup' })
    expect(wikiNoteReference('mailto:x@y.com')).toEqual({ kind: 'key', key: 'mailto:x@y.com' })
  })

  it('carries both readings for a slashed name', () => {
    expect(wikiNoteReference('john/sally meeting notes')).toEqual({
      kind: 'pathOrKey',
      path: 'john/sally meeting notes.md',
      key: 'john/sally meeting notes',
    })
    expect(wikiNoteReference('A/B testing')).toEqual({
      kind: 'pathOrKey',
      path: 'A/B testing.md',
      key: 'a/b testing',
    })
    expect(wikiNoteReference('Notes/Plan-2.md')).toEqual({
      kind: 'pathOrKey',
      path: 'Notes/Plan-2.md',
      key: 'notes/plan-2',
    })
  })

  it('treats a percent sign as a literal character', () => {
    expect(wikiNoteReference('100%')).toEqual({ kind: 'key', key: '100%' })
    expect(wikiNoteReference('50% off')).toEqual({ kind: 'key', key: '50% off' })
    expect(wikiNoteReference('Projects/100% Off')).toEqual({
      kind: 'pathOrKey',
      path: 'Projects/100% Off.md',
      key: 'projects/100% off',
    })
    // No decoding: this names a file literally called `My%20Plan.md`.
    expect(wikiNoteReference('Projects/My%20Plan')).toEqual({
      kind: 'pathOrKey',
      path: 'Projects/My%20Plan.md',
      key: 'projects/my%20plan',
    })
  })

  it.each([
    ['escapes the vault', '../outside/Plan'],
    ['hides behind a dot component', '.obsidian/Plan'],
    ['names another scheme', 'https://example.com/Plan'],
    ['uses a backslash separator', String.raw`Projects\Plan`],
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
    expect(noteBasenameKey('Cafe\u{301}.md')).toBe('caf\u{E9}')
    expect(noteBasenameKey('Caf\u{E9}.md')).toBe('caf\u{E9}')
  })
})
