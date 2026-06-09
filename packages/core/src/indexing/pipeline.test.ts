import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getBacklinks, resolveWikiTarget, searchNotes } from './queries'
import { indexNote, rebuildIndex } from './indexer'
import { applyIndexChanges } from './watch'

// Mock the Tauri bridge so both core's `call` and @reflect/db's dialect resolve
// against an in-test fake — exercises the pipeline + the Kysely→db_query bridge.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const mockInvoke = vi.mocked(invoke)

beforeEach(() => {
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command, args) => {
    const sql = String((args as { sql?: string } | undefined)?.sql ?? '')
    switch (command) {
      case 'note_read':
        return '# Hello\n\n[[World]]'
      case 'list_files':
        return [{ path: 'notes/a.md', size: 1, modifiedMs: 5 }]
      case 'index_apply':
      case 'index_clear':
      case 'index_remove':
        return null
      case 'db_query':
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
  it('clears, lists, then applies every file', async () => {
    await rebuildIndex({ generation: 1 })
    const commands = mockInvoke.mock.calls.map(([cmd]) => cmd)
    expect(commands[0]).toBe('index_clear')
    expect(commands).toContain('list_files')
    expect(commands.filter((c) => c === 'index_apply')).toHaveLength(1)
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
