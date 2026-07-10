import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import { getBacklinks, resolveWikiTarget } from './queries'
import { searchNotes } from './filtered-search'
import { hashContent } from './hash'
import { PROJECTION_VERSION } from './indexed-note'
import {
  indexNote,
  rebuildIndex,
  reconcileIndex,
  reindexNotesReferencing,
  syncIndex,
  PROJECTION_VERSION_KEY,
} from './indexer'
import { subscribeIndexApplied } from './index-applied'
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
      case 'index_reconcile_scan':
        // Mirrors the default list_files: one arrival needing a read.
        return {
          total: 1,
          candidates: [{ path: 'notes/a.md', modifiedMs: 5, storedMtime: null, storedHash: null }],
          orphans: [],
        }
      case 'index_apply':
      case 'index_apply_batch':
      case 'index_clear':
      case 'index_remove':
      case 'index_meta_set':
        return null
      case 'db_query':
        if (sql.includes('index_meta')) return metaRows
        if (sql.includes('from "assets"')) return [{ note_path: 'notes/a.md' }]
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

describe('reindexNotesReferencing', () => {
  it('re-applies referencing notes and emits the post-apply signal', async () => {
    const emitted: Array<[readonly { path: string; kind: string }[], number]> = []
    const unsubscribe = subscribeIndexApplied((changes, generation) => {
      emitted.push([changes, generation])
    })
    try {
      await reindexNotesReferencing(['assets/pic.png'], 7)
    } finally {
      unsubscribe()
    }

    const apply = mockInvoke.mock.calls.find(([cmd]) => cmd === 'index_apply')
    expect(apply).toBeDefined()
    expect((apply![1] as { generation: number }).generation).toBe(7)

    // These writes bypass the watcher pipeline, so the emit is the only way
    // followers (the embedding sync) hear about the refreshed notes.
    expect(emitted).toEqual([[[{ path: 'notes/a.md', kind: 'upsert' }], 7]])
  })

  it('still emits the applied prefix when a later note’s re-index throws', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      const sql = String(args['sql'] ?? '')
      if (command === 'db_query' && sql.includes('from "assets"')) {
        return [{ note_path: 'notes/a.md' }, { note_path: 'notes/b.md' }]
      }
      if (command === 'note_read') {
        if ((args as { path: string }).path === 'notes/b.md') {
          throw { kind: 'io', message: 'disk error' }
        }
        return '# Hello'
      }
      return null
    })
    const emitted: Array<readonly { path: string }[]> = []
    const unsubscribe = subscribeIndexApplied((changes) => {
      emitted.push(changes)
    })
    try {
      await expect(reindexNotesReferencing(['assets/pic.png'], 7)).rejects.toMatchObject({
        kind: 'io',
      })
    } finally {
      unsubscribe()
    }
    // notes/a.md was applied before the failure — followers must hear it.
    expect(emitted).toEqual([[{ path: 'notes/a.md', kind: 'upsert' }]])
  })

  it('emits nothing when no note references the assets', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      const sql = String(args['sql'] ?? '')
      if (command === 'db_query' && sql.includes('from "assets"')) {
        return []
      }
      return null
    })
    const emitted: unknown[] = []
    const unsubscribe = subscribeIndexApplied((changes) => {
      emitted.push(changes)
    })
    try {
      await reindexNotesReferencing(['assets/pic.png'], 7)
    } finally {
      unsubscribe()
    }
    expect(emitted).toEqual([])
  })
})

describe('rebuildIndex', () => {
  it('clears, lists, applies every file in one batch, then stamps the projection version', async () => {
    const progress: Array<[number, number, number]> = []
    await rebuildIndex({
      generation: 1,
      onFileProgress: (done, total, worked) => progress.push([done, total, worked]),
    })
    // A rebuild reads everything: worked tracks done, so the pill surfaces.
    expect(progress.at(-1)).toEqual([1, 1, 1])
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

  it('stops before the next SQLite write when suspended after the rebuild wipe', async () => {
    const controller = new AbortController()
    mockInvoke.mockImplementation(async (command) => {
      if (command === 'list_files') {
        return [{ path: 'notes/a.md', size: 1, modifiedMs: 1 }]
      }
      if (command === 'note_read') {
        // Models iOS becoming hidden while filesystem work is in flight.
        controller.abort()
        return '# A\n'
      }
      return null
    })

    await rebuildIndex({ generation: 1, signal: controller.signal })

    const commands = mockInvoke.mock.calls.map(([command]) => command)
    expect(commands).toContain('index_clear') // began while foregrounded
    expect(commands).not.toContain('index_apply_batch')
    // No new projection stamp is written; foreground sync converges either by
    // rebuilding an old projection or reconciling missing rows for a current one.
    expect(commands).not.toContain('index_meta_set')
  })
})

describe('syncIndex', () => {
  it('reconciles (no wipe) when the stored projection version is current', async () => {
    metaRows = [{ value: String(PROJECTION_VERSION) }]
    await syncIndex({ generation: 2 })
    const commands = mockInvoke.mock.calls.map(([cmd]) => cmd)
    expect(commands).toContain('index_reconcile_scan')
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
  it('re-indexes upserts (batched) and removes deletes at the given generation', async () => {
    const mutations = await applyIndexChanges(
      [
        { path: 'notes/a.md', kind: 'upsert', modifiedMs: 4242 },
        { path: 'notes/gone.md', kind: 'remove' },
      ],
      9,
    )
    const apply = mockInvoke.mock.calls.find(([cmd]) => cmd === 'index_apply_batch')
    const remove = mockInvoke.mock.calls.find(([cmd]) => cmd === 'index_remove')
    const args = apply![1] as { notes: Array<{ path: string; mtime: number }>; generation: number }
    expect(args.generation).toBe(9)
    expect(args.notes.map((note) => note.path)).toEqual(['notes/a.md'])
    expect(args.notes[0]!.mtime).toBe(4242)
    expect(remove![1]).toMatchObject({ path: 'notes/gone.md', generation: 9 })
    expect(mutations).toBe(2)
  })

  it('stamps "now" — never epoch zero — when an upsert carries no modifiedMs', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_750_000_000_000)
    try {
      await applyIndexChanges([{ path: 'notes/a.md', kind: 'upsert' }], 9)
      const apply = mockInvoke.mock.calls.find(([cmd]) => cmd === 'index_apply_batch')
      const notes = (apply![1] as { notes: Array<{ mtime: number }> }).notes
      expect(notes[0]!.mtime).toBe(1_750_000_000_000)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('skips upserts whose indexed row already matches an old mtime, without reading', async () => {
    // The iCloud watch's initial gather re-reports every downloaded note; a
    // row indexed at the same (settled) mtime must cost neither a read nor a
    // write — and a zero-mutation batch reports 0 so no invalidation fires.
    mockInvoke.mockImplementation(async (command, args) => {
      const sql = String(args['sql'] ?? '')
      if (command === 'db_query' && sql.includes('file_hash')) {
        return [{ path: 'notes/a.md', file_hash: 'stored', mtime: 1_000 }]
      }
      if (command === 'db_query') {
        return []
      }
      if (command === 'note_read') {
        throw new Error('must not read an mtime-matched file')
      }
      return null
    })

    const mutations = await applyIndexChanges(
      [{ path: 'notes/a.md', kind: 'upsert', modifiedMs: 1_000 }],
      9,
    )

    expect(mutations).toBe(0)
    const commands = mockInvoke.mock.calls.map(([cmd]) => cmd)
    expect(commands).not.toContain('note_read')
    expect(commands).not.toContain('index_apply_batch')
    expect(commands).not.toContain('index_touch')
  })

  it('re-stamps the stored mtime when content is unchanged but the mtime moved', async () => {
    const content = '# same content\n'
    mockInvoke.mockImplementation(async (command, args) => {
      const sql = String(args['sql'] ?? '')
      if (command === 'db_query' && sql.includes('file_hash')) {
        return [{ path: 'notes/a.md', file_hash: await hashContent(content), mtime: 1_000 }]
      }
      if (command === 'db_query') {
        return []
      }
      if (command === 'note_read') {
        return content
      }
      return null
    })

    const mutations = await applyIndexChanges(
      [{ path: 'notes/a.md', kind: 'upsert', modifiedMs: 2_000 }],
      9,
    )

    // The re-stamp counts as a mutation: `updated_at` moved, so
    // recency-ordered queries must be invalidated.
    expect(mutations).toBe(1)
    const touch = mockInvoke.mock.calls.find(([cmd]) => cmd === 'index_touch')
    expect(touch![1]).toEqual({
      entries: [{ path: 'notes/a.md', mtime: 2_000 }],
      generation: 9,
    })
    expect(mockInvoke.mock.calls.map(([cmd]) => cmd)).not.toContain('index_apply_batch')
  })

  it('still reads when the reported mtime is too fresh to trust', async () => {
    // Local write echoes stamp rows with Date.now(): two same-millisecond
    // saves would look "unchanged" by mtime alone, so fresh mtimes always
    // take the read-and-hash path.
    const now = 1_750_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      mockInvoke.mockImplementation(async (command, args) => {
        const sql = String(args['sql'] ?? '')
        if (command === 'db_query' && sql.includes('file_hash')) {
          return [{ path: 'notes/a.md', file_hash: 'stale', mtime: now - 10 }]
        }
        if (command === 'db_query') {
          return []
        }
        if (command === 'note_read') {
          return '# fresh content'
        }
        return null
      })

      const mutations = await applyIndexChanges(
        [{ path: 'notes/a.md', kind: 'upsert', modifiedMs: now - 10 }],
        9,
      )

      expect(mutations).toBe(1)
      const commands = mockInvoke.mock.calls.map(([cmd]) => cmd)
      expect(commands).toContain('note_read')
      expect(commands).toContain('index_apply_batch')
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

  it('searchNotes runs the palette ranked query (title match, bm25, pinned, recency)', async () => {
    await searchNotes('hello')
    const query = mockInvoke.mock.calls.find(([cmd]) => cmd === 'db_query')
    const sql = String((query![1] as { sql: string }).sql).toLowerCase()
    // searchNotes delegates to `searchWithFilters`, so it emits the palette's
    // ranked query verbatim — one search path, orderings can't drift.
    expect(sql).toContain('with "lexical" as materialized')
    expect(sql).toContain('left join "lexical"')
    expect(sql).toContain('when "filtered_notes"."title_key" =')
    expect(sql).toContain(`instr(' ' || "filtered_notes"."title_key"`)
    expect(sql).toContain('bm25(search_fts, 0, 10.0, 1.0)')
    expect(sql).toContain('"filtered_notes"."is_pinned" desc')
    expect(sql).toContain('"filtered_notes"."mtime" desc')
    expect(sql).toContain('"filtered_notes"."path" asc')
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
      if (command === 'index_reconcile_scan') {
        return {
          total: 1,
          candidates: [{ path: NEW, modifiedMs: 9, storedMtime: null, storedHash: null }],
          orphans: [{ path: OLD, storedMtime: 1, storedHash: options.storedHash }],
        }
      }
      if (command === 'note_read') {
        if (args['path'] === NEW) {
          return options.content ?? CONTENT
        }
        throw { kind: 'notFound', message: 'missing' }
      }
      if (command === 'db_query') {
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
    expect(commands).not.toContain('index_apply_batch')
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
    const apply = calls.find(([command]) => command === 'index_apply_batch')
    expect(apply).toBeDefined()
    const notes = apply![1]['notes'] as Array<{ path: string }>
    expect(notes.map((note) => note.path)).toEqual([NEW])
  })

  it('a legacy file without an id still reconciles as delete+create', async () => {
    const calls = renameFake({
      storedHash: 'whatever',
      content: '# Meeting Notes\n',
    })

    await reconcileIndex({ generation: 4 })

    const commands = calls.map(([command]) => command)
    expect(commands).not.toContain('index_move')
    expect(commands).toContain('index_apply_batch')
    expect(commands).toContain('index_remove')
  })
})

describe('reconcileIndex over the native scan delta', () => {
  it('does nothing when the scan reports no delta — the healthy-open path', async () => {
    // Mtime-matched files never leave Rust (the scan's own tests cover the
    // classification); an empty delta must cost no reads, no writes, and no
    // visible progress.
    mockInvoke.mockImplementation(async (command) => {
      if (command === 'index_reconcile_scan') {
        return { total: 7_000, candidates: [], orphans: [] }
      }
      if (command === 'note_read') {
        throw new Error('must not read without a candidate')
      }
      if (command === 'db_query') {
        return []
      }
      return null
    })
    const progress: Array<[number, number, number]> = []

    await reconcileIndex({
      generation: 4,
      onFileProgress: (done, total, worked) => progress.push([done, total, worked]),
    })

    const commands = mockInvoke.mock.calls.map(([cmd]) => cmd)
    expect(commands).toEqual(['index_reconcile_scan'])
    // Zero worked files, and the total is the delta (0), not the graph size —
    // the pill stays hidden on every routine open.
    expect(progress).toEqual([[0, 0, 0]])
  })

  it('reads (and hash-skips) a candidate whose stored mtime differs — providers rewrite mtimes', async () => {
    const content = '# Hello\n'
    const storedHash = await hashContent(content)
    mockInvoke.mockImplementation(async (command) => {
      if (command === 'index_reconcile_scan') {
        return {
          total: 1,
          candidates: [{ path: 'notes/a.md', modifiedMs: 2_000, storedMtime: 1_000, storedHash }],
          orphans: [],
        }
      }
      if (command === 'note_read') {
        return content
      }
      if (command === 'db_query') {
        return []
      }
      return null
    })

    const progress: Array<[number, number, number]> = []

    await reconcileIndex({
      generation: 4,
      onFileProgress: (done, total, worked) => progress.push([done, total, worked]),
    })

    const commands = mockInvoke.mock.calls.map(([cmd]) => cmd)
    expect(commands).toContain('note_read')
    // Identical content under a rewritten mtime: the hash still gates the write.
    expect(commands).not.toContain('index_apply_batch')
    // The self-heal: the row is re-stamped with the listed mtime, so the next
    // scan skips it entirely instead of re-reading forever.
    const touch = mockInvoke.mock.calls.find(([cmd]) => cmd === 'index_touch')
    expect(touch![1]).toEqual({
      entries: [{ path: 'notes/a.md', mtime: 2_000 }],
      generation: 4,
    })
    // The read counts as worked even though nothing was re-applied.
    expect(progress.at(-1)).toEqual([1, 1, 1])
  })

  it('re-indexes changed candidates and drops orphans', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === 'index_reconcile_scan') {
        return {
          total: 2,
          candidates: [
            { path: 'notes/changed.md', modifiedMs: 2_000, storedMtime: 1_000, storedHash: 'old' },
          ],
          orphans: [{ path: 'notes/gone.md', storedMtime: 1_000, storedHash: 'gone' }],
        }
      }
      if (command === 'note_read') {
        return `# ${String(args['path'])}\n`
      }
      if (command === 'db_query') {
        return []
      }
      return null
    })

    await reconcileIndex({ generation: 4 })

    const apply = mockInvoke.mock.calls.find(([cmd]) => cmd === 'index_apply_batch')
    const notes = (apply![1] as { notes: Array<{ path: string; mtime: number }> }).notes
    expect(notes.map((note) => note.path)).toEqual(['notes/changed.md'])
    expect(notes[0]!.mtime).toBe(2_000)
    const remove = mockInvoke.mock.calls.find(([cmd]) => cmd === 'index_remove')
    expect(remove![1]).toMatchObject({ path: 'notes/gone.md', generation: 4 })
  })

  it('removes the row for a candidate that vanished between the scan and the read', async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === 'index_reconcile_scan') {
        return {
          total: 1,
          candidates: [
            { path: 'notes/ghost.md', modifiedMs: 2_000, storedMtime: 1_000, storedHash: 'h' },
          ],
          orphans: [],
        }
      }
      if (command === 'note_read') {
        throw { kind: 'notFound', message: 'vanished' }
      }
      if (command === 'db_query') {
        return []
      }
      return null
    })

    await reconcileIndex({ generation: 4 })

    const remove = mockInvoke.mock.calls.find(([cmd]) => cmd === 'index_remove')
    expect(remove![1]).toMatchObject({ path: 'notes/ghost.md', generation: 4 })
  })
})

describe('iCloud eviction placeholders (Plan 21)', () => {
  /** A graph whose listing carries `files`; every note_read throws notFound. */
  // Reconcile-side placeholder rules (never a candidate, never an orphan)
  // now live in the Rust scan — `reconcile_scan_classifies_candidates_orphans_and_skips`
  // in src-tauri covers them. Only the rebuild path still walks the listing here.
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
