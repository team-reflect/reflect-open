import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import { resolveExistingWikiTarget } from './resolve-existing-wiki-target'

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
      return query?.(
        String(args?.['sql'] ?? ''),
        Array.isArray(params) ? params : [],
      ) ?? []
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
        sql.includes('from "aliases"')
          ? [
              { note_path: 'notes/second.md' },
              { note_path: 'notes/first.md' },
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
        sql.includes('"title_key" = ?') ? [{ path: 'notes/project.md' }] : [],
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
        sql.includes('from "aliases"') ? [{ note_path: 'notes/project.md' }] : [],
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
        sql.includes('"daily_date" = ?') ? [{ path: 'daily/2026-06-09.md' }] : [],
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
        sql.includes('"title_key" = ?') ? [{ path: 'notes/date-title.md' }] : [],
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
        sql.includes('"title_key" = ?') ? [{ path: 'notes/date-title.md' }] : [],
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
        sql.includes('"title_key" = ?') ? [{ path: 'notes/date-title.md' }] : [],
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
        sql.includes('"title_key" = ?') ? [{ path: 'notes/date-title.md' }] : [],
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
        if (!sql.includes('"title_key" = ?')) {
          return []
        }
        titleLookups += 1
        return titleLookups === 2 ? [{ path: 'notes/newly-indexed.md' }] : []
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
    expect(invoke.mock.calls.filter(([command]) => command === 'db_query').length).toBeGreaterThan(1)
    expect(invoke).toHaveBeenCalledWith('list_files', { generation: 7 })
    expectNoWrites(invoke)
  })
})
