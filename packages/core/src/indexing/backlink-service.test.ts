import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { describe, expect, it, vi } from 'vitest'
import type { NoteFileService } from '../graph/note-file-service.ts'
import {
  createNodeTestDatabaseService,
  seedNotes,
  type TestDatabaseService,
  type TestNote,
} from '../testing/database.ts'
import { createTestNoteFileService } from '../testing/graph.ts'
import { createBacklinkService, type BacklinkService } from './backlink-service.ts'

function seeded(notes: readonly TestNote[]): TestDatabaseService {
  const database = createNodeTestDatabaseService()
  seedNotes(database, notes)
  return database
}

describe('getBacklinksWithContext', () => {
  function setup(notes: readonly TestNote[]): {
    database: TestDatabaseService
    backlinks: BacklinkService
    reads: string[]
  } {
    const database = seeded(notes)
    const files = createTestNoteFileService({
      files: Object.fromEntries(notes.map((note) => [note.path, note.markdown])),
    })
    const reads: string[] = []
    const readFile = files.read.bind(files)
    vi.spyOn(files, 'read').mockImplementation(async (path, generation) => {
      reads.push(path)
      return await readFile(path, generation)
    })
    const noteFile: NoteFileService = files
    return {
      database,
      backlinks: createBacklinkService({
        database,
        noteFile,
        graphSession: createTestGraphSessionService({ graph: { generation: 1 } }),
      }),
      reads,
    }
  }

  it('pages complete sources in deterministic recency order and reads only included sources', async () => {
    const { backlinks, reads } = setup([
      { path: 'notes/target.md', markdown: '# target\n' },
      { path: 'daily/2026-07-01.md', markdown: 'daily [[target]]\n', mtime: 1 },
      { path: 'notes/older.md', markdown: 'older [[target]]\n', mtime: 1_000 },
      { path: 'notes/not-loaded.md', markdown: 'extra [[target]]\n', mtime: 500 },
      { path: 'notes/unrelated.md', markdown: 'no links\n', mtime: 5_000 },
    ])

    const page = await backlinks.getBacklinksWithContext('notes/target.md', {
      cursor: null,
      limit: 2,
    })

    expect(page.contexts).toEqual([
      {
        sourcePath: 'daily/2026-07-01.md',
        sourceTitle: '2026-07-01',
        snippet: 'daily [[target]]',
        posFrom: 6,
        tasks: [],
      },
      {
        sourcePath: 'notes/older.md',
        sourceTitle: 'older',
        snippet: 'older [[target]]',
        posFrom: 6,
        tasks: [],
      },
    ])
    expect(page.nextCursor).toEqual({ recencyMs: 1_000, sourcePath: 'notes/older.md' })
    expect(page.indexedLinkCount).toBe(3)
    expect(reads.toSorted()).toEqual(['daily/2026-07-01.md', 'notes/older.md'])
  })

  it('uses the recency/path keyset after a cursor and returns null at the end', async () => {
    const { backlinks } = setup([
      { path: 'notes/target.md', markdown: '# target\n' },
      { path: 'notes/newer.md', markdown: 'newer [[target]]\n', mtime: 2_000 },
      { path: 'notes/previous.md', markdown: 'previous [[target]]\n', mtime: 1_000 },
      { path: 'notes/sibling.md', markdown: 'sibling [[target]]\n', mtime: 1_000 },
      { path: 'notes/next.md', markdown: 'next [[target]]\n', mtime: 900 },
    ])

    const first = await backlinks.getBacklinksWithContext('notes/target.md', {
      cursor: { recencyMs: 1_000, sourcePath: 'notes/previous.md' },
      limit: 1,
    })
    expect(first.contexts.map((context) => context.sourcePath)).toEqual(['notes/sibling.md'])
    expect(first.nextCursor).toEqual({ recencyMs: 1_000, sourcePath: 'notes/sibling.md' })

    const second = await backlinks.getBacklinksWithContext('notes/target.md', {
      cursor: first.nextCursor,
      limit: 1,
    })
    expect(second.contexts.map((context) => context.sourcePath)).toEqual(['notes/next.md'])
    expect(second.nextCursor).toBeNull()
    expect(second.indexedLinkCount).toBe(4)
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid page limit (%s) before querying',
    async (limit) => {
      const { database, backlinks } = setup([])
      await expect(
        backlinks.getBacklinksWithContext('notes/target.md', { cursor: null, limit }),
      ).rejects.toThrow('positive safe integer')
      expect(database.getQueries()).toEqual([])
    },
  )

  it('extracts the block context around the link — a list item keeps its children', async () => {
    const { backlinks } = setup([
      { path: 'notes/target.md', markdown: '# target\n' },
      {
        path: 'notes/source.md',
        markdown: '- kickoff with [[target]]\n  - prep the agenda\n- unrelated\n',
      },
    ])

    const page = await backlinks.getBacklinksWithContext('notes/target.md', {
      cursor: null,
      limit: 10,
    })

    expect(page.contexts.map((row) => row.snippet)).toEqual([
      '- kickoff with [[target]]\n  - prep the agenda',
    ])
  })

  it('co-groups sibling branches through the target aliases, not just the clicked spelling', async () => {
    const { backlinks } = setup([
      { path: 'notes/target.md', markdown: '---\naliases: [projx]\n---\n# Project X\n' },
      {
        path: 'notes/source.md',
        markdown: '- parent line\n  - one [[Project X]]\n  - two [[projx]]\n',
      },
    ])

    const page = await backlinks.getBacklinksWithContext('notes/target.md', {
      cursor: null,
      limit: 10,
    })

    expect(page.contexts.map((row) => row.snippet)).toEqual([
      '- parent line\n  - one [[Project X]]\n  - two [[projx]]',
    ])
    expect(page.indexedLinkCount).toBe(2)
  })

  it('deduplicates a complete source while reporting the raw indexed link count', async () => {
    const { backlinks } = setup([
      { path: 'notes/target.md', markdown: '# target\n' },
      {
        path: 'notes/source.md',
        markdown: 'both [[target]] links on one [[target]] line\n\nanother [[target]] mention\n',
      },
    ])

    const page = await backlinks.getBacklinksWithContext('notes/target.md', {
      cursor: null,
      limit: 1,
    })

    expect(page.contexts.map((row) => row.snippet)).toEqual([
      'both [[target]] links on one [[target]] line',
      'another [[target]] mention',
    ])
    expect(page.indexedLinkCount).toBe(3)
  })

  it('keeps a source that vanished from disk with an empty snippet', async () => {
    const database = seeded([
      { path: 'notes/target.md', markdown: '# target\n' },
      { path: 'notes/gone.md', markdown: 'gone [[target]]\n' },
    ])
    const backlinks = createBacklinkService({
      database,
      noteFile: createTestNoteFileService(),
      graphSession: createTestGraphSessionService({ graph: { generation: 1 } }),
    })

    const page = await backlinks.getBacklinksWithContext('notes/target.md', {
      cursor: null,
      limit: 10,
    })

    expect(page.contexts).toEqual([
      { sourcePath: 'notes/gone.md', sourceTitle: 'gone', snippet: '', posFrom: 5, tasks: [] },
    ])
  })
})

describe('getBacklinks', () => {
  it('lists the raw resolved links into a note, by source path', async () => {
    const database = seeded([
      { path: 'notes/target.md', markdown: '---\naliases: [T]\n---\n# Target\n' },
      { path: 'notes/b.md', markdown: '[[Target]]\n' },
      { path: 'notes/a.md', markdown: 'x [[T|the target]]\n' },
      { path: 'notes/c.md', markdown: '[[Other]]\n' },
    ])
    const backlinks = createBacklinkService({
      database,
      noteFile: createTestNoteFileService(),
      graphSession: createTestGraphSessionService({ graph: { generation: 1 } }),
    })

    await expect(backlinks.getBacklinks('notes/target.md')).resolves.toEqual([
      { sourcePath: 'notes/a.md', targetRaw: 'T', alias: 'the target', posFrom: 2, posTo: 18 },
      { sourcePath: 'notes/b.md', targetRaw: 'Target', alias: null, posFrom: 0, posTo: 10 },
    ])
  })
})
