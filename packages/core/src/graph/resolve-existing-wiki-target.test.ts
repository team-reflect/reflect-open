import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import {
  resolveExistingMarkdownTarget,
  resolveExistingWikiTarget,
} from './resolve-existing-wiki-target'

interface BridgeBehavior {
  readonly files?: Record<string, string>
  readonly placeholders?: readonly string[]
  readonly readErrors?: readonly string[]
  readonly query?: (sql: string, params: readonly unknown[]) => Array<Record<string, unknown>>
  readonly read?: (path: string) => Promise<string>
}

function bindBridge({
  files = {},
  placeholders = [],
  readErrors = [],
  query,
  read,
}: BridgeBehavior = {}): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'db_query') {
      const params = args?.['params']
      return query?.(String(args?.['sql'] ?? ''), Array.isArray(params) ? params : []) ?? []
    }
    if (command === 'list_files') {
      return [
        ...Object.entries(files).map(([path, source]) => ({
          path,
          size: source.length,
          modifiedMs: 1,
        })),
        ...placeholders.map((path) => ({
          path,
          size: 0,
          modifiedMs: 1,
          placeholder: true,
        })),
        ...readErrors.map((path) => ({ path, size: 1, modifiedMs: 1 })),
      ]
    }
    if (command === 'note_read') {
      const path = String(args?.['path'])
      if (read !== undefined) {
        return await read(path)
      }
      if (readErrors.includes(path)) {
        throw { kind: 'io', message: `${path} is unavailable` }
      }
      const source = files[path]
      if (source === undefined) {
        throw { kind: 'notFound', message: `${path} not found` }
      }
      return source
    }
    return null
  })
  setBridge({ invoke, listen: async () => () => {} })
  return invoke
}

function expectNoWrites(invoke: ReturnType<typeof vi.fn>): void {
  expect(
    invoke.mock.calls.some(([command]) =>
      ['note_create', 'note_write', 'note_delete', 'index_apply_batch'].includes(String(command)),
    ),
  ).toBe(false)
}

afterEach(() => {
  setBridge(null)
})

describe('resolveExistingWikiTarget', () => {
  it('returns missing for a blank target without touching the graph', async () => {
    const invoke = bindBridge()

    await expect(resolveExistingWikiTarget('   ', 7)).resolves.toEqual({ kind: 'missing' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('preserves ambiguity in the winning indexed tier', async () => {
    const invoke = bindBridge({
      query: (sql) =>
        sql.includes('note_claims')
          ? [
              { note_path: 'notes/first.md', tier: 3 },
              { note_path: 'notes/second.md', tier: 3 },
            ]
          : [],
    })

    await expect(resolveExistingWikiTarget('Project', 7)).resolves.toEqual({
      kind: 'ambiguous',
      paths: ['notes/first.md', 'notes/second.md'],
    })
    expectNoWrites(invoke)
  })

  it('resolves one indexed title without probing disk', async () => {
    const invoke = bindBridge({
      query: (sql) =>
        sql.includes('note_claims') ? [{ note_path: 'notes/project.md', tier: 2 }] : [],
    })

    await expect(resolveExistingWikiTarget('Project', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/project.md',
    })
    expect(invoke.mock.calls.some(([command]) => command === 'note_read')).toBe(false)
    expect(invoke.mock.calls.some(([command]) => command === 'list_files')).toBe(false)
    expectNoWrites(invoke)
  })

  it('resolves one indexed alias after the title tier misses', async () => {
    const invoke = bindBridge({
      query: (sql) =>
        sql.includes('note_claims') ? [{ note_path: 'notes/project.md', tier: 3 }] : [],
    })

    await expect(resolveExistingWikiTarget('Initiative', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/project.md',
    })
    expect(invoke.mock.calls.some(([command]) => command === 'note_read')).toBe(false)
    expect(invoke.mock.calls.some(([command]) => command === 'list_files')).toBe(false)
    expectNoWrites(invoke)
  })

  it('accepts an indexed daily before probing disk or lower index tiers', async () => {
    const invoke = bindBridge({
      query: (sql) =>
        sql.includes('note_claims') ? [{ note_path: 'daily/2026-06-09.md', tier: 1 }] : [],
    })

    await expect(resolveExistingWikiTarget('2026-06-09', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'daily/2026-06-09.md',
    })
    expect(invoke.mock.calls.some(([command]) => command === 'note_read')).toBe(false)
    expect(invoke.mock.calls.some(([command]) => command === 'list_files')).toBe(false)
    expectNoWrites(invoke)
  })

  it('lets an index-lagging daily file outrank an indexed regular date title', async () => {
    const invoke = bindBridge({
      files: { 'daily/2026-06-09.md': 'Daily contents\n' },
      query: (sql) =>
        sql.includes('note_claims') ? [{ note_path: 'notes/date-title.md', tier: 2 }] : [],
    })

    await expect(resolveExistingWikiTarget('2026-06-09', 17)).resolves.toEqual({
      kind: 'resolved',
      path: 'daily/2026-06-09.md',
    })
    expect(invoke).toHaveBeenCalledWith('note_read', {
      path: 'daily/2026-06-09.md',
      generation: 17,
    })
    expectNoWrites(invoke)
  })

  it('accepts an indexed regular date title only after the daily path is missing', async () => {
    const invoke = bindBridge({
      query: (sql) =>
        sql.includes('note_claims') ? [{ note_path: 'notes/date-title.md', tier: 2 }] : [],
    })

    await expect(resolveExistingWikiTarget('2026-06-09', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/date-title.md',
    })
    expect(invoke).toHaveBeenCalledWith('note_read', {
      path: 'daily/2026-06-09.md',
      generation: 7,
    })
    expectNoWrites(invoke)
  })

  it('reports an unreadable daily file as unavailable instead of accepting a lower tier', async () => {
    const invoke = bindBridge({
      query: (sql) =>
        sql.includes('note_claims') ? [{ note_path: 'notes/date-title.md', tier: 2 }] : [],
      read: async () => {
        throw { kind: 'io', message: 'evicted' }
      },
    })

    await expect(resolveExistingWikiTarget('2026-06-09', 7)).resolves.toEqual({
      kind: 'unavailable',
      paths: ['daily/2026-06-09.md'],
    })
    expectNoWrites(invoke)
  })

  it('reports an evicted daily placeholder as unavailable instead of missing', async () => {
    const invoke = bindBridge({
      placeholders: ['daily/2026-06-09.md'],
      query: (sql) =>
        sql.includes('note_claims') ? [{ note_path: 'notes/date-title.md', tier: 2 }] : [],
    })

    await expect(resolveExistingWikiTarget('2026-06-09', 7)).resolves.toEqual({
      kind: 'unavailable',
      paths: ['daily/2026-06-09.md'],
    })
    expect(invoke).toHaveBeenCalledWith('list_files', { generation: 7 })
    expectNoWrites(invoke)
  })

  it('resolves an index-lagging note from the bounded slug-family scan', async () => {
    const invoke = bindBridge({
      files: {
        'notes/business-ideas.md': '# Business ideas\n',
        'notes/unrelated.md': '# Unrelated\n',
      },
    })

    await expect(resolveExistingWikiTarget('Business ideas', 23)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/business-ideas.md',
    })
    expect(invoke).toHaveBeenCalledWith('list_files', { generation: 23 })
    expect(invoke).toHaveBeenCalledWith('note_read', {
      path: 'notes/business-ideas.md',
      generation: 23,
    })
    expect(invoke).not.toHaveBeenCalledWith('note_read', {
      path: 'notes/unrelated.md',
      generation: 23,
    })
    expectNoWrites(invoke)
  })

  it.each([
    {
      label: 'iCloud placeholder',
      behavior: { placeholders: ['notes/business-ideas.md'] },
    },
    {
      label: 'read failure',
      behavior: { readErrors: ['notes/business-ideas.md'] },
    },
  ])('reports a slug-family $label as unavailable', async ({ behavior }) => {
    const invoke = bindBridge(behavior)

    await expect(resolveExistingWikiTarget('Business ideas', 7)).resolves.toEqual({
      kind: 'unavailable',
      paths: ['notes/business-ideas.md'],
    })
    expectNoWrites(invoke)
  })

  it('keeps a listed-then-deleted slug-family candidate unavailable', async () => {
    const invoke = bindBridge({
      readErrors: ['notes/business-ideas.md'],
      read: async () => {
        throw { kind: 'notFound', message: 'vanished after listing' }
      },
    })

    await expect(resolveExistingWikiTarget('Business ideas', 7)).resolves.toEqual({
      kind: 'unavailable',
      paths: ['notes/business-ideas.md'],
    })
    expectNoWrites(invoke)
  })

  it('does not globally scan for an unindexed alias outside the target slug family', async () => {
    const invoke = bindBridge({
      files: {
        'notes/incubator.md': '---\naliases: [Business ideas]\n---\n# Incubator\n',
      },
    })

    await expect(resolveExistingWikiTarget('Business ideas', 7)).resolves.toEqual({
      kind: 'missing',
    })
    expect(invoke.mock.calls.some(([command]) => command === 'note_read')).toBe(false)
    expectNoWrites(invoke)
  })

  it('rechecks the index after a disk miss to close the indexing race', async () => {
    let titleLookups = 0
    const invoke = bindBridge({
      query: (sql) => {
        if (!sql.includes('note_claims')) {
          return []
        }
        titleLookups += 1
        return titleLookups === 2 ? [{ note_path: 'notes/newly-indexed.md', tier: 2 }] : []
      },
    })

    await expect(resolveExistingWikiTarget('Newly indexed', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/newly-indexed.md',
    })
    expect(titleLookups).toBe(2)
    expectNoWrites(invoke)
  })

  it('repeats the daily-path probe after a disk miss', async () => {
    let dailyReads = 0
    const invoke = bindBridge({
      read: async (path) => {
        if (path !== 'daily/2026-06-09.md') {
          throw { kind: 'notFound', message: 'missing' }
        }
        dailyReads += 1
        if (dailyReads === 1) {
          throw { kind: 'notFound', message: 'not synced yet' }
        }
        return 'Arrived during resolution\n'
      },
    })

    await expect(resolveExistingWikiTarget('2026-06-09', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'daily/2026-06-09.md',
    })
    expect(dailyReads).toBe(2)
    expectNoWrites(invoke)
  })

  it('returns missing after both index checks and the disk fallback miss without writing', async () => {
    const invoke = bindBridge()

    await expect(resolveExistingWikiTarget('Absent', 7)).resolves.toEqual({ kind: 'missing' })
    expect(invoke.mock.calls.filter(([command]) => command === 'db_query').length).toBeGreaterThan(
      1,
    )
    expect(invoke).toHaveBeenCalledWith('list_files', { generation: 7 })
    expectNoWrites(invoke)
  })
})

describe('resolveExistingWikiTarget — rich titles on disk', () => {
  it('resolves a rich-title note through its derived linkable alias', async () => {
    const invoke = bindBridge({
      files: { 'notes/meeting-with-ada.md': '# Meeting with [[Ada]]\n' },
    })

    await expect(resolveExistingWikiTarget('Meeting with Ada', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/meeting-with-ada.md',
    })
    expectNoWrites(invoke)
  })

  it('stays missing when the rich note lives outside the derived slug family', async () => {
    // The bounded disk scan inspects only `slugForTitle(target)`'s filename
    // family. A rich note's own family derives from its *raw* title, so a
    // derived-form lookup cannot reach it until the index projects the alias
    // row. Pinned deliberately: this is the fallback's known boundary, not a
    // full-graph alias scan.
    const invoke = bindBridge({
      files: {
        'notes/meeting-with-ada-lovelaceada.md': '# Meeting with [[Ada Lovelace|Ada]]\n',
      },
    })

    await expect(resolveExistingWikiTarget('Meeting with Ada', 7)).resolves.toEqual({
      kind: 'missing',
    })
    expectNoWrites(invoke)
  })
})

describe('resolveExistingWikiTarget — path and stem dimensions', () => {
  it('resolves a path-qualified wiki target from the index', async () => {
    const invoke = bindBridge({
      query: (sql) => (sql.includes('path_key') ? [{ path: 'Projects/Plan.md' }] : []),
    })

    await expect(resolveExistingWikiTarget('Projects/Plan', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'Projects/Plan.md',
    })
    expect(invoke.mock.calls.some(([command]) => command === 'note_read')).toBe(false)
    expectNoWrites(invoke)
  })

  it('resolves a path-qualified target from disk when the index has not caught up', async () => {
    const invoke = bindBridge({ files: { 'Projects/Plan.md': '# Weekly Planning' } })

    await expect(resolveExistingWikiTarget('Projects/Plan', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'Projects/Plan.md',
    })
    expectNoWrites(invoke)
  })

  it('never falls back to a same-named file elsewhere when a path link misses', async () => {
    const invoke = bindBridge({ files: { 'Plan.md': '# Plan' } })

    await expect(resolveExistingWikiTarget('Archive/Plan', 7)).resolves.toEqual({
      kind: 'missing',
    })
    expectNoWrites(invoke)
  })

  it('resolves a bare target by filename stem when no title or alias claims it', async () => {
    const invoke = bindBridge({
      query: (sql) =>
        sql.includes('note_claims') ? [{ note_path: 'Projects/Plan.md', tier: 4 }] : [],
    })

    await expect(resolveExistingWikiTarget('Plan', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'Projects/Plan.md',
    })
    expectNoWrites(invoke)
  })

  it('drops a fragment before looking the target up', async () => {
    const invoke = bindBridge({
      query: (sql) => (sql.includes('path_key') ? [{ path: 'Projects/Plan.md' }] : []),
    })

    await expect(resolveExistingWikiTarget('Projects/Plan#Next', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'Projects/Plan.md',
    })
    expectNoWrites(invoke)
  })

  it('resolves a fragment-only target to its source note', async () => {
    const invoke = bindBridge()

    await expect(resolveExistingWikiTarget('#Next', 7, 'Projects/Plan.md')).resolves.toEqual({
      kind: 'resolved',
      path: 'Projects/Plan.md',
    })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('treats a percent sign in a bare target as literal text', async () => {
    const invoke = bindBridge({
      query: (sql) => (sql.includes('note_claims') ? [{ note_path: 'notes/100.md', tier: 2 }] : []),
    })

    await expect(resolveExistingWikiTarget('100%', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/100.md',
    })
    expectNoWrites(invoke)
  })

  // The #806 regression point: an already-read candidate that does not match
  // must never veto the missing verdict that permits creation.
  it('reports missing when the vault has an unindexed note that does not match', async () => {
    const invoke = bindBridge({ files: { 'Projects/Plan.md': '# Plan' } })

    await expect(resolveExistingWikiTarget('Brand New Topic', 7)).resolves.toEqual({
      kind: 'missing',
    })
    expectNoWrites(invoke)
  })
})

describe('resolveExistingWikiTarget: colon and slash names', () => {
  it('resolves a colon-prefixed title through the index', async () => {
    const invoke = bindBridge({
      query: (sql) =>
        sql.includes('note_claims')
          ? [{ note_path: 'notes/test-long-with-parens-ampersand-follow-up.md', tier: 2 }]
          : [],
    })

    await expect(
      resolveExistingWikiTarget('Test: Long With Parens & Ampersand Follow-up', 7),
    ).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/test-long-with-parens-ampersand-follow-up.md',
    })
    expectNoWrites(invoke)
  })

  it('still refuses a URL-shaped target outright', async () => {
    const invoke = bindBridge()

    await expect(resolveExistingWikiTarget('https://example.com/Plan', 7)).resolves.toEqual({
      kind: 'missing',
    })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('falls back to the folded name when a slashed target names no file', async () => {
    const invoke = bindBridge({
      query: (sql) =>
        sql.includes('note_claims')
          ? [{ note_path: 'notes/johnsally-meeting-notes.md', tier: 2 }]
          : [],
    })

    await expect(resolveExistingWikiTarget('john/sally meeting notes', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/johnsally-meeting-notes.md',
    })
    expectNoWrites(invoke)
  })

  it('prefers the exact file over a note titled with the same slashed spelling', async () => {
    const invoke = bindBridge({
      query: (sql) =>
        sql.includes('path_key')
          ? [{ path: 'john/sally meeting notes.md' }]
          : sql.includes('note_claims')
            ? [{ note_path: 'notes/johnsally-meeting-notes.md', tier: 2 }]
            : [],
    })

    await expect(resolveExistingWikiTarget('john/sally meeting notes', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'john/sally meeting notes.md',
    })
    expectNoWrites(invoke)
  })

  it('keeps an unreadable exact-path match unavailable, not name-resolved', async () => {
    const invoke = bindBridge({
      readErrors: ['john/sally meeting notes.md'],
      query: (sql) =>
        sql.includes('note_claims')
          ? [{ note_path: 'notes/johnsally-meeting-notes.md', tier: 2 }]
          : [],
    })

    await expect(resolveExistingWikiTarget('john/sally meeting notes', 7)).resolves.toEqual({
      kind: 'unavailable',
      paths: ['john/sally meeting notes.md'],
    })
    expectNoWrites(invoke)
  })

  it('keeps a rooted path strict, with no name fallback', async () => {
    const invoke = bindBridge({
      query: (sql) =>
        sql.includes('note_claims') ? [{ note_path: 'notes/plan.md', tier: 2 }] : [],
    })

    await expect(resolveExistingWikiTarget('/Plan', 7)).resolves.toEqual({ kind: 'missing' })
    expectNoWrites(invoke)
  })
})

describe('resolveExistingMarkdownTarget', () => {
  it('resolves a source-relative Markdown href', async () => {
    const invoke = bindBridge({
      query: (sql) => (sql.includes('path_key') ? [{ path: 'Projects/Plan.md' }] : []),
    })

    await expect(
      resolveExistingMarkdownTarget('./Plan.md', 'Projects/Journal.md', 7),
    ).resolves.toEqual({ kind: 'resolved', path: 'Projects/Plan.md' })
    expectNoWrites(invoke)
  })

  it('reports missing for an external or unsafe href without touching the graph', async () => {
    const invoke = bindBridge()

    await expect(
      resolveExistingMarkdownTarget('https://example.com/x.md', 'Note.md', 7),
    ).resolves.toEqual({ kind: 'missing' })
    await expect(resolveExistingMarkdownTarget('../../outside.md', 'Note.md', 7)).resolves.toEqual({
      kind: 'missing',
    })
    expect(invoke).not.toHaveBeenCalled()
  })
})
