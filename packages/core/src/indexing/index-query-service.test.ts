import { describe, expect, it } from 'vitest'
import {
  createTestDatabaseService,
  seedNotes,
  type TestDatabaseService,
  type TestNote,
} from '../testing/database.ts'
import { createIndexQueryService, type IndexQueryService } from './index-query-service.ts'

function seeded(notes: readonly TestNote[]): TestDatabaseService {
  const database = createTestDatabaseService()
  seedNotes(database, notes)
  return database
}

describe('getPinnedNotes', () => {
  it('lists pinned rows: explicit orders first, then folded title, never templates', async () => {
    const database = seeded([
      { path: 'notes/b.md', markdown: '---\npinned: true\n---\n# Beta\n' },
      { path: 'notes/c.md', markdown: '---\npinned: true\n---\n# aardvark\n' },
      { path: 'notes/a.md', markdown: '---\npinned: 0\n---\n# Alpha\n' },
      { path: 'notes/d.md', markdown: '---\npinned: 3\n---\n# Delta\n' },
      { path: 'notes/unpinned.md', markdown: '# Unpinned\n' },
      { path: 'templates/pinned.md', markdown: '---\npinned: true\n---\n# Template\n' },
    ])

    await expect(createIndexQueryService({ database }).getPinnedNotes()).resolves.toEqual([
      { path: 'notes/a.md', title: 'Alpha', dailyDate: null, pinnedOrder: 0 },
      { path: 'notes/d.md', title: 'Delta', dailyDate: null, pinnedOrder: 3 },
      { path: 'notes/c.md', title: 'aardvark', dailyDate: null, pinnedOrder: null },
      { path: 'notes/b.md', title: 'Beta', dailyDate: null, pinnedOrder: null },
    ])
  })
})

describe('getNote', () => {
  it('maps the row flags to booleans, or resolves undefined when absent', async () => {
    const database = seeded([
      { path: 'notes/secret.md', markdown: '---\nprivate: true\n---\n# Secret\n' },
    ])
    const indexQuery = createIndexQueryService({ database })

    await expect(indexQuery.getNote('notes/secret.md')).resolves.toEqual({
      path: 'notes/secret.md',
      title: 'Secret',
      dailyDate: null,
      isPrivate: true,
      gistUrl: null,
      gistStale: false,
    })
    await expect(indexQuery.getNote('notes/missing.md')).resolves.toBeUndefined()
  })
})

describe('getDuplicateNoteIds', () => {
  it('returns empty without a second query when no id is duplicated', async () => {
    const database = seeded([
      { path: 'notes/a.md', markdown: '---\nid: one\n---\n# A\n' },
      { path: 'notes/b.md', markdown: '---\nid: two\n---\n# B\n' },
      { path: 'notes/c.md', markdown: '# C\n' },
    ])

    await expect(createIndexQueryService({ database }).getDuplicateNoteIds()).resolves.toEqual([])
    expect(database.getQueries()).toHaveLength(1)
  })

  it('groups every path claiming a duplicated id, ordered', async () => {
    const database = seeded([
      { path: 'notes/b.md', markdown: '---\nid: dup-1\n---\n# B\n' },
      { path: 'notes/a.md', markdown: '---\nid: dup-1\n---\n# A\n' },
      { path: 'notes/c.md', markdown: '---\nid: unique\n---\n# C\n' },
    ])

    await expect(createIndexQueryService({ database }).getDuplicateNoteIds()).resolves.toEqual([
      { id: 'dup-1', paths: ['notes/a.md', 'notes/b.md'] },
    ])
  })
})

describe('getNoteIdsByPath', () => {
  it('asks nothing for no paths', async () => {
    const database = createTestDatabaseService()
    await expect(createIndexQueryService({ database }).getNoteIdsByPath([])).resolves.toEqual(
      new Map(),
    )
    expect(database.getQueries()).toEqual([])
  })

  it('chunks the IN clause under SQLite variable limits and merges the results', async () => {
    // A mass external move can orphan thousands of paths in one reconcile —
    // a single statement would blow the bound-variable budget.
    const database = seeded([
      { path: 'notes/0.md', markdown: '---\nid: id-0\n---\n# Zero\n' },
      { path: 'notes/500.md', markdown: '---\nid: id-500\n---\n# Five hundred\n' },
      { path: 'notes/1000.md', markdown: '# No id\n' },
    ])
    const paths = Array.from({ length: 1200 }, (_, index) => `notes/${index}.md`)

    const ids = await createIndexQueryService({ database }).getNoteIdsByPath(paths)

    expect(database.getQueries().map((query) => query.params.length)).toEqual([500, 500, 200])
    expect(ids).toEqual(
      new Map([
        ['notes/0.md', 'id-0'],
        ['notes/500.md', 'id-500'],
        ['notes/1000.md', null],
      ]),
    )
  })
})

describe('getIndexedFileFactsByPath', () => {
  it('reads the stored hash and mtime of the indexed paths only', async () => {
    const database = seeded([{ path: 'notes/a.md', markdown: '# A\n', mtime: 42 }])

    await expect(
      createIndexQueryService({ database }).getIndexedFileFactsByPath(['notes/a.md', 'notes/b.md']),
    ).resolves.toEqual(new Map([['notes/a.md', { fileHash: 'hash-notes/a.md', mtime: 42 }]]))
  })
})

function setup(): IndexQueryService {
  const database = createTestDatabaseService()
  seedNotes(database, [
    {
      path: 'notes/project-x.md',
      markdown: '---\nid: 01hzy3v9k2m4n6p8q0r2s4t6vw\n---\n# Project X\n',
    },
    { path: 'notes/project-x-2.md', markdown: '# Project X\n' },
    { path: 'notes/foo.md', markdown: '# Something Else\n' },
    { path: 'notes/aliased.md', markdown: '---\naliases: [PX]\n---\n# Aliased\n' },
    { path: 'notes/zz-id-title.md', markdown: '# 01hzy3v9k2m4n6p8q0r2s4t6vw\n' },
  ])
  return createIndexQueryService({ database })
}

describe('resolveNoteTarget', () => {
  it('resolves a frontmatter id first, ahead of a title spelled the same', async () => {
    await expect(setup().resolveNoteTarget('01hzy3v9k2m4n6p8q0r2s4t6vw')).resolves.toBe(
      'notes/project-x.md',
    )
  })

  it('resolves a calendar date to the daily path even when the file does not exist', async () => {
    await expect(setup().resolveNoteTarget('2026-07-01')).resolves.toBe('daily/2026-07-01.md')
  })

  it('does not treat an impossible date as a daily note', async () => {
    await expect(setup().resolveNoteTarget('2026-02-31')).resolves.toBeNull()
  })

  it('resolves an explicit graph-relative path when the index knows it', async () => {
    const service = setup()
    await expect(service.resolveNoteTarget('notes/foo.md')).resolves.toBe('notes/foo.md')
    await expect(service.resolveNoteTarget('notes/missing.md')).resolves.toBeNull()
  })

  it('falls back to a case-folded title match, first path alphabetically', async () => {
    await expect(setup().resolveNoteTarget('PROJECT x')).resolves.toBe('notes/project-x-2.md')
  })

  it('falls back to an alias match last, and to null when nothing matches', async () => {
    const service = setup()
    await expect(service.resolveNoteTarget('px')).resolves.toBe('notes/aliased.md')
    await expect(service.resolveNoteTarget('nothing matches this')).resolves.toBeNull()
  })
})

describe('listTemplates', () => {
  it('lists only template-kind rows, A→Z by folded title', async () => {
    const database = createTestDatabaseService()
    seedNotes(database, [
      { path: 'templates/person.md', markdown: '# person\n', mtime: 2 },
      { path: 'templates/journal.md', markdown: '# Journal\n', mtime: 1 },
      { path: 'notes/agenda.md', markdown: '# Agenda\n' },
      { path: 'daily/2026-06-09.md', markdown: 'Standup\n' },
    ])

    await expect(createIndexQueryService({ database }).listTemplates()).resolves.toEqual([
      { path: 'templates/journal.md', title: 'Journal', mtime: 1 },
      { path: 'templates/person.md', title: 'person', mtime: 2 },
    ])
  })
})
