import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import { getBacklinks, resolveWikiTarget, searchNotes } from './queries'
import { PROJECTION_VERSION } from './indexed-note'
import { indexNote, rebuildIndex, syncIndex, PROJECTION_VERSION_KEY } from './indexer'
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
    const sql = String(args.sql ?? '')
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
    expect(args.note.path).toBe('notes/a.md')
    expect(args.note.title).toBe('Hello')
    expect(args.note.fileHash).toMatch(/^[0-9a-f]{64}$/)
    expect((args.note.links as { targetKey: string }[]).map((link) => link.targetKey)).toContain('world')
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
        { path: 'notes/a.md', kind: 'upsert' },
        { path: 'notes/gone.md', kind: 'remove' },
      ],
      9,
    )
    const apply = mockInvoke.mock.calls.find(([cmd]) => cmd === 'index_apply')
    const remove = mockInvoke.mock.calls.find(([cmd]) => cmd === 'index_remove')
    expect((apply![1] as { note: { path: string }; generation: number }).generation).toBe(9)
    expect((apply![1] as { note: { path: string } }).note.path).toBe('notes/a.md')
    expect(remove![1]).toMatchObject({ path: 'notes/gone.md', generation: 9 })
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
