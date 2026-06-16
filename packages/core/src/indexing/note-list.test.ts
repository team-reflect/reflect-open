import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import { listNotes, listNoteTags, listRecentNotes } from './note-list'

// A fake bridge resolves `db_query` so the tests exercise the real compiled
// SQL (snake_case columns, parameters) — the same harness queries.test uses.
const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

beforeEach(() => {
  mockInvoke.mockReset()
  setBridge({ invoke: mockInvoke, listen: async () => () => {} })
})

afterEach(() => {
  setBridge(null)
})

describe('listNotes', () => {
  it('lists non-daily notes newest first with stored previews and grouped tags', async () => {
    mockInvoke
      .mockResolvedValueOnce([
        {
          path: 'notes/health.md',
          title: 'Health Stacked',
          mtime: 2000,
          preview: 'Shop your health goals.',
        },
        {
          path: 'notes/tokyo.md',
          title: 'Tokyo Gâteau',
          mtime: 1000,
          preview: '',
        },
      ])
      .mockResolvedValueOnce([
        { note_path: 'notes/health.md', tag: 'health' },
        { note_path: 'notes/health.md', tag: 'link' },
      ])

    const entries = await listNotes()

    expect(entries).toEqual([
      {
        path: 'notes/health.md',
        title: 'Health Stacked',
        mtime: 2000,
        snippet: 'Shop your health goals.',
        tags: ['health', 'link'],
      },
      {
        path: 'notes/tokyo.md',
        title: 'Tokyo Gâteau',
        mtime: 1000,
        snippet: '',
        tags: [],
      },
    ])

    const [command, args] = mockInvoke.mock.calls[0]!
    expect(command).toBe('db_query')
    const sql = String(args['sql'])
    // The snippet is the stored projection column — no note_text join, no
    // per-query derivation.
    expect(sql).toContain('"preview"')
    expect(sql).not.toContain('note_text')
    expect(sql).toContain('"daily_date" is null')
    expect(sql).toContain('order by "notes"."mtime" desc')
    expect(sql).not.toContain('exists')
    // Uncapped: the screen virtualizes instead.
    expect(sql).not.toContain('limit')

    // The tag fetch joins the same note predicates — never a `note_path IN`
    // list, whose per-row parameter would hit SQLite's bound-parameter
    // ceiling on large graphs.
    const [, tagArgs] = mockInvoke.mock.calls[1]!
    const tagSql = String(tagArgs['sql'])
    expect(tagSql).toContain('inner join "notes"')
    expect(tagSql).toContain('"daily_date" is null')
    expect(tagSql).not.toContain(' in (')
    expect(tagArgs['params']).toEqual([])
  })

  it('narrows both queries to one tag via tag-first joins on the stored folded tag_key', async () => {
    mockInvoke
      .mockResolvedValueOnce([
        { path: 'notes/health.md', title: 'Health Stacked', mtime: 2000, preview: '' },
      ])
      .mockResolvedValueOnce([])

    await listNotes({ tag: 'Book' })

    expect(mockInvoke).toHaveBeenCalledTimes(2)
    const [, listArgs] = mockInvoke.mock.calls[0]!
    const listSql = String(listArgs['sql'])
    expect(listSql).toContain('from "tags"')
    expect(listSql).toContain('inner join "notes"')
    expect(listSql).toContain('"tags"."tag_key"')
    expect(listSql).not.toContain('exists')
    expect(listSql).not.toContain('lower(')
    expect(listArgs['params']).toEqual(['book'])

    const [, tagArgs] = mockInvoke.mock.calls[1]!
    const tagSql = String(tagArgs['sql'])
    expect(tagSql).toContain('inner join "tags" as "filter_tags"')
    expect(tagSql).toContain('"filter_tags"."tag_key"')
    expect(tagSql).not.toContain('exists')
    expect(tagSql).not.toContain('lower(')
    expect(tagArgs['params']).toEqual(['book'])
  })

  it('skips the tag fetch entirely when no notes match', async () => {
    mockInvoke.mockResolvedValue([])
    await expect(listNotes({ tag: 'nothing' })).resolves.toEqual([])
    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })
})

describe('listRecentNotes', () => {
  it('caps public non-daily rows, newest first, with a boolean privacy flag', async () => {
    mockInvoke.mockResolvedValueOnce([
      {
        path: 'notes/health.md',
        title: 'Health Stacked',
        preview: 'Shop your health goals.',
        mtime: 2000,
        is_private: 0,
      },
    ])

    const rows = await listRecentNotes({ limit: 5 })

    expect(rows).toEqual([
      {
        path: 'notes/health.md',
        title: 'Health Stacked',
        preview: 'Shop your health goals.',
        mtime: 2000,
        isPrivate: false,
      },
    ])
    const [command, args] = mockInvoke.mock.calls[0]!
    expect(command).toBe('db_query')
    const sql = String(args['sql'])
    expect(sql).toContain('"daily_date" is null')
    expect(sql).toContain('"is_private"')
    expect(sql).toContain('order by "notes"."mtime" desc')
    expect(sql).toContain('limit')
    expect(args['params']).toEqual([0, 5])
  })

  it('narrows to one tag via the stored folded tag_key', async () => {
    mockInvoke.mockResolvedValueOnce([])

    await listRecentNotes({ limit: 5, tag: 'Book' })

    const [, args] = mockInvoke.mock.calls[0]!
    const sql = String(args['sql'])
    expect(sql).toContain('from "tags"')
    expect(sql).toContain('inner join "notes"')
    expect(sql).toContain('"tags"."tag_key"')
    expect(sql).not.toContain('exists')
    expect(sql).not.toContain('lower(')
    expect(args['params']).toEqual(['book', 0, 5])
  })
})

describe('listNoteTags', () => {
  it('groups tags on the stored key over non-daily notes', async () => {
    mockInvoke.mockResolvedValue([
      { tag: 'Book', count: 3 },
      { tag: 'link', count: 12 },
    ])

    const facets = await listNoteTags()

    expect(facets).toEqual([
      { tag: 'Book', count: 3 },
      { tag: 'link', count: 12 },
    ])
    const [command, args] = mockInvoke.mock.calls[0]!
    expect(command).toBe('db_query')
    const sql = String(args['sql'])
    expect(sql).toContain('"daily_date" is null')
    expect(sql).toContain('group by "tags"."tag_key"')
  })
})
