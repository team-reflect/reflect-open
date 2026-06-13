import { describe, expect, it } from 'vitest'
import { gistBodyHash, parseNote } from '../markdown'
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
      source,
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
    const source = '# Plans\n\nFirst body line. #CAFÉ'
    const indexed = buildIndexedNote(parseNote({ path: 'notes/p.md', source }), {
      fileHash: 'h',
      mtime: 0,
      source,
    })
    expect(indexed.preview).toBe('First body line. #CAFÉ')
    // Folding is Unicode-aware — exactly what SQLite's ASCII-only lower() misses.
    expect(indexed.tags).toEqual([{ tag: 'CAFÉ', tagKey: 'café' }])
  })

  it('marks daily notes with their date and carries no id', () => {
    const indexed = buildIndexedNote(parseNote({ path: 'daily/2026-06-09.md', source: 'today' }), {
      fileHash: 'h',
      mtime: 0,
      source: 'today',
    })
    expect(indexed.dailyDate).toBe('2026-06-09')
    expect(indexed.title).toBe('2026-06-09')
    expect(indexed.id).toBeNull()
    expect(indexed.isPrivate).toBe(false)
    expect(indexed.isPinned).toBe(false)
  })

  it('projects an explicit pin order', () => {
    const source = '---\npinned: 2\n---\n# N'
    const indexed = buildIndexedNote(parseNote({ path: 'notes/n.md', source }), {
      fileHash: 'h',
      mtime: 0,
      source,
    })
    expect(indexed.isPinned).toBe(true)
    expect(indexed.pinnedOrder).toBe(2)
  })

  it('projects no gist state for an unpublished note', () => {
    const source = '# N\n\nbody'
    const indexed = buildIndexedNote(parseNote({ path: 'notes/n.md', source }), {
      fileHash: 'h',
      mtime: 0,
      source,
    })
    expect(indexed.gistUrl).toBeNull()
    expect(indexed.gistStale).toBe(false)
  })

  it('projects the gist url and computes staleness from the body hash', () => {
    const body = '# N\n\npublished body\n'
    const block = (hash: string): string =>
      `---\ngist:\n  id: g1\n  url: https://gist.github.com/alex/g1\n  file: N.md\n  hash: ${hash}\n---\n`

    const fresh = block(gistBodyHash(body)) + body
    const indexedFresh = buildIndexedNote(parseNote({ path: 'notes/n.md', source: fresh }), {
      fileHash: 'h',
      mtime: 0,
      source: fresh,
    })
    expect(indexedFresh.gistUrl).toBe('https://gist.github.com/alex/g1')
    expect(indexedFresh.gistStale).toBe(false)

    const edited = block(gistBodyHash(body)) + body + 'an edit'
    const indexedEdited = buildIndexedNote(parseNote({ path: 'notes/n.md', source: edited }), {
      fileHash: 'h2',
      mtime: 1,
      source: edited,
    })
    expect(indexedEdited.gistStale).toBe(true)
  })

  it('frontmatter-only changes never flag the gist stale (the hash covers the body alone)', () => {
    const body = '# N\n\npublished body\n'
    const hash = gistBodyHash(body)
    const source = `---\npinned: true\nprivate: true\ngist:\n  id: g1\n  url: u\n  file: N.md\n  hash: ${hash}\n---\n${body}`
    const indexed = buildIndexedNote(parseNote({ path: 'notes/n.md', source }), {
      fileHash: 'h',
      mtime: 0,
      source,
    })
    expect(indexed.gistStale).toBe(false)
  })

  it('flags notes carrying sync conflict markers', () => {
    const source =
      '# Shared\n\n<<<<<<< this device\nmine\n=======\ntheirs\n>>>>>>> other device\n'
    const indexed = buildIndexedNote(parseNote({ path: 'notes/shared.md', source }), {
      fileHash: 'h',
      mtime: 0,
      source,
    })
    expect(indexed.hasConflict).toBe(true)
  })

  it('produces a payload that satisfies the cross-language contract schema', () => {
    // Guards the TS half of the TS↔Rust `IndexedNote` contract: if a field is
    // dropped or mistyped here, the schema parse fails before it can desync from
    // the serde struct in db.rs.
    const source = '---\naliases: [Alt]\n---\n# Title\n\n[[Link]] #tag [x](http://x)'
    const indexed = buildIndexedNote(parseNote({ path: 'notes/n.md', source }), {
      fileHash: 'h',
      mtime: 1,
      source,
    })
    expect(() => indexedNoteSchema.parse(indexed)).not.toThrow()
  })
})
