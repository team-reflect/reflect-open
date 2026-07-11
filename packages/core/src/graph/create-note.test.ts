import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import {
  createNoteWithTitle,
  isUntitledNotePath,
  resolveOrCreateNoteWithTitle,
  untitledNotePath,
  untitledNoteSeed,
} from './create-note'

afterEach(() => {
  setBridge(null)
})

interface BridgeBehavior {
  /** Paths the fake graph already has (indexed and on disk alike). */
  occupied?: string[]
  /** Markdown files visible to the disk-family fallback scan. */
  files?: Record<string, string>
  /** Evicted files whose title cannot currently be inspected. */
  placeholders?: string[]
  /** Optional exact control over an index query's result rows. */
  query?: (sql: string, params: unknown[]) => Array<Record<string, unknown>>
  /** Override an atomic create attempt (for collision-race tests). */
  create?: (
    path: string,
    contents: string,
  ) => { kind: 'created'; modifiedMs: number | null } | { kind: 'collision' } | undefined
}

/** A fake bridge whose atomic create records new files and never replaces one. */
function bindBridge({
  occupied = [],
  files = {},
  placeholders = [],
  query,
  create,
}: BridgeBehavior = {}): ReturnType<typeof vi.fn> {
  const taken = new Set([...occupied, ...Object.keys(files), ...placeholders])
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'db_query') {
      const sql = String(args?.['sql'] ?? '')
      const params = (args?.['params'] as unknown[]) ?? []
      if (query !== undefined) {
        return query(sql, params)
      }
      const candidate = params[0]
      return sql.includes('"path" = ?') && taken.has(String(candidate))
        ? [{ path: candidate }]
        : []
    }
    if (command === 'note_exists') {
      return taken.has(String(args?.['path']))
    }
    if (command === 'list_files') {
      return [
        ...Object.keys(files).map((path) => ({ path, size: files[path]!.length, modifiedMs: 1 })),
        ...placeholders.map((path) => ({
          path,
          size: 0,
          modifiedMs: 1,
          placeholder: true,
        })),
      ]
    }
    if (command === 'note_read') {
      const path = String(args?.['path'])
      const source = files[path]
      if (source === undefined) {
        throw { kind: 'notFound', message: `${path} not found` }
      }
      return source
    }
    if (command === 'note_create') {
      const path = String(args?.['path'])
      const contents = String(args?.['contents'])
      const overridden = create?.(path, contents)
      if (overridden !== undefined) {
        return overridden
      }
      if (taken.has(path) || files[path] !== undefined) {
        return { kind: 'collision' }
      }
      taken.add(path)
      files[path] = contents
      return { kind: 'created', modifiedMs: 1 }
    }
    return null
  })
  setBridge({ invoke, listen: async () => () => {} })
  return invoke
}

describe('createNoteWithTitle', () => {
  it('writes a slug-named note with id frontmatter and the title as H1', async () => {
    const invoke = bindBridge()

    const path = await createNoteWithTitle('  New Idea ', 7)

    expect(path).toBe('notes/new-idea.md')
    const write = invoke.mock.calls.find(([command]) => command === 'note_create')
    expect(write).toBeDefined()
    const args = write?.[1] as { path: string; contents: string; generation: number }
    expect(args.path).toBe(path)
    expect(args.generation).toBe(7)
    expect(args.contents).toMatch(/^---\nid: [0-9a-z]{26}\n---\n# New Idea\n$/)
  })

  it('drops a leading emoji from the filename slug but preserves it byte-exactly in the H1', async () => {
    const invoke = bindBridge()

    const path = await createNoteWithTitle('🧠 Business ideas', 7)

    expect(path).toBe('notes/business-ideas.md')
    const write = invoke.mock.calls.find(([command]) => command === 'note_create')
    const args = write?.[1] as { contents: string }
    expect(args.contents).toMatch(
      /^---\nid: [0-9a-z]{26}\n---\n# 🧠 Business ideas\n$/,
    )
  })

  it('suffixes the slug when the bare path is taken', async () => {
    bindBridge({ occupied: ['notes/new-idea.md'] })

    await expect(createNoteWithTitle('New Idea', 7)).resolves.toBe('notes/new-idea-2.md')
  })

  it('places an optional body block under the H1', async () => {
    const invoke = bindBridge()

    await createNoteWithTitle('Ada Lovelace', 7, '- Type: #person')

    const write = invoke.mock.calls.find(([command]) => command === 'note_create')
    const args = write?.[1] as { contents: string }
    expect(args.contents).toMatch(
      /^---\nid: [0-9a-z]{26}\n---\n# Ada Lovelace\n\n- Type: #person\n$/,
    )
  })
})

describe('resolveOrCreateNoteWithTitle', () => {
  it('uses exact index resolution before reading the slug family', async () => {
    const invoke = bindBridge({
      query: (sql, params) =>
        sql.includes('"title_key" = ?') && params[0] === 'business ideas'
          ? [{ path: 'notes/indexed.md' }]
          : [],
    })

    await expect(resolveOrCreateNoteWithTitle('Business ideas', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/indexed.md',
    })
    expect(invoke).not.toHaveBeenCalledWith('list_files', expect.anything())
    expect(invoke.mock.calls.some(([command]) => command === 'note_create')).toBe(false)
  })

  it('reuses an exact title or alias from the on-disk slug family', async () => {
    const invoke = bindBridge({
      files: {
        'notes/business-ideas.md': '# Business ideas\n',
        'notes/business-ideas-2.md': '---\naliases: [Side project]\n---\n# Incubator\n',
      },
    })

    await expect(resolveOrCreateNoteWithTitle('Business ideas', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/business-ideas.md',
    })
    expect(invoke.mock.calls.some(([command]) => command === 'note_create')).toBe(false)
  })

  it('reuses exactly one leading-emoji fallback match', async () => {
    const invoke = bindBridge({
      files: {
        'notes/business-ideas.md': '# 🧠Business ideas\n',
      },
    })

    await expect(resolveOrCreateNoteWithTitle('Business ideas', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/business-ideas.md',
    })
    expect(invoke.mock.calls.some(([command]) => command === 'note_create')).toBe(false)
  })

  it('includes parsed aliases in the fallback match', async () => {
    const invoke = bindBridge({
      files: {
        'notes/business-ideas.md':
          '---\naliases: ["🧠Business ideas"]\n---\n# Incubator\n',
      },
    })

    await expect(resolveOrCreateNoteWithTitle('Business ideas', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/business-ideas.md',
    })
    expect(invoke.mock.calls.some(([command]) => command === 'note_create')).toBe(false)
  })

  it('refuses to pick between multiple exact-title matches', async () => {
    // The historic duplicate bug's own output: two files claiming the same
    // title. Sorted-first would even prefer the `-2` dupe over the original.
    const invoke = bindBridge({
      files: {
        'notes/business-ideas.md': '# Business ideas\n',
        'notes/business-ideas-2.md': '# Business ideas\n',
      },
    })

    await expect(resolveOrCreateNoteWithTitle('Business ideas', 7)).resolves.toEqual({
      kind: 'ambiguous',
      paths: ['notes/business-ideas-2.md', 'notes/business-ideas.md'],
    })
    expect(invoke.mock.calls.some(([command]) => command === 'note_create')).toBe(false)
  })

  it('blocks creation when the fallback is ambiguous or unreadable', async () => {
    const invoke = bindBridge({
      files: {
        'notes/business-ideas.md': '# 🧠 Business ideas\n',
        'notes/business-ideas-2.md': '# 💡 Business ideas\n',
      },
      placeholders: ['notes/business-ideas-3.md'],
    })

    await expect(resolveOrCreateNoteWithTitle('Business ideas', 7)).resolves.toEqual({
      kind: 'ambiguous',
      paths: [
        'notes/business-ideas-2.md',
        'notes/business-ideas-3.md',
        'notes/business-ideas.md',
      ],
    })
    expect(invoke.mock.calls.some(([command]) => command === 'note_create')).toBe(false)
  })

  it('re-resolves after the disk scan before creating', async () => {
    let titleLookups = 0
    const invoke = bindBridge({
      query: (sql) => {
        if (!sql.includes('"title_key" = ?')) {
          return []
        }
        titleLookups += 1
        return titleLookups === 2 ? [{ path: 'notes/synced.md' }] : []
      },
    })

    await expect(resolveOrCreateNoteWithTitle('Synced', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/synced.md',
    })
    expect(titleLookups).toBe(2)
    expect(invoke.mock.calls.some(([command]) => command === 'note_create')).toBe(false)
  })

  it('re-resolves an atomic-claim collision instead of creating a suffix', async () => {
    const files: Record<string, string> = {}
    let titleLookups = 0
    const invoke = bindBridge({
      files,
      query: (sql) => {
        if (!sql.includes('"title_key" = ?')) {
          return []
        }
        titleLookups += 1
        if (titleLookups === 2) {
          files['notes/business-ideas.md'] = '# Business ideas\n'
        }
        return []
      },
    })

    await expect(resolveOrCreateNoteWithTitle('Business ideas', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/business-ideas.md',
    })
    expect(titleLookups).toBe(3)
    expect(invoke.mock.calls.filter(([command]) => command === 'list_files')).toHaveLength(2)
    expect(invoke.mock.calls.filter(([command]) => command === 'note_create')).toHaveLength(1)
    expect(files['notes/business-ideas-2.md']).toBeUndefined()
  })

  it('creates only after both index checks and the disk scan miss', async () => {
    const invoke = bindBridge()

    await expect(resolveOrCreateNoteWithTitle('Brand New', 7)).resolves.toMatchObject({
      kind: 'created',
      path: 'notes/brand-new.md',
    })
    expect(invoke.mock.calls.filter(([command]) => command === 'note_create')).toHaveLength(1)
  })
})

describe('untitledNoteSeed', () => {
  it('is an empty H1 (the caret lands there) plus a fresh id, unique per call', () => {
    const first = untitledNoteSeed()
    const second = untitledNoteSeed()
    expect(first).toMatch(/^---\nid: [0-9a-z]{26}\n---\n#\n$/)
    expect(second).not.toBe(first)
  })
})

describe('isUntitledNotePath', () => {
  it('recognizes the ULID placeholder paths untitledNotePath mints', () => {
    expect(isUntitledNotePath(untitledNotePath())).toBe(true)
  })

  it('rejects slug-named, daily, and near-miss paths', () => {
    expect(isUntitledNotePath('notes/meeting-notes.md')).toBe(false)
    expect(isUntitledNotePath('daily/2026-06-12.md')).toBe(false)
    // Right length, but `u` is outside the Crockford base32 alphabet.
    expect(isUntitledNotePath('notes/uuuuuuuuuuuuuuuuuuuuuuuuuu.md')).toBe(false)
    // A ULID-shaped name outside notes/ is not a placeholder.
    expect(isUntitledNotePath('01jxk2v9qz3m4n5p6r7s8t9vwx.md')).toBe(false)
  })
})
