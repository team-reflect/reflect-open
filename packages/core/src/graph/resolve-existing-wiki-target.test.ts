import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import {
  resolveExistingMarkdownTarget,
  resolveExistingWikiTarget,
} from './resolve-existing-wiki-target'

interface IndexedFact {
  readonly path: string
  readonly mtime: number
}

interface BridgeBehavior {
  readonly files?: Record<string, string>
  readonly modifiedMs?: Record<string, number>
  readonly placeholders?: readonly string[]
  readonly readErrors?: readonly string[]
  readonly indexed?: readonly IndexedFact[]
  readonly query?: (sql: string, params: readonly unknown[]) => Array<Record<string, unknown>>
}

function bindBridge({
  files = {},
  modifiedMs = {},
  placeholders = [],
  readErrors = [],
  indexed = [],
  query,
}: BridgeBehavior = {}): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'db_query') {
      const sql = String(args?.['sql'] ?? '')
      const params = Array.isArray(args?.['params']) ? args['params'] : []
      if (sql.includes('"file_hash"') && sql.includes('"mtime"')) {
        return indexed.map((row) => ({
          path: row.path,
          file_hash: `hash:${row.path}`,
          mtime: row.mtime,
        }))
      }
      return query?.(sql, params) ?? []
    }
    if (command === 'list_files') {
      return [
        ...Object.entries(files).map(([path, source]) => ({
          path,
          size: source.length,
          modifiedMs: modifiedMs[path] ?? 1,
        })),
        ...readErrors.map((path) => ({ path, size: 1, modifiedMs: modifiedMs[path] ?? 1 })),
        ...placeholders.map((path) => ({
          path,
          size: 0,
          modifiedMs: modifiedMs[path] ?? 1,
          placeholder: true,
        })),
      ]
    }
    if (command === 'note_read') {
      const path = String(args?.['path'])
      if (readErrors.includes(path)) {
        throw { kind: 'io', message: `${path} unavailable` }
      }
      const source = files[path]
      if (source === undefined) {
        throw { kind: 'notFound', message: `${path} missing` }
      }
      return source
    }
    return null
  })
  setBridge({ invoke, listen: async () => () => {} })
  return invoke
}

function pathRow(path: string): Record<string, unknown> {
  return { path }
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

  it('uses date, authored title, alias, then basename precedence', async () => {
    bindBridge({
      files: {
        'daily/2026-06-09.md': 'Daily',
        'Notes/title.md': '# Project',
        'Notes/alias.md': '---\naliases: [Project]\n---\n# Other',
        'Archive/project.md': 'No authored title',
      },
      indexed: [
        { path: 'daily/2026-06-09.md', mtime: 1 },
        { path: 'Notes/title.md', mtime: 1 },
        { path: 'Notes/alias.md', mtime: 1 },
        { path: 'Archive/project.md', mtime: 1 },
      ],
      query: (sql) => {
        if (sql.includes('"authored_title_key"')) return [pathRow('Notes/title.md')]
        if (sql.includes('from "aliases"')) return [{ note_path: 'Notes/alias.md' }]
        if (sql.includes('"basename_key"')) return [pathRow('Archive/project.md')]
        return []
      },
    })

    await expect(resolveExistingWikiTarget('Project', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'Notes/title.md',
    })
  })

  it('uses a unique indexed leading-emoji title only after normal tiers miss', async () => {
    bindBridge({
      files: { 'notes/business-ideas.md': '# 🧠 Business ideas' },
      indexed: [{ path: 'notes/business-ideas.md', mtime: 1 }],
      query: (sql) =>
        sql.includes('"authored_title_key" is not null')
          ? [{ path: 'notes/business-ideas.md', title: '🧠 Business ideas' }]
          : [],
    })

    await expect(resolveExistingWikiTarget('Business ideas', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/business-ideas.md',
    })
  })

  it('keeps basename precedence above the leading-emoji compatibility fallback', async () => {
    const invoke = bindBridge({
      files: {
        'Archive/Business ideas.md': 'No authored title',
        'notes/business-ideas.md': '# 🧠 Business ideas',
      },
      indexed: [
        { path: 'Archive/Business ideas.md', mtime: 1 },
        { path: 'notes/business-ideas.md', mtime: 1 },
      ],
      query: (sql) =>
        sql.includes('"basename_key" = ?')
          ? [pathRow('Archive/Business ideas.md')]
          : sql.includes('"authored_title_key" is not null')
            ? [{ path: 'notes/business-ideas.md', title: '🧠 Business ideas' }]
            : [],
    })

    await expect(resolveExistingWikiTarget('Business ideas', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'Archive/Business ideas.md',
    })
    expect(
      invoke.mock.calls.some(([, args]) =>
        String(args?.['sql']).includes('"authored_title_key" is not null'),
      ),
    ).toBe(false)
  })

  it('does not choose between multiple indexed leading-emoji fallback titles', async () => {
    bindBridge({
      files: {
        'A/ideas.md': '# 🧠 Business ideas',
        'B/ideas.md': '# 💡 Business ideas',
      },
      indexed: [{ path: 'A/ideas.md', mtime: 1 }, { path: 'B/ideas.md', mtime: 1 }],
      query: (sql) =>
        sql.includes('"authored_title_key" is not null')
          ? [
              { path: 'A/ideas.md', title: '🧠 Business ideas' },
              { path: 'B/ideas.md', title: '💡 Business ideas' },
            ]
          : [],
    })

    await expect(resolveExistingWikiTarget('Business ideas', 7)).resolves.toEqual({
      kind: 'ambiguous',
      paths: ['A/ideas.md', 'B/ideas.md'],
    })
  })

  it('uses an indexed leading-emoji alias when every higher tier misses', async () => {
    bindBridge({
      files: {
        'notes/incubator.md': '---\naliases: ["🧠 Business ideas"]\n---\n# Incubator',
      },
      indexed: [{ path: 'notes/incubator.md', mtime: 1 }],
      query: (sql) =>
        sql.includes('from "aliases"') && !sql.includes('"alias_key" = ?')
          ? [{ note_path: 'notes/incubator.md', alias: '🧠 Business ideas' }]
          : [],
    })

    await expect(resolveExistingWikiTarget('Business ideas', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/incubator.md',
    })
  })

  it('preserves duplicate matches within the winning tier', async () => {
    bindBridge({
      files: { 'A/plan.md': '# Plan', 'B/plan.md': '# Plan' },
      indexed: [{ path: 'A/plan.md', mtime: 1 }, { path: 'B/plan.md', mtime: 1 }],
      query: (sql) =>
        sql.includes('"authored_title_key"')
          ? [pathRow('B/plan.md'), pathRow('A/plan.md')]
          : [],
    })

    await expect(resolveExistingWikiTarget('Plan', 7)).resolves.toEqual({
      kind: 'ambiguous',
      paths: ['A/plan.md', 'B/plan.md'],
    })
  })

  it('resolves path-qualified wiki links from the vault root with fragments', async () => {
    bindBridge({
      files: { 'Projects/Plan.md': '# Plan\n\n## Next' },
      indexed: [{ path: 'Projects/Plan.md', mtime: 1 }],
      query: (sql, params) =>
        sql.includes('"path_key" in') && params.includes('projects/plan.md')
          ? [pathRow('Projects/Plan.md')]
          : [],
    })

    await expect(
      resolveExistingWikiTarget('Projects/Plan#Next', 7, 'Inbox/Today.md'),
    ).resolves.toEqual({ kind: 'resolved', path: 'Projects/Plan.md', fragment: 'Next' })
  })

  it('resolves a same-note heading target', async () => {
    bindBridge({
      files: { 'Projects/Plan.md': '# Plan\n\n## Next' },
      indexed: [{ path: 'Projects/Plan.md', mtime: 1 }],
      query: (sql) => sql.includes('"path_key" in') ? [pathRow('Projects/Plan.md')] : [],
    })

    await expect(resolveExistingWikiTarget('#Next', 7, 'Projects/Plan.md')).resolves.toEqual({
      kind: 'resolved',
      path: 'Projects/Plan.md',
      fragment: 'Next',
    })
  })

  it('parses only manifest/index delta candidates to close index lag', async () => {
    const invoke = bindBridge({
      files: {
        'Imported/idea.md': '# Business idea',
        'Indexed/steady.md': '# Steady',
      },
      indexed: [{ path: 'Indexed/steady.md', mtime: 1 }],
    })

    await expect(resolveExistingWikiTarget('Business idea', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'Imported/idea.md',
    })
    expect(invoke).toHaveBeenCalledWith('note_read', {
      path: 'Imported/idea.md',
      generation: 7,
    })
    expect(invoke).not.toHaveBeenCalledWith('note_read', {
      path: 'Indexed/steady.md',
      generation: 7,
    })
  })

  it('fails closed instead of creating while an unrelated delta is unsettled', async () => {
    bindBridge({ files: { 'Imported/unrelated.md': '# Unrelated' } })

    await expect(resolveExistingWikiTarget('Missing', 7)).resolves.toEqual({
      kind: 'unavailable',
      paths: ['Imported/unrelated.md'],
    })
  })

  it('fails closed for an unreadable candidate or unindexed placeholder', async () => {
    bindBridge({ readErrors: ['Imported/locked.md'] })
    await expect(resolveExistingWikiTarget('Missing', 7)).resolves.toEqual({
      kind: 'unavailable',
      paths: ['Imported/locked.md'],
    })

    bindBridge({ placeholders: ['Cloud/evicted.md'] })
    await expect(resolveExistingWikiTarget('Missing', 7)).resolves.toEqual({
      kind: 'unavailable',
      paths: ['Cloud/evicted.md'],
    })
  })

  it('returns missing only after a settled manifest and index both miss', async () => {
    bindBridge()
    await expect(resolveExistingWikiTarget('Absent', 7)).resolves.toEqual({ kind: 'missing' })
  })

  it('rejects hidden and escaping wiki targets', async () => {
    bindBridge()
    await expect(resolveExistingWikiTarget('../outside', 7)).resolves.toEqual({ kind: 'invalid' })
    await expect(resolveExistingWikiTarget('.obsidian/secret', 7)).resolves.toEqual({ kind: 'invalid' })
  })
})

describe('resolveExistingMarkdownTarget', () => {
  it('honors explicit relative paths', async () => {
    bindBridge({
      files: { 'People/Ada.md': '# Ada' },
      indexed: [{ path: 'People/Ada.md', mtime: 1 }],
      query: (sql) => sql.includes('"path_key" in') ? [pathRow('People/Ada.md')] : [],
    })

    await expect(
      resolveExistingMarkdownTarget('../People/Ada.md#Bio', 'Projects/Plan.md', 7),
    ).resolves.toEqual({ kind: 'resolved', path: 'People/Ada.md', fragment: 'Bio' })
  })

  it('reports an unqualified root/source collision as ambiguous', async () => {
    bindBridge({
      files: { 'Projects/Plan.md': '# Nested', 'Plan.md': '# Root' },
      indexed: [{ path: 'Projects/Plan.md', mtime: 1 }, { path: 'Plan.md', mtime: 1 }],
      query: (sql) =>
        sql.includes('"path_key" in')
          ? [pathRow('Projects/Plan.md'), pathRow('Plan.md')]
          : [],
    })

    await expect(resolveExistingMarkdownTarget('Plan.md', 'Projects/Today.md', 7)).resolves.toEqual({
      kind: 'ambiguous',
      paths: ['Plan.md', 'Projects/Plan.md'],
    })
  })
})
