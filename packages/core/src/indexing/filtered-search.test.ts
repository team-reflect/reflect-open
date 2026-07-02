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
      {
        path: 'notes/work.md',
        title: 'Work',
        daily_date: null,
        preview: 'Weekly agenda.',
        mtime: 2000,
        is_pinned: 0,
      },
    ])

    const hits = await searchWithFilters(parseSearchQuery('#Work'))

    expect(hits).toEqual([
      {
        path: 'notes/work.md',
        title: 'Work',
        dailyDate: null,
        snippet: null,
        preview: 'Weekly agenda.',
        mtime: 2000,
        isPinned: false,
      },
    ])

    const [command, args] = mockInvoke.mock.calls[0]!
    expect(command).toBe('db_query')
    const sql = String(args['sql'])
    expect(sql).toContain('from "tags"')
    expect(sql).toContain('inner join "notes"')
    expect(sql).toContain('"tags"."tag_key"')
    expect(sql).not.toContain('search_fts')
    expect(sql).not.toContain('lower(')
    // The template exclusion rides every search path.
    expect(sql).toContain('"notes"."kind" != ?')
    expect(args['params']).toEqual(['work', 'template', 12])
  })

  it('keeps additional tag filters as indexed existence checks', async () => {
    mockInvoke.mockResolvedValueOnce([
      {
        path: 'notes/work.md',
        title: 'Work',
        daily_date: null,
        preview: '',
        mtime: 0,
        is_pinned: 0,
      },
    ])

    await searchWithFilters(parseSearchQuery('#Work #Home'))

    const [, args] = mockInvoke.mock.calls[0]!
    const sql = String(args['sql'])
    expect(sql).toContain('from "tags"')
    expect(sql).toContain('from "tags" as "filter_tags"')
    expect(sql).toContain('"filter_tags"."note_path" = "notes"."path"')
    expect(sql).toContain('"filter_tags"."tag_key"')
    expect(sql).not.toContain('search_fts')
    expect(args['params']).toEqual(['work', 'template', 'home', 12])
  })

  it('applies non-tag filters on the tag-first recall path', async () => {
    mockInvoke.mockResolvedValueOnce([
      {
        path: 'daily/2026-01-02.md',
        title: '2026-01-02',
        daily_date: '2026-01-02',
        preview: 'Standup notes.',
        mtime: 1000,
        is_pinned: 1,
      },
    ])

    const parsed = parseSearchQuery('#Work is:daily is:pinned updated:>2026-01-01')
    const hits = await searchWithFilters(parsed)

    expect(hits).toEqual([
      {
        path: 'daily/2026-01-02.md',
        title: '2026-01-02',
        dailyDate: '2026-01-02',
        snippet: null,
        preview: 'Standup notes.',
        mtime: 1000,
        isPinned: true,
      },
    ])
    const [, args] = mockInvoke.mock.calls[0]!
    const sql = String(args['sql'])
    expect(sql).toContain('from "tags"')
    expect(sql).toContain('"notes"."daily_date" is not null')
    expect(sql).toContain('"notes"."is_pinned" =')
    expect(sql).toContain('"notes"."mtime" >=')
    expect(sql).not.toContain('search_fts')
    expect(args['params']).toEqual(['work', 'template', 1, startOfLocalDay('2026-01-01'), 12])
  })

  it('promotes exact title, then bm25, then pinned and recency on text search', async () => {
    mockInvoke.mockResolvedValueOnce([
      {
        path: 'notes/quokka.md',
        title: 'Quokka',
        daily_date: null,
        preview: 'Quokka facts.',
        mtime: 3000,
        is_pinned: 0,
        snippet: 'a …',
      },
    ])

    const hits = await searchWithFilters(parseSearchQuery('quokka'))

    expect(hits).toEqual([
      {
        path: 'notes/quokka.md',
        title: 'Quokka',
        dailyDate: null,
        snippet: 'a …',
        preview: 'Quokka facts.',
        mtime: 3000,
        isPinned: false,
      },
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

    await searchWithFilters(parseSearchQuery('Quokka Habitat'))

    const [, args] = mockInvoke.mock.calls[0]!
    const params = args['params'] as unknown[]
    // foldKey('Quokka Habitat') — trimmed + lowercased — so it matches the
    // stored `notes.title_key`, never the raw casing.
    expect(params).toContain('quokka habitat')
  })

  it('leaves the recall feed uncapped when limit is null', async () => {
    mockInvoke.mockResolvedValueOnce([])

    await searchWithFilters(parseSearchQuery('is:pinned'), { limit: null })

    const [, args] = mockInvoke.mock.calls[0]!
    const sql = String(args['sql'])
    expect(sql).not.toContain('limit')
    expect(args['params']).toEqual(['template', 1])
  })

  it('orders the recall feed pinned-first when asked (the All list order)', async () => {
    mockInvoke.mockResolvedValueOnce([])

    await searchWithFilters(parseSearchQuery('is:daily'), { limit: null, pinnedFirst: true })

    const [, args] = mockInvoke.mock.calls[0]!
    const sql = String(args['sql'])
    const pinned = sql.indexOf('"notes"."is_pinned" desc')
    const order = sql.indexOf('"notes"."pinned_order" is null')
    const mtime = sql.indexOf('"notes"."mtime" desc')
    expect(pinned).toBeGreaterThan(-1)
    expect(order).toBeGreaterThan(pinned)
    expect(mtime).toBeGreaterThan(order)
  })

  it('orders the tag-first recall path pinned-first when asked', async () => {
    mockInvoke.mockResolvedValueOnce([])

    await searchWithFilters(parseSearchQuery('#Work'), { limit: null, pinnedFirst: true })

    const [, args] = mockInvoke.mock.calls[0]!
    const sql = String(args['sql'])
    expect(sql).toContain('from "tags"')
    expect(sql.indexOf('"notes"."is_pinned" desc')).toBeGreaterThan(-1)
    expect(sql.indexOf('"notes"."mtime" desc')).toBeGreaterThan(
      sql.indexOf('"notes"."is_pinned" desc'),
    )
  })

  it('resolves links: tokens by title before filtering (token behavior unchanged)', async () => {
    mockInvoke.mockResolvedValueOnce([{ path: 'notes/alpha-1.md' }])
    mockInvoke.mockResolvedValueOnce([])

    await searchWithFilters(parseSearchQuery('links:Alpha'))

    expect(mockInvoke).toHaveBeenCalledTimes(2)
    const [, args] = mockInvoke.mock.calls[1]!
    const sql = String(args['sql'])
    expect(sql).toContain('"backlinks"."source_path" = "notes"."path"')
    expect(sql).toContain('"backlinks"."target_path" = ?')
    expect(args['params']).toContain('notes/alpha-1.md')
  })

  it('filters by a picker-exact link target without resolving titles', async () => {
    mockInvoke.mockResolvedValueOnce([])

    const parsed = parseSearchQuery('')
    parsed.filters.linksToPath = 'notes/project-2.md'
    await searchWithFilters(parsed)

    // One query only: the exact path never round-trips through the resolver.
    expect(mockInvoke).toHaveBeenCalledTimes(1)
    const [, args] = mockInvoke.mock.calls[0]!
    const sql = String(args['sql'])
    expect(sql).toContain('"backlinks"."source_path" = "notes"."path"')
    expect(sql).toContain('"backlinks"."target_path" = ?')
    expect(args['params']).toContain('notes/project-2.md')
  })

  it('filters by a picker-exact link source without resolving titles', async () => {
    mockInvoke.mockResolvedValueOnce([])

    const parsed = parseSearchQuery('')
    parsed.filters.linkedFromPath = 'notes/hub-2.md'
    await searchWithFilters(parsed)

    expect(mockInvoke).toHaveBeenCalledTimes(1)
    const [, args] = mockInvoke.mock.calls[0]!
    const sql = String(args['sql'])
    expect(sql).toContain('"backlinks"."target_path" = "notes"."path"')
    expect(sql).toContain('"backlinks"."source_path" = ?')
    expect(args['params']).toContain('notes/hub-2.md')
  })

  it('lets an exact path win over a title target (duplicate titles cannot retarget)', async () => {
    mockInvoke.mockResolvedValueOnce([])

    const parsed = parseSearchQuery('links:Alpha')
    parsed.filters.linksToPath = 'notes/alpha-2.md'
    await searchWithFilters(parsed)

    expect(mockInvoke).toHaveBeenCalledTimes(1)
    const [, args] = mockInvoke.mock.calls[0]!
    expect(args['params']).toContain('notes/alpha-2.md')
    expect(args['params']).not.toContain('notes/alpha-1.md')
  })

  it('applies picker-exact link targets on the tag-first recall path', async () => {
    mockInvoke.mockResolvedValueOnce([])

    const parsed = parseSearchQuery('#Work')
    parsed.filters.linkedFromPath = 'notes/hub.md'
    await searchWithFilters(parsed)

    expect(mockInvoke).toHaveBeenCalledTimes(1)
    const [, args] = mockInvoke.mock.calls[0]!
    const sql = String(args['sql'])
    expect(sql).toContain('from "tags"')
    expect(sql).toContain('"backlinks"."source_path" = ?')
    expect(args['params']).toContain('notes/hub.md')
  })

  it('restricts the population to regular notes with notesOnly', async () => {
    mockInvoke.mockResolvedValueOnce([])

    await searchWithFilters(parseSearchQuery('is:pinned'), { limit: null, notesOnly: true })

    const [, args] = mockInvoke.mock.calls[0]!
    const sql = String(args['sql'])
    expect(sql).toContain('"notes"."kind" = ?')
    expect(args['params']).toEqual(['template', 'note', 1])
  })

  it('lets an explicit daily filter win over notesOnly', async () => {
    mockInvoke.mockResolvedValueOnce([])

    await searchWithFilters(parseSearchQuery('is:daily'), { limit: null, notesOnly: true })

    const [, args] = mockInvoke.mock.calls[0]!
    const sql = String(args['sql'])
    expect(sql).toContain('"notes"."daily_date" is not null')
    expect(sql).not.toContain('"notes"."kind" = ?')
  })
})
