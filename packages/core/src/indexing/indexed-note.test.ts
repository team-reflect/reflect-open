import { describe, expect, it } from 'vitest'
import { gistBodyHash, parseNote } from '../markdown'
import { buildIndexedNote, indexedNoteSchema, PROJECTION_VERSION } from './indexed-note'

describe('buildIndexedNote', () => {
  it('carries the projection version that backfills task breadcrumbs', () => {
    expect(PROJECTION_VERSION).toBe(15)
  })

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

  it('derives v1 subject aliases from a `//` title, after frontmatter aliases', () => {
    const source = '---\naliases: [Mummy]\n---\n# Charlotte MacCaw // Mum\n\nHi.'
    const indexed = buildIndexedNote(parseNote({ path: 'notes/charlotte.md', source }), {
      fileHash: 'h',
      mtime: 0,
      source,
    })
    expect(indexed.title).toBe('Charlotte MacCaw // Mum')
    expect(indexed.titleKey).toBe('charlotte maccaw // mum')
    expect(indexed.aliases).toEqual([
      { alias: 'Mummy', aliasKey: 'mummy' },
      { alias: 'Charlotte MacCaw', aliasKey: 'charlotte maccaw' },
      { alias: 'Mum', aliasKey: 'mum' },
    ])
  })

  it('skips derived subject aliases a frontmatter alias already claims', () => {
    const source = '---\naliases: [MUM]\n---\n# Charlotte MacCaw // Mum\n\nHi.'
    const indexed = buildIndexedNote(parseNote({ path: 'notes/charlotte.md', source }), {
      fileHash: 'h',
      mtime: 0,
      source,
    })
    expect(indexed.aliases).toEqual([
      { alias: 'MUM', aliasKey: 'mum' },
      { alias: 'Charlotte MacCaw', aliasKey: 'charlotte maccaw' },
    ])
  })

  it('projects Email field bullets with folded keys, ignoring prose mentions', () => {
    const source =
      '# Ada Lovelace\n\n- Type: #person\n- Email: Ada@Example.com\n\nIntro via bob@corp.example.'
    const indexed = buildIndexedNote(parseNote({ path: 'notes/ada.md', source }), {
      fileHash: 'h',
      mtime: 0,
      source,
    })
    expect(indexed.emails).toEqual([{ email: 'Ada@Example.com', emailKey: 'ada@example.com' }])
  })

  it('reads email fields from the body with frontmatter split off', () => {
    const source = '---\nid: 01H\n---\n# Ada\n\n- Email: ada@example.com'
    const indexed = buildIndexedNote(parseNote({ path: 'notes/ada.md', source }), {
      fileHash: 'h',
      mtime: 0,
      source,
    })
    expect(indexed.emails).toEqual([{ email: 'ada@example.com', emailKey: 'ada@example.com' }])
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

  it('folds asset description text from meta, defaulting to empty', () => {
    const source = '# Has image\n\n![p](assets/p.png)'
    const withText = buildIndexedNote(parseNote({ path: 'notes/n.md', source }), {
      fileHash: 'h',
      mtime: 0,
      source,
      assetText: 'A flow diagram of the pipeline.',
    })
    expect(withText.assetText).toBe('A flow diagram of the pipeline.')
    // Asset text enriches the FTS body only — never the All-Notes preview.
    expect(withText.preview).not.toContain('flow diagram')

    const withoutText = buildIndexedNote(parseNote({ path: 'notes/n.md', source }), {
      fileHash: 'h',
      mtime: 0,
      source,
    })
    expect(withoutText.assetText).toBe('')
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

  it('derives the note kind from the path', () => {
    const kindOf = (path: string): string =>
      buildIndexedNote(parseNote({ path, source: 'body' }), {
        fileHash: 'h',
        mtime: 0,
        source: 'body',
      }).kind
    expect(kindOf('daily/2026-06-09.md')).toBe('daily')
    expect(kindOf('notes/n.md')).toBe('note')
    expect(kindOf('templates/journal.md')).toBe('template')
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

  it('maps only round task checkboxes into task rows', () => {
    const source =
      '# Todo\n\n+ [ ] buy milk\n- [ ] checklist\n* [x] checklist\n1. [ ] ordered\n+ [x] call mum\n'
    const indexed = buildIndexedNote(parseNote({ path: 'notes/n.md', source }), {
      fileHash: 'h',
      mtime: 0,
      source,
    })
    expect(indexed.tasks).toEqual([
      {
        markerOffset: source.indexOf('[ ]'),
        text: 'buy milk',
        breadcrumbs: [],
        raw: '[ ] buy milk',
        checked: false,
        dueDate: null,
      },
      {
        markerOffset: source.indexOf('[x] call'),
        text: 'call mum',
        breadcrumbs: [],
        raw: '[x] call mum',
        checked: true,
        dueDate: null,
      },
    ])
  })

  it('maps an explicit task due date from a [[YYYY-MM-DD]] link', () => {
    const source = '# Todo\n\n+ [ ] pay bill [[2026-06-20]]\n'
    const indexed = buildIndexedNote(parseNote({ path: 'notes/n.md', source }), {
      fileHash: 'h',
      mtime: 0,
      source,
    })
    expect(indexed.tasks[0]?.dueDate).toBe('2026-06-20')
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
