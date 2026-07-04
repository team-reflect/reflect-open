import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import { getBacklinks, resolveWikiTarget, searchNotes } from './queries'
import { hashContent } from './hash'
import { PROJECTION_VERSION } from './indexed-note'
import { indexNote, rebuildIndex, reconcileIndex, syncIndex, PROJECTION_VERSION_KEY } from './indexer'
import { applyIndexChanges } from './live'

// Install a fake bridge so both core's `call` and the Kysely runner resolve
// against an in-test fake — exercises the pipeline + the Kysely→db_query bridge.
const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()
setBridge({ invoke: mockInvoke, listen: async () => () => {} })

/** What the stored `index_meta` projection stamp reads back as, per test. */
let metaRows: Array<{ value: string }>

beforeEach(() => {
  metaRows = []
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command, args) => {
    const sql = String(args['sql'] ?? '')
    switch (command) {
      case 'note_read':
        return '# Hello\n\n[[World]]'
      case 'list_files':
        return [{ path: 'notes/a.md', size: 1, modifiedMs: 5 }]
      case 'index_apply':
      case 'index_apply_batch':
      case 'index_clear':
      case 'index_remove':
      case 'index_meta_set':
        return null
      case 'db_query':
        if (sql.includes('index_meta')) return metaRows
        if (sql.includes('search_fts')) return [{ path: 'notes/a.md', title: 'A' }]
        if (sql.includes('backlinks')) {
          return [{ source_path: 'notes/b.md', target_raw: 'A', alias: null, pos_from: 0, pos_to: 3 }]
        }
        if (sql.includes('"notes"') && sql.includes('title_key')) {
          return [{ path: 'notes/a.md' }]
        }
        return []
      default:
        return null
    }
  })
})

describe('indexNote', () => {
  it('reads, parses, and applies a built index payload with its generation', async () => {
    await indexNote('notes/a.md', { generation: 7, mtime: 5 })
    const apply = mockInvoke.mock.calls.find(([cmd]) => cmd === 'index_apply')
    expect(apply).toBeDefined()
    const args = apply![1] as { note: Record<string, unknown>; generation: number }
    expect(args.generation).toBe(7)
    expect(args.note['path']).toBe('notes/a.md')
    expect(args.note['title']).toBe('Hello')
    expect(args.note['mtime']).toBe(5)
    expect(args.note['fileHash']).toMatch(/^[0-9a-f]{64}$/)
    expect((args.note['links'] as { targetKey: string }[]).map((link) => link.targetKey)).toContain('world')
  })
})

describe('rebuildIndex', () => {
  it('clears, lists, applies every file in one batch, then stamps the projection version', async () => {
    await rebuildIndex({ generation: 1 })
    const commands = mockInvoke.mock.calls.map(([cmd]) => cmd)
    expect(commands[0]).toBe('index_clear')
    expect(commands).toContain('list_files')
    const batch = mockInvoke.mock.calls.find(([cmd]) => cmd === 'index_apply_batch')
    expect(batch).toBeDefined()
    const notes = (batch![1] as { notes: { path: string }[] }).notes
    expect(notes.map((note) => note.path)).toEqual(['notes/a.md'])
    expect(commands).not.toContain('index_apply') // batched, not one-by-one
    // The stamp lets the next open reconcile instead of rebuilding again.
    const stamp = mockInvoke.mock.calls.find(([cmd]) => cmd === 'index_meta_set')
    expect(stamp![1]).toMatchObject({
      key: PROJECTION_VERSION_KEY,
      value: String(PROJECTION_VERSION),
      generation: 1,
    })
  })

  it('splits a failed rebuild batch and still applies the notes individually', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === 'list_files') {
        return [
          { path: 'notes/a.md', size: 1, modifiedMs: 1 },
          { path: 'notes/b.md', size: 1, modifiedMs: 2 },
          { path: 'notes/c.md', size: 1, modifiedMs: 3 },
        ]
      }
      if (command === 'note_read') {
        return `# ${String(args['path'])}\n`
      }
      if (command === 'index_apply_batch') {
        const notes = args['notes'] as Array<{ path: string }>
        if (notes.length > 1) {
          throw new Error('batch payload refused')
        }
        return null
      }
      return null
    })

    await rebuildIndex({ generation: 1 })

    const applied = mockInvoke.mock.calls
      .filter(([command]) => command === 'index_apply_batch')
      .map(([, args]) => (args as { notes: Array<{ path: string }> }).notes.map((note) => note.path))
    expect(applied).toEqual([
      ['notes/a.md', 'notes/b.md', 'notes/c.md'],
      ['notes/a.md', 'notes/b.md'],
      ['notes/a.md'],
      ['notes/b.md'],
      ['notes/c.md'],
    ])
    expect(mockInvoke.mock.calls.some(([command]) => command === 'index_meta_set')).toBe(true)
  })

  it('reports and skips a note whose projection cannot be written alone', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === 'list_files') {
        return [{ path: 'notes/bad.md', size: 1, modifiedMs: 1 }]
      }
      if (command === 'note_read') {
        return `# ${String(args['path'])}\n`
      }
      if (command === 'index_apply_batch') {
        throw { kind: 'parse', message: 'unexpected end of hex escape' }
      }
      return null
    })
    const skipped: Array<{ path: string; message: string }> = []

    await rebuildIndex({ generation: 1, onSkippedNote: (note) => skipped.push(note) })

    expect(skipped).toEqual([
      { path: 'notes/bad.md', message: 'unexpected end of hex escape' },
    ])
    expect(mockInvoke.mock.calls.some(([command]) => command === 'index_meta_set')).toBe(true)
  })

  it('throws a single-note write failure when no skip callback is registered', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === 'list_files') {
        return [{ path: 'notes/bad.md', size: 1, modifiedMs: 1 }]
      }
      if (command === 'note_read') {
        return `# ${String(args['path'])}\n`
      }
      if (command === 'index_apply_batch') {
        throw new Error('single note refused')
      }
      return null
    })

    await expect(rebuildIndex({ generation: 1 })).rejects.toThrow('single note refused')
    expect(mockInvoke.mock.calls.some(([command]) => command === 'index_meta_set')).toBe(false)
  })
})

describe('syncIndex', () => {
  it('reconciles (no wipe) when the stored projection version is current', async () => {
    metaRows = [{ value: String(PROJECTION_VERSION) }]
    await syncIndex({ generation: 2 })
    const commands = mockInvoke.mock.calls.map(([cmd]) => cmd)
    expect(commands).toContain('list_files')
    expect(commands).not.toContain('index_clear')
    expect(commands).not.toContain('index_meta_set')
  })

  it('rebuilds and stamps when the index predates the current projection', async () => {
    metaRows = [] // never stamped (or written by an older app)
    await syncIndex({ generation: 3 })
    const commands = mockInvoke.mock.calls.map(([cmd]) => cmd)
    expect(commands).toContain('index_clear')
    const stamp = mockInvoke.mock.calls.find(([cmd]) => cmd === 'index_meta_set')
    expect(stamp![1]).toMatchObject({
      key: PROJECTION_VERSION_KEY,
      value: String(PROJECTION_VERSION),
      generation: 3,
    })
  })
})

describe('applyIndexChanges (watcher dispatch)', () => {
  it('re-indexes upserts and removes deletes at the given generation', async () => {
    await applyIndexChanges(
      [
        { path: 'notes/a.md', kind: 'upsert', modifiedMs: 4242 },
        { path: 'notes/gone.md', kind: 'remove' },
      ],
      9,
    )
    const apply = mockInvoke.mock.calls.find(([cmd]) => cmd === 'index_apply')
    const remove = mockInvoke.mock.calls.find(([cmd]) => cmd === 'index_remove')
    expect((apply![1] as { note: { path: string }; generation: number }).generation).toBe(9)
    expect((apply![1] as { note: { path: string } }).note.path).toBe('notes/a.md')
    expect((apply![1] as { note: { mtime: number } }).note.mtime).toBe(4242)
    expect(remove![1]).toMatchObject({ path: 'notes/gone.md', generation: 9 })
  })

  it('stamps "now" — never epoch zero — when an upsert carries no modifiedMs', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_750_000_000_000)
    try {
      await applyIndexChanges([{ path: 'notes/a.md', kind: 'upsert' }], 9)
      const apply = mockInvoke.mock.calls.find(([cmd]) => cmd === 'index_apply')
      expect((apply![1] as { note: { mtime: number } }).note.mtime).toBe(1_750_000_000_000)
    } finally {
      nowSpy.mockRestore()
    }
  })
})

describe('Kysely → db_query bridge', () => {
  it('searchNotes compiles an FTS MATCH query', async () => {
    const hits = await searchNotes('hello')
    const query = mockInvoke.mock.calls.find(([cmd]) => cmd === 'db_query')
    const sql = (query![1] as { sql: string }).sql
    expect(sql).toContain('search_fts')
    expect(sql.toLowerCase()).toContain('match')
    expect(hits).toEqual([{ path: 'notes/a.md', title: 'A' }])
  })

  it('searchNotes returns [] for a blank query without touching the DB', async () => {
    const before = mockInvoke.mock.calls.length
    expect(await searchNotes('   ')).toEqual([])
    expect(mockInvoke.mock.calls.length).toBe(before)
  })

  it('searchNotes ranks by exact title, bm25, pinned and recency', async () => {
    await searchNotes('hello')
    const query = mockInvoke.mock.calls.find(([cmd]) => cmd === 'db_query')
    const sql = String((query![1] as { sql: string }).sql).toLowerCase()
    // Same ranked join/order contract as the palette's `searchWithFilters`.
    expect(sql).toContain('inner join "notes"')
    expect(sql).toContain('case when "notes"."title_key" =')
    expect(sql).toContain('bm25(search_fts, 0, 10.0, 1.0)')
    expect(sql).toContain('"notes"."is_pinned" desc')
    expect(sql).toContain('"notes"."mtime" desc')
    expect(sql).toContain('"notes"."path" asc')
  })

  it('getBacklinks maps snake_case rows back to camelCase', async () => {
    const backlinks = await getBacklinks('notes/a.md')
    expect(backlinks).toEqual([
      { sourcePath: 'notes/b.md', targetRaw: 'A', alias: null, posFrom: 0, posTo: 3 },
    ])
  })

  it('resolveWikiTarget resolves a title match to a note ref', async () => {
    expect(await resolveWikiTarget('World')).toEqual({ kind: 'resolved', ref: 'notes/a.md' })
  })
})

describe('reconcileIndex move healing (Plan 17)', () => {
  const OLD = 'notes/01arz3ndektsv4rrffq69g5fav.md'
  const NEW = 'notes/meeting-notes.md'
  const CONTENT = '---\nid: 01abcdefghjkmnpqrstvwxyz00\n---\n# Meeting Notes\n'

  /** A graph where OLD's row remains but the file now lives at NEW. */
  function renameFake(options: { storedHash: string; content?: string }) {
    const calls: Array<[string, Record<string, unknown>]> = []
    mockInvoke.mockImplementation(async (command, args) => {
      calls.push([command, args])
      const sql = String(args['sql'] ?? '')
      if (command === 'list_files') {
        return [{ path: NEW, size: 1, modifiedMs: 9 }]
      }
      if (command === 'note_read') {
        if (args['path'] === NEW) {
          return options.content ?? CONTENT
        }
        throw { kind: 'notFound', message: 'missing' }
      }
      if (command === 'db_query') {
        if (sql.includes('file_hash')) {
          return [{ path: OLD, file_hash: options.storedHash }]
        }
        if (((args['params'] as unknown[]) ?? []).includes(OLD)) {
          return [{ path: OLD, id: '01abcdefghjkmnpqrstvwxyz00' }]
        }
        return []
      }
      return null
    })
    return calls
  }

  it('moves the rows and skips the re-index when content is unchanged', async () => {
    const calls = renameFake({ storedHash: await hashContent(CONTENT) })

    await reconcileIndex({ generation: 4 })

    const commands = calls.map(([command]) => command)
    expect(commands).toContain('index_move')
    const move = calls.find(([command]) => command === 'index_move')
    expect(move?.[1]).toEqual({ from: OLD, to: NEW, generation: 4 })
    // The moved row carried its hash: identical content means no re-apply —
    // and crucially no remove, so embeddings survived.
    expect(commands).not.toContain('index_apply')
    expect(commands).not.toContain('index_remove')
  })

  it('announces the heal via onMoved so the app can follow', async () => {
    renameFake({ storedHash: await hashContent(CONTENT) })
    const moves: Array<[string, string]> = []

    await reconcileIndex({ generation: 4, onMoved: (from, to) => moves.push([from, to]) })

    expect(moves).toEqual([[OLD, NEW]])
  })

  it('re-indexes at the new path when content changed in transit', async () => {
    const calls = renameFake({ storedHash: 'stale-hash-from-before-the-edit' })

    await reconcileIndex({ generation: 4 })

    const commands = calls.map(([command]) => command)
    expect(commands).toContain('index_move')
    expect(commands).not.toContain('index_remove')
    const apply = calls.find(([command]) => command === 'index_apply')
    expect(apply).toBeDefined()
    expect((apply![1]['note'] as { path: string }).path).toBe(NEW)
  })

  it('a legacy file without an id still reconciles as delete+create', async () => {
    const calls = renameFake({
      storedHash: 'whatever',
      content: '# Meeting Notes\n',
    })

    await reconcileIndex({ generation: 4 })

    const commands = calls.map(([command]) => command)
    expect(commands).not.toContain('index_move')
    expect(commands).toContain('index_apply')
    expect(commands).toContain('index_remove')
  })
})

describe('iCloud eviction placeholders (Plan 21)', () => {
  /** A graph whose listing carries `files`; every note_read throws notFound. */
  function evictedFake(files: Array<Record<string, unknown>>, storedPaths: string[]) {
    mockInvoke.mockImplementation(async (command, args) => {
      const sql = String(args['sql'] ?? '')
      if (command === 'list_files') {
        return files
      }
      if (command === 'note_read') {
        throw { kind: 'notFound', message: 'evicted' }
      }
      if (command === 'db_query') {
        if (sql.includes('file_hash')) {
          return storedPaths.map((path) => ({ path, file_hash: 'stored-hash' }))
        }
        return []
      }
      return null
    })
  }

  it('reconcile keeps the stored row for an evicted note instead of deleting it', async () => {
    evictedFake([{ path: 'notes/a.md', size: 1, modifiedMs: 5, placeholder: true }], ['notes/a.md'])

    await reconcileIndex({ generation: 5 })

    const commands = mockInvoke.mock.calls.map(([cmd]) => cmd)
    // Present-but-offloaded: never read (unreadable), never removed (not deleted).
    expect(commands).not.toContain('note_read')
    expect(commands).not.toContain('index_remove')
    expect(commands).not.toContain('index_apply')
  })

  it('placeholders are not move-healing arrivals, and true orphans still drop', async () => {
    evictedFake(
      [{ path: 'notes/arrived.md', size: 1, modifiedMs: 5, placeholder: true }],
      ['notes/gone-for-real.md'],
    )

    await reconcileIndex({ generation: 5 })

    const commands = mockInvoke.mock.calls.map(([cmd]) => cmd)
    // Nothing pairs against unreadable content…
    expect(commands).not.toContain('note_read')
    expect(commands).not.toContain('index_move')
    // …and a row whose file is gone *without* a placeholder is still removed.
    const remove = mockInvoke.mock.calls.find(([cmd]) => cmd === 'index_remove')
    expect(remove?.[1]).toMatchObject({ path: 'notes/gone-for-real.md', generation: 5 })
  })

  it('rebuild indexes readable files and skips evicted ones', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === 'list_files') {
        return [
          { path: 'notes/real.md', size: 1, modifiedMs: 5 },
          { path: 'notes/evicted.md', size: 1, modifiedMs: 5, placeholder: true },
        ]
      }
      if (command === 'note_read') {
        if (args['path'] === 'notes/real.md') {
          return '# Real\n'
        }
        throw { kind: 'notFound', message: 'evicted' }
      }
      return null
    })

    await rebuildIndex({ generation: 6 })

    const batch = mockInvoke.mock.calls.find(([cmd]) => cmd === 'index_apply_batch')
    const notes = (batch![1] as { notes: { path: string }[] }).notes
    expect(notes.map((note) => note.path)).toEqual(['notes/real.md'])
  })
})
