import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import { parseSearchQuery } from './filter-query'
import { searchWithFilters } from './filtered-search'

const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

function startOfLocalDay(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year!, month! - 1, day!).getTime()
}

beforeEach(() => {
  mockInvoke.mockReset()
  setBridge({ invoke: mockInvoke, listen: async () => () => {} })
})

afterEach(() => {
  setBridge(null)
})

describe('searchWithFilters', () => {
  it('starts tag-only recall searches from the folded tag key', async () => {
    mockInvoke.mockResolvedValueOnce([
      { path: 'notes/work.md', title: 'Work', daily_date: null },
    ])

    const hits = await searchWithFilters(parseSearchQuery('#Work'), 12)

    expect(hits).toEqual([
      { path: 'notes/work.md', title: 'Work', dailyDate: null, snippet: null },
    ])

    const [command, args] = mockInvoke.mock.calls[0]!
    expect(command).toBe('db_query')
    const sql = String(args['sql'])
    expect(sql).toContain('from "tags"')
    expect(sql).toContain('inner join "notes"')
    expect(sql).toContain('"tags"."tag_key"')
    expect(sql).not.toContain('search_fts')
    expect(sql).not.toContain('lower(')
    expect(args['params']).toEqual(['work', 12])
  })

  it('keeps additional tag filters as indexed existence checks', async () => {
    mockInvoke.mockResolvedValueOnce([
      { path: 'notes/work.md', title: 'Work', daily_date: null },
    ])

    await searchWithFilters(parseSearchQuery('#Work #Home'), 12)

    const [, args] = mockInvoke.mock.calls[0]!
    const sql = String(args['sql'])
    expect(sql).toContain('from "tags"')
    expect(sql).toContain('from "tags" as "filter_tags"')
    expect(sql).toContain('"filter_tags"."note_path" = "notes"."path"')
    expect(sql).toContain('"filter_tags"."tag_key"')
    expect(sql).not.toContain('search_fts')
    expect(args['params']).toEqual(['work', 'home', 12])
  })

  it('applies non-tag filters on the tag-first recall path', async () => {
    mockInvoke.mockResolvedValueOnce([
      { path: 'daily/2026-01-02.md', title: '2026-01-02', daily_date: '2026-01-02' },
    ])

    const parsed = parseSearchQuery('#Work is:daily is:pinned updated:>2026-01-01')
    const hits = await searchWithFilters(parsed, 12)

    expect(hits).toEqual([
      {
        path: 'daily/2026-01-02.md',
        title: '2026-01-02',
        dailyDate: '2026-01-02',
        snippet: null,
      },
    ])
    const [, args] = mockInvoke.mock.calls[0]!
    const sql = String(args['sql'])
    expect(sql).toContain('from "tags"')
    expect(sql).toContain('"notes"."daily_date" is not null')
    expect(sql).toContain('"notes"."is_pinned" =')
    expect(sql).toContain('"notes"."mtime" >=')
    expect(sql).not.toContain('search_fts')
    expect(args['params']).toEqual(['work', 1, startOfLocalDay('2026-01-01'), 12])
  })

  it('promotes exact title, then bm25, then pinned and recency on text search', async () => {
    mockInvoke.mockResolvedValueOnce([
      { path: 'notes/quokka.md', title: 'Quokka', daily_date: null, snippet: 'a …' },
    ])

    const hits = await searchWithFilters(parseSearchQuery('quokka'), 12)

    expect(hits).toEqual([
      { path: 'notes/quokka.md', title: 'Quokka', dailyDate: null, snippet: 'a …' },
    ])

    const [command, args] = mockInvoke.mock.calls[0]!
    expect(command).toBe('db_query')
    const sql = String(args['sql']).toLowerCase()
    expect(sql).toContain('search_fts match')
    // Exact-title rank leads, then title-boosted bm25, then the deterministic
    // pinned/recency/path tiebreakers — in that order.
    expect(sql).toContain('case when "notes"."title_key" =')
    expect(sql).toContain('bm25(search_fts, 0, 10.0, 1.0)')
    expect(sql).toContain('"notes"."is_pinned" desc')
    expect(sql).toContain('"notes"."mtime" desc')
    expect(sql).toContain('"notes"."path" asc')

    const params = args['params'] as unknown[]
    // The folded exact-title key and the literal FTS match expression.
    expect(params).toContain('quokka')
    expect(params).toContain('"quokka"')
  })

  it('folds the exact-title key the way titles were indexed', async () => {
    mockInvoke.mockResolvedValueOnce([])

    await searchWithFilters(parseSearchQuery('Quokka Habitat'), 12)

    const [, args] = mockInvoke.mock.calls[0]!
    const params = args['params'] as unknown[]
    // foldKey('Quokka Habitat') — trimmed + lowercased — so it matches the
    // stored `notes.title_key`, never the raw casing.
    expect(params).toContain('quokka habitat')
  })
})
