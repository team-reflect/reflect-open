import { describe, expect, it } from 'vitest'
import { parseNote } from '../markdown'
import { buildIndexedNote, indexedNoteSchema } from './indexed-note'

describe('buildIndexedNote', () => {
  it('flattens a parsed note into the index payload', () => {
    const source =
      '---\nid: 01H\naliases: [PJX, "Proj X"]\nprivate: true\npinned: true\n---\n' +
      '# Project X\n\nLinks [[Charlotte]] and [[Note|alias]] and #status. ' +
      'See [site](https://x.com) and ![p](assets/p.png).'
    const indexed = buildIndexedNote(parseNote({ path: 'notes/project-x.md', source }), {
      fileHash: 'abc',
      mtime: 123,
    })

    expect(indexed.path).toBe('notes/project-x.md')
    expect(indexed.id).toBe('01H')
    expect(indexed.title).toBe('Project X')
    expect(indexed.titleKey).toBe('project x')
    expect(indexed.isPrivate).toBe(true)
    expect(indexed.isPinned).toBe(true)
    expect(indexed.pinnedOrder).toBeNull() // bare `pinned: true` carries no order
    expect(indexed.fileHash).toBe('abc')
    expect(indexed.mtime).toBe(123)
    expect(indexed.aliases).toEqual([
      { alias: 'PJX', aliasKey: 'pjx' },
      { alias: 'Proj X', aliasKey: 'proj x' },
    ])
    expect(indexed.tags).toEqual([{ tag: 'status', tagKey: 'status' }])

    const wiki = indexed.links.filter((link) => link.kind === 'wiki')
    expect(
      wiki.map((link) => ({ targetRaw: link.targetRaw, targetKey: link.targetKey, alias: link.alias })),
    ).toEqual([
      { targetRaw: 'Charlotte', targetKey: 'charlotte', alias: null },
      { targetRaw: 'Note', targetKey: 'note', alias: 'alias' },
    ])
    expect(indexed.links.some((link) => link.kind === 'md' && link.targetRaw === 'https://x.com')).toBe(
      true,
    )
    expect(indexed.assets).toEqual(['assets/p.png'])
  })

  it('derives the list preview and folded tag keys at index time', () => {
    const indexed = buildIndexedNote(
      parseNote({ path: 'notes/p.md', source: '# Plans\n\nFirst body line. #CAFÉ' }),
      { fileHash: 'h', mtime: 0 },
    )
    expect(indexed.preview).toBe('First body line. #CAFÉ')
    // Folding is Unicode-aware — exactly what SQLite's ASCII-only lower() misses.
    expect(indexed.tags).toEqual([{ tag: 'CAFÉ', tagKey: 'café' }])
  })

  it('marks daily notes with their date and carries no id', () => {
    const indexed = buildIndexedNote(
      parseNote({ path: 'daily/2026-06-09.md', source: 'today' }),
      { fileHash: 'h', mtime: 0 },
    )
    expect(indexed.dailyDate).toBe('2026-06-09')
    expect(indexed.title).toBe('2026-06-09')
    expect(indexed.id).toBeNull()
    expect(indexed.isPrivate).toBe(false)
    expect(indexed.isPinned).toBe(false)
  })

  it('projects an explicit pin order', () => {
    const indexed = buildIndexedNote(
      parseNote({ path: 'notes/n.md', source: '---\npinned: 2\n---\n# N' }),
      { fileHash: 'h', mtime: 0 },
    )
    expect(indexed.isPinned).toBe(true)
    expect(indexed.pinnedOrder).toBe(2)
  })

  it('produces a payload that satisfies the cross-language contract schema', () => {
    // Guards the TS half of the TS↔Rust `IndexedNote` contract: if a field is
    // dropped or mistyped here, the schema parse fails before it can desync from
    // the serde struct in db.rs.
    const source = '---\naliases: [Alt]\n---\n# Title\n\n[[Link]] #tag [x](http://x)'
    const indexed = buildIndexedNote(parseNote({ path: 'notes/n.md', source }), {
      fileHash: 'h',
      mtime: 1,
    })
    expect(() => indexedNoteSchema.parse(indexed)).not.toThrow()
  })
})
