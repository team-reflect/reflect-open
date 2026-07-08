import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import {
  dailyDatesInRange,
  getBacklinksWithContext,
  getDuplicateNoteIds,
  getNoteIdsByPath,
  getOpenTasks,
  getPinnedNotes,
  listDailyNotes,
  noteTitleOwningEmail,
  suggestWikiTargets,
} from './queries'

// A fake bridge resolves `db_query` so the test exercises the real compiled
// SQL (snake_case columns, range parameters) — the same harness pipeline.test
// uses for the indexer.
const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

beforeEach(() => {
  mockInvoke.mockReset()
  setBridge({ invoke: mockInvoke, listen: async () => () => {} })
})

afterEach(() => {
  setBridge(null)
})

describe('dailyDatesInRange', () => {
  it('queries the notes daily_date column with inclusive bounds', async () => {
    mockInvoke.mockResolvedValue([
      { daily_date: '2026-06-01' },
      { daily_date: '2026-06-09' },
    ])

    const dates = await dailyDatesInRange('2026-06-01', '2026-06-30')

    expect(dates).toEqual(['2026-06-01', '2026-06-09'])
    const [command, args] = mockInvoke.mock.calls[0]!
    expect(command).toBe('db_query')
    const sql = String(args['sql'])
    expect(sql).toContain('daily_date')
    expect(sql).toContain('is not null')
    expect(args['params']).toEqual(['2026-06-01', '2026-06-30'])
  })

  it('returns an empty list when no daily notes exist in the range', async () => {
    mockInvoke.mockResolvedValue([])
    await expect(dailyDatesInRange('2025-01-01', '2025-01-31')).resolves.toEqual([])
  })
})

describe('noteTitleOwningEmail', () => {
  it('joins note_emails to #person-tagged regular notes by folded key, first path wins', async () => {
    mockInvoke.mockResolvedValue([{ title: 'Jane Doe' }])

    await expect(noteTitleOwningEmail('  Jane@Corp.com ')).resolves.toBe('Jane Doe')

    const [command, args] = mockInvoke.mock.calls[0]!
    expect(command).toBe('db_query')
    const sql = String(args['sql'])
    expect(sql).toContain('note_emails')
    expect(sql).toContain('email_key')
    expect(sql).toContain('tag_key')
    expect(sql).toContain('kind')
    expect(sql).toContain('order by')
    expect(args['params']).toEqual(['jane@corp.com', 'person', 'note'])
  })

  it('answers null for an unowned address without guessing', async () => {
    mockInvoke.mockResolvedValue([])
    await expect(noteTitleOwningEmail('nobody@corp.com')).resolves.toBeNull()
  })

  it('short-circuits a blank address before touching the bridge', async () => {
    await expect(noteTitleOwningEmail('   ')).resolves.toBeNull()
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})

describe('listDailyNotes', () => {
  it('selects public dailies in the inclusive range, most recent first, capped', async () => {
    mockInvoke.mockResolvedValue([
      {
        path: 'daily/2026-06-09.md',
        title: '2026-06-09',
        daily_date: '2026-06-09',
        preview: 'Stand-up notes.',
        mtime: 2000,
        is_private: 0,
      },
    ])

    const rows = await listDailyNotes({ start: '2026-06-01', end: '2026-06-30', limit: 32 })

    expect(rows).toEqual([
      {
        path: 'daily/2026-06-09.md',
        title: '2026-06-09',
        dailyDate: '2026-06-09',
        preview: 'Stand-up notes.',
        mtime: 2000,
        isPrivate: false,
      },
    ])
    const [command, args] = mockInvoke.mock.calls[0]!
    expect(command).toBe('db_query')
    const sql = String(args['sql'])
    expect(sql).toContain('daily_date')
    expect(sql).toContain('is not null')
    expect(sql).toContain('"is_private"')
    expect(sql).toContain('order by "daily_date" desc')
    expect(sql).toContain('limit')
    expect(args['params']).toEqual(['2026-06-01', '2026-06-30', 0, 32])
  })

  it('returns an empty list when no daily notes exist in the range', async () => {
    mockInvoke.mockResolvedValue([])
    await expect(
      listDailyNotes({ start: '2025-01-01', end: '2025-01-31', limit: 32 }),
    ).resolves.toEqual([])
  })
})

describe('getBacklinksWithContext', () => {
  it('orders sources most recent first — daily date for dailies, edit time otherwise (V1 parity)', async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === 'db_query') {
        return [
          { source_path: 'daily/2026-07-01.md', pos_from: 4, source_title: '2026-07-01' },
          { source_path: 'notes/older.md', pos_from: 9, source_title: 'Older' },
        ]
      }
      return 'a line with a [[target]] link'
    })

    const rows = await getBacklinksWithContext('notes/target.md')

    expect(rows.map((row) => row.sourcePath)).toEqual([
      'daily/2026-07-01.md',
      'notes/older.md',
    ])
    const [command, args] = mockInvoke.mock.calls[0]!
    expect(command).toBe('db_query')
    const sql = String(args['sql'])
    // Recency interleaves dailies (calendar date) with regular notes (edit
    // time); title must not be the sort key.
    expect(sql).toContain(
      'order by coalesce(strftime(\'%s\', "notes"."daily_date") * 1000, "notes"."updated_at") desc',
    )
    expect(sql).not.toContain('order by "notes"."title"')
    // Groups stay contiguous and links keep document order.
    expect(sql).toContain('"backlinks"."source_path"')
    expect(sql).toContain('"backlinks"."pos_from"')
  })

  it('extracts the block context around the link — a list item keeps its children', async () => {
    const content = '- kickoff with [[target]]\n  - prep the agenda\n- unrelated\n'
    mockInvoke.mockImplementation(async (command) => {
      if (command === 'db_query') {
        return [
          {
            source_path: 'notes/source.md',
            pos_from: content.indexOf('[[target]]'),
            source_title: 'Source',
          },
        ]
      }
      return content
    })

    const rows = await getBacklinksWithContext('notes/target.md')

    expect(rows.map((row) => row.snippet)).toEqual([
      '- kickoff with [[target]]\n  - prep the agenda',
    ])
  })

  it('co-groups sibling branches through the target aliases, not just the clicked spelling', async () => {
    const content = '- parent line\n  - one [[Project X]]\n  - two [[projx]]\n'
    mockInvoke.mockImplementation(async (command, args) => {
      if (command !== 'db_query') {
        return content
      }
      const sql = String(args['sql'])
      if (sql.includes('note_keys')) {
        return [{ key: 'project x' }, { key: 'projx' }]
      }
      return [
        {
          source_path: 'notes/source.md',
          pos_from: content.indexOf('[[Project X]]'),
          source_title: 'Source',
        },
      ]
    })

    const rows = await getBacklinksWithContext('notes/target.md')

    expect(rows.map((row) => row.snippet)).toEqual([
      '- parent line\n  - one [[Project X]]\n  - two [[projx]]',
    ])
  })

  it('collapses mentions with an identical context into one row (V1 parity)', async () => {
    const content = 'both [[target]] links on one [[target]] line\n\nanother [[target]] mention\n'
    mockInvoke.mockImplementation(async (command) => {
      if (command === 'db_query') {
        return [
          { source_path: 'notes/source.md', pos_from: 5, source_title: 'Source' },
          {
            source_path: 'notes/source.md',
            pos_from: content.lastIndexOf('[[target]] line'),
            source_title: 'Source',
          },
          {
            source_path: 'notes/source.md',
            pos_from: content.indexOf('another'),
            source_title: 'Source',
          },
        ]
      }
      return content
    })

    const rows = await getBacklinksWithContext('notes/target.md')

    expect(rows.map((row) => row.snippet)).toEqual([
      'both [[target]] links on one [[target]] line',
      'another [[target]] mention',
    ])
  })
})

describe('getPinnedNotes', () => {
  it('selects pinned rows: explicit orders first, then folded title', async () => {
    mockInvoke.mockResolvedValue([
      { path: 'notes/a.md', title: 'Alpha', daily_date: null, pinned_order: 0 },
      { path: 'notes/b.md', title: 'Beta', daily_date: null, pinned_order: null },
    ])

    const pinned = await getPinnedNotes()

    expect(pinned).toEqual([
      { path: 'notes/a.md', title: 'Alpha', dailyDate: null, pinnedOrder: 0 },
      { path: 'notes/b.md', title: 'Beta', dailyDate: null, pinnedOrder: null },
    ])
    const [command, args] = mockInvoke.mock.calls[0]!
    expect(command).toBe('db_query')
    const sql = String(args['sql'])
    expect(sql).toContain('is_pinned')
    // Ordered pins lead (NULL orders sort last), alphabetical within.
    expect(sql).toContain('order by pinned_order IS NULL')
    expect(sql).toContain('"pinned_order"')
    expect(sql).toContain('title_key')
    // A pinned template must not reach the sidebar's Pinned section.
    expect(sql).toContain('"kind" != ?')
    expect(args['params']).toEqual([1, 'template'])
  })
})

describe('getDuplicateNoteIds', () => {
  it('returns empty without a second query when no id is duplicated', async () => {
    mockInvoke.mockResolvedValue([])

    await expect(getDuplicateNoteIds()).resolves.toEqual([])

    expect(mockInvoke).toHaveBeenCalledTimes(1)
    const [command, args] = mockInvoke.mock.calls[0]!
    expect(command).toBe('db_query')
    const sql = String(args['sql'])
    expect(sql).toContain('group by')
    expect(sql).toContain('count(*)')
    expect(sql).toContain('is not null')
  })

  it('groups every path claiming a duplicated id, ordered', async () => {
    mockInvoke
      .mockResolvedValueOnce([{ id: 'dup-1' }])
      .mockResolvedValueOnce([
        { id: 'dup-1', path: 'notes/a.md' },
        { id: 'dup-1', path: 'notes/b.md' },
      ])

    await expect(getDuplicateNoteIds()).resolves.toEqual([
      { id: 'dup-1', paths: ['notes/a.md', 'notes/b.md'] },
    ])
    const [, args] = mockInvoke.mock.calls[1]!
    expect(args['params']).toEqual(['dup-1'])
  })
})

describe('getNoteIdsByPath', () => {
  it('asks nothing for no paths', async () => {
    await expect(getNoteIdsByPath([])).resolves.toEqual(new Map())
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('chunks the IN clause under SQLite variable limits and merges the results', async () => {
    // A mass external move can orphan thousands of paths in one reconcile —
    // a single statement would blow the bound-variable budget.
    const paths = Array.from({ length: 1200 }, (_, index) => `notes/${index}.md`)
    mockInvoke.mockImplementation(async (_command, args) => {
      const params = args['params'] as string[]
      return [{ path: params[0], id: `id-${params[0]}` }]
    })

    const ids = await getNoteIdsByPath(paths)

    expect(mockInvoke).toHaveBeenCalledTimes(3) // 500 + 500 + 200
    for (const [, args] of mockInvoke.mock.calls) {
      expect((args['params'] as string[]).length).toBeLessThanOrEqual(500)
    }
    expect(ids.get('notes/0.md')).toBe('id-notes/0.md')
    expect(ids.get('notes/500.md')).toBe('id-notes/500.md')
    expect(ids.get('notes/1000.md')).toBe('id-notes/1000.md')
  })
})

describe('suggestWikiTargets', () => {
  // Wednesday, 1 January 2020, day/month — the date generator's worked-example
  // clock. This exercises the live glue (generator + merge) the editor hits;
  // the parts themselves are unit-tested in date-suggestions/suggest.
  const clock = { today: '2020-01-01', dateFormat: 'dmy' as const, weekStartDay: 'monday' as const }

  it('synthesises a daily target from a fuzzy query when given a clock', async () => {
    mockInvoke.mockResolvedValue([]) // no title or alias matches

    await expect(suggestWikiTargets('3 days ago', 8, clock)).resolves.toEqual([
      {
        target: '2019-12-29',
        path: null,
        title: '2019-12-29',
        alias: null,
        date: '2019-12-29',
        generated: { phrase: '3 days ago' },
      },
    ])
  })

  it('keeps an exact title match above the generated date (folded key threaded into the merge)', async () => {
    mockInvoke.mockResolvedValue([]) // aliases query + fallback
    mockInvoke.mockResolvedValueOnce([
      { path: 'notes/today.md', title: 'Today', title_key: 'today', daily_date: null, mtime: 1 },
    ])

    const result = await suggestWikiTargets('today', 8, clock)

    expect(result.map((row) => row.target)).toEqual(['Today', '2020-01-01'])
    expect(result[0]!.path).toBe('notes/today.md')
    expect(result[1]).toMatchObject({ date: '2020-01-01', generated: { phrase: 'Today' }, path: null })
  })

  it('does not synthesise dates without a clock (legacy callers unchanged)', async () => {
    mockInvoke.mockResolvedValue([])
    await expect(suggestWikiTargets('today')).resolves.toEqual([])
  })

  it('still injects the bare daily for a full ISO query without a clock', async () => {
    mockInvoke.mockResolvedValue([])
    await expect(suggestWikiTargets('2020-01-01')).resolves.toEqual([
      { target: '2020-01-01', path: null, title: '2020-01-01', alias: null, date: '2020-01-01' },
    ])
  })

  it('excludes templates from both the title and alias candidate queries', async () => {
    mockInvoke.mockResolvedValue([])

    await suggestWikiTargets('journal')

    expect(mockInvoke).toHaveBeenCalledTimes(2)
    for (const [, args] of mockInvoke.mock.calls) {
      expect(String(args['sql'])).toContain('"kind" != ?')
      expect(args['params']).toContain('template')
    }
  })
})

describe('getOpenTasks', () => {
  it('parses task breadcrumbs and normalizes boolean note context', async () => {
    mockInvoke.mockResolvedValue([
      {
        note_path: 'notes/project.md',
        marker_offset: 12,
        raw: '[ ] ship it',
        text: 'ship it',
        breadcrumbs: '["StartupToolbox","Reflections"]',
        checked: 0,
        due_date: null,
        note_title: 'Project',
        daily_date: null,
        is_pinned: 1,
        pinned_order: 2,
        updated_at: 123,
      },
    ])

    await expect(getOpenTasks()).resolves.toEqual([
      {
        notePath: 'notes/project.md',
        markerOffset: 12,
        raw: '[ ] ship it',
        text: 'ship it',
        breadcrumbs: ['StartupToolbox', 'Reflections'],
        checked: false,
        dueDate: null,
        noteTitle: 'Project',
        dailyDate: null,
        isPinned: true,
        pinnedOrder: 2,
        updatedAt: 123,
      },
    ])
  })

  it('never surfaces template checkboxes — boilerplate, not real tasks', async () => {
    mockInvoke.mockResolvedValue([])

    await getOpenTasks()

    const [, args] = mockInvoke.mock.calls[0]!
    expect(String(args['sql'])).toContain('"notes"."kind" != ?')
    expect(args['params']).toContain('template')
  })
})
