import { describe, expect, it } from 'vitest'
import { createNodeTestDatabaseService, seedNotes, type TestNote } from '../testing/database.ts'
import { createNoteListService, type NoteListService } from './note-list-service.ts'

const NOTES: TestNote[] = [
  {
    path: 'notes/pinned.md',
    markdown: '---\npinned: 1\n---\n# Pinned Plan\nAlways on top.\n',
    mtime: 500,
  },
  { path: 'notes/first-pin.md', markdown: '---\npinned: 0\n---\n# First Pin\n', mtime: 100 },
  { path: 'notes/bare-pin.md', markdown: '---\npinned: true\n---\n# Bare Pin\n', mtime: 3000 },
  {
    path: 'notes/health.md',
    markdown: '# Health Stacked\nShop your health goals. #link #Health\n',
    mtime: 2000,
  },
  { path: 'notes/older.md', markdown: '# Older\n#book\n', mtime: 1000 },
  {
    path: 'notes/secret.md',
    markdown: '---\nprivate: true\n---\n# Secret\n#book\n',
    mtime: 4000,
  },
  { path: 'daily/2026-06-09.md', markdown: 'Read a #Book.\n', mtime: 1500 },
  { path: 'templates/reading.md', markdown: '# Reading\n#book\n', mtime: 5000 },
]

function setup(notes: TestNote[] = NOTES): NoteListService {
  const database = createNodeTestDatabaseService()
  seedNotes(database, notes)
  return createNoteListService({ database })
}

describe('listNotes', () => {
  it('lists non-daily notes pinned-first then newest with stored previews and sorted tags', async () => {
    const entries = await setup().listNotes()

    expect(entries.map((entry) => entry.path)).toEqual([
      'notes/first-pin.md',
      'notes/pinned.md',
      'notes/bare-pin.md',
      'notes/secret.md',
      'notes/health.md',
      'notes/older.md',
    ])
    expect(entries[1]).toEqual({
      path: 'notes/pinned.md',
      title: 'Pinned Plan',
      mtime: 500,
      snippet: 'Always on top.',
      tags: [],
      isPinned: true,
    })
    expect(entries[4]).toMatchObject({
      path: 'notes/health.md',
      tags: ['Health', 'link'],
      isPinned: false,
    })
  })

  it('narrows to one tag case-insensitively and includes tagged daily notes', async () => {
    const entries = await setup().listNotes({ tag: 'BOOK' })

    expect(entries.map((entry) => entry.path)).toEqual([
      'notes/secret.md',
      'daily/2026-06-09.md',
      'notes/older.md',
    ])
    expect(entries[1]?.tags).toEqual(['Book'])
  })

  it('skips the tag fetch entirely when no notes match', async () => {
    const database = createNodeTestDatabaseService()
    seedNotes(database, NOTES)

    await expect(
      createNoteListService({ database }).listNotes({ tag: 'nothing' }),
    ).resolves.toEqual([])
    expect(database.getQueries()).toHaveLength(1)
  })
})

describe('listRecentNotes', () => {
  it('caps public non-daily rows, newest first, with a boolean privacy flag', async () => {
    await expect(setup().listRecentNotes({ limit: 2 })).resolves.toEqual([
      {
        path: 'notes/bare-pin.md',
        title: 'Bare Pin',
        preview: '',
        mtime: 3000,
        isPrivate: false,
      },
      {
        path: 'notes/health.md',
        title: 'Health Stacked',
        preview: 'Shop your health goals. #link #Health',
        mtime: 2000,
        isPrivate: false,
      },
    ])
  })

  it('narrows to one tag via the stored folded tag key', async () => {
    const rows = await setup().listRecentNotes({ limit: 5, tag: 'Book' })

    expect(rows.map((row) => row.path)).toEqual(['notes/older.md'])
  })
})

describe('listNoteTags', () => {
  it('groups tags on the stored key over non-daily notes, alphabetical', async () => {
    await expect(setup().listNoteTags()).resolves.toEqual([
      { tag: 'book', count: 2 },
      { tag: 'Health', count: 1 },
      { tag: 'link', count: 1 },
    ])
  })
})
