import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors.ts'
import { createWikiResolverService } from '../indexing/wiki-resolver-service.ts'
import { createTestDatabaseService, seedNotes, type TestNote } from '../testing/database.ts'
import { createTestNoteFileService } from '../testing/graph.ts'
import { createNoteLinkResolverService } from './note-link-resolver-service.ts'

interface Graph {
  /**
   * Notes projected into the index.
   */
  readonly indexed?: readonly TestNote[]
  /**
   * Files on disk.
   */
  readonly files?: Record<string, string>
  /**
   * On-disk paths listed as iCloud placeholders; reading them reports `notFound`.
   */
  readonly placeholders?: readonly string[]
  /**
   * Listed paths whose reads fail with an `io` error.
   */
  readonly readErrors?: readonly string[]
}

function setup({ indexed = [], files = {}, placeholders = [], readErrors = [] }: Graph = {}) {
  const database = createTestDatabaseService()
  seedNotes(database, indexed)
  const noteFile = createTestNoteFileService({ files, evicted: placeholders })
  for (const path of [...placeholders, ...readErrors]) {
    noteFile.set(path, '')
  }
  const readFile = noteFile.read.bind(noteFile)
  const read = vi.spyOn(noteFile, 'read').mockImplementation(async (path, generation) => {
    if (placeholders.includes(path)) {
      throw new AppError('notFound', `${path} not found`)
    }
    if (readErrors.includes(path)) {
      throw new AppError('io', `${path} is unavailable`)
    }
    return await readFile(path, generation)
  })
  const listNotes = vi.spyOn(noteFile, 'listNotes')
  const resolver = createNoteLinkResolverService({
    wikiResolver: createWikiResolverService({ database }),
    noteFile,
  })
  return {
    database,
    noteFile,
    read,
    listNotes,
    resolver,
    /**
     * How many `note_claims` lookups the resolver ran.
     */
    claimLookups: () =>
      database.getQueries().filter((query) => query.sql.includes('note_claims')).length,
    expectNoWrites: () => {
      expect(noteFile.writes()).toEqual([])
      expect(noteFile.trashed()).toEqual([])
    },
    expectUntouched: () => {
      expect(database.getQueries()).toEqual([])
      expect(read).not.toHaveBeenCalled()
      expect(listNotes).not.toHaveBeenCalled()
    },
  }
}

describe('resolveWikiTarget', () => {
  it('returns missing for a blank target without touching the graph', async () => {
    const graph = setup()

    await expect(graph.resolver.resolveWikiTarget('   ', 7)).resolves.toEqual({ kind: 'missing' })
    graph.expectUntouched()
  })

  it('preserves ambiguity in the winning indexed tier', async () => {
    const graph = setup({
      indexed: [
        { path: 'notes/first.md', markdown: '---\naliases: [Project]\n---\n# First\n' },
        { path: 'notes/second.md', markdown: '---\naliases: [Project]\n---\n# Second\n' },
      ],
    })

    await expect(graph.resolver.resolveWikiTarget('Project', 7)).resolves.toEqual({
      kind: 'ambiguous',
      paths: ['notes/first.md', 'notes/second.md'],
    })
    graph.expectNoWrites()
  })

  it('resolves one indexed title without probing disk', async () => {
    const graph = setup({ indexed: [{ path: 'notes/project.md', markdown: '# Project\n' }] })

    await expect(graph.resolver.resolveWikiTarget('Project', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/project.md',
    })
    expect(graph.read).not.toHaveBeenCalled()
    expect(graph.listNotes).not.toHaveBeenCalled()
    graph.expectNoWrites()
  })

  it('resolves one indexed alias after the title tier misses', async () => {
    const graph = setup({
      indexed: [
        { path: 'notes/project.md', markdown: '---\naliases: [Initiative]\n---\n# Project\n' },
      ],
    })

    await expect(graph.resolver.resolveWikiTarget('Initiative', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/project.md',
    })
    expect(graph.read).not.toHaveBeenCalled()
    expect(graph.listNotes).not.toHaveBeenCalled()
    graph.expectNoWrites()
  })

  it('accepts an indexed daily before probing disk or lower index tiers', async () => {
    const graph = setup({
      indexed: [
        { path: 'daily/2026-06-09.md', markdown: 'Daily contents\n' },
        { path: 'notes/date-title.md', markdown: '# 2026-06-09\n' },
      ],
    })

    await expect(graph.resolver.resolveWikiTarget('2026-06-09', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'daily/2026-06-09.md',
    })
    expect(graph.read).not.toHaveBeenCalled()
    expect(graph.listNotes).not.toHaveBeenCalled()
    graph.expectNoWrites()
  })

  it('lets an index-lagging daily file outrank an indexed regular date title', async () => {
    const graph = setup({
      indexed: [{ path: 'notes/date-title.md', markdown: '# 2026-06-09\n' }],
      files: { 'daily/2026-06-09.md': 'Daily contents\n' },
    })

    await expect(graph.resolver.resolveWikiTarget('2026-06-09', 17)).resolves.toEqual({
      kind: 'resolved',
      path: 'daily/2026-06-09.md',
    })
    expect(graph.read).toHaveBeenCalledWith('daily/2026-06-09.md', 17)
    graph.expectNoWrites()
  })

  it('accepts an indexed regular date title only after the daily path is missing', async () => {
    const graph = setup({
      indexed: [{ path: 'notes/date-title.md', markdown: '# 2026-06-09\n' }],
    })

    await expect(graph.resolver.resolveWikiTarget('2026-06-09', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/date-title.md',
    })
    expect(graph.read).toHaveBeenCalledWith('daily/2026-06-09.md', 7)
    graph.expectNoWrites()
  })

  it('reports an unreadable daily file as unavailable instead of accepting a lower tier', async () => {
    const graph = setup({
      indexed: [{ path: 'notes/date-title.md', markdown: '# 2026-06-09\n' }],
    })
    graph.read.mockRejectedValue(new AppError('io', 'evicted'))

    await expect(graph.resolver.resolveWikiTarget('2026-06-09', 7)).resolves.toEqual({
      kind: 'unavailable',
      paths: ['daily/2026-06-09.md'],
    })
    graph.expectNoWrites()
  })

  it('reports an evicted daily placeholder as unavailable instead of missing', async () => {
    const graph = setup({
      indexed: [{ path: 'notes/date-title.md', markdown: '# 2026-06-09\n' }],
      placeholders: ['daily/2026-06-09.md'],
    })

    await expect(graph.resolver.resolveWikiTarget('2026-06-09', 7)).resolves.toEqual({
      kind: 'unavailable',
      paths: ['daily/2026-06-09.md'],
    })
    expect(graph.listNotes).toHaveBeenCalledWith(7)
    graph.expectNoWrites()
  })

  it('resolves an index-lagging note from the bounded slug-family scan', async () => {
    const graph = setup({
      files: {
        'notes/business-ideas.md': '# Business ideas\n',
        'notes/unrelated.md': '# Unrelated\n',
      },
    })

    await expect(graph.resolver.resolveWikiTarget('Business ideas', 23)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/business-ideas.md',
    })
    expect(graph.listNotes).toHaveBeenCalledWith(23)
    expect(graph.read).toHaveBeenCalledWith('notes/business-ideas.md', 23)
    expect(graph.read).not.toHaveBeenCalledWith('notes/unrelated.md', 23)
    graph.expectNoWrites()
  })

  it.each([
    {
      label: 'iCloud placeholder',
      graph: { placeholders: ['notes/business-ideas.md'] },
    },
    {
      label: 'read failure',
      graph: { readErrors: ['notes/business-ideas.md'] },
    },
  ])('reports a slug-family $label as unavailable', async ({ graph: behavior }) => {
    const graph = setup(behavior)

    await expect(graph.resolver.resolveWikiTarget('Business ideas', 7)).resolves.toEqual({
      kind: 'unavailable',
      paths: ['notes/business-ideas.md'],
    })
    graph.expectNoWrites()
  })

  it('keeps a listed-then-deleted slug-family candidate unavailable', async () => {
    const graph = setup({ files: { 'notes/business-ideas.md': '# Business ideas\n' } })
    graph.read.mockRejectedValue(new AppError('notFound', 'vanished after listing'))

    await expect(graph.resolver.resolveWikiTarget('Business ideas', 7)).resolves.toEqual({
      kind: 'unavailable',
      paths: ['notes/business-ideas.md'],
    })
    graph.expectNoWrites()
  })

  it('does not globally scan for an unindexed alias outside the target slug family', async () => {
    const graph = setup({
      files: {
        'notes/incubator.md': '---\naliases: [Business ideas]\n---\n# Incubator\n',
      },
    })

    await expect(graph.resolver.resolveWikiTarget('Business ideas', 7)).resolves.toEqual({
      kind: 'missing',
    })
    expect(graph.read).not.toHaveBeenCalled()
    graph.expectNoWrites()
  })

  it('rechecks the index after a disk miss to close the indexing race', async () => {
    const graph = setup()
    graph.listNotes.mockImplementationOnce(async () => {
      seedNotes(graph.database, [{ path: 'notes/newly-indexed.md', markdown: '# Newly indexed\n' }])
      return []
    })

    await expect(graph.resolver.resolveWikiTarget('Newly indexed', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/newly-indexed.md',
    })
    expect(graph.claimLookups()).toBe(2)
    graph.expectNoWrites()
  })

  it('repeats the daily-path probe after a disk miss', async () => {
    const graph = setup()
    let dailyReads = 0
    graph.read.mockImplementation(async (path) => {
      if (path !== 'daily/2026-06-09.md') {
        throw new AppError('notFound', 'missing')
      }
      dailyReads += 1
      if (dailyReads === 1) {
        throw new AppError('notFound', 'not synced yet')
      }
      return 'Arrived during resolution\n'
    })

    await expect(graph.resolver.resolveWikiTarget('2026-06-09', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'daily/2026-06-09.md',
    })
    expect(dailyReads).toBe(2)
    graph.expectNoWrites()
  })

  it('returns missing after both index checks and the disk fallback miss without writing', async () => {
    const graph = setup()

    await expect(graph.resolver.resolveWikiTarget('Absent', 7)).resolves.toEqual({
      kind: 'missing',
    })
    expect(graph.claimLookups()).toBe(2)
    expect(graph.listNotes).toHaveBeenCalledWith(7)
    graph.expectNoWrites()
  })
})

describe('resolveWikiTarget: rich titles on disk', () => {
  it('resolves a rich-title note through its derived linkable alias', async () => {
    const graph = setup({
      files: { 'notes/meeting-with-ada.md': '# Meeting with [[Ada]]\n' },
    })

    await expect(graph.resolver.resolveWikiTarget('Meeting with Ada', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/meeting-with-ada.md',
    })
    graph.expectNoWrites()
  })

  it('stays missing when the rich note lives outside the derived slug family', async () => {
    // The bounded disk scan inspects only `slugForTitle(target)`'s filename
    // family. A rich note's own family derives from its *raw* title, so a
    // derived-form lookup cannot reach it until the index projects the alias
    // row. Pinned deliberately: this is the fallback's known boundary, not a
    // full-graph alias scan.
    const graph = setup({
      files: {
        'notes/meeting-with-ada-lovelaceada.md': '# Meeting with [[Ada Lovelace|Ada]]\n',
      },
    })

    await expect(graph.resolver.resolveWikiTarget('Meeting with Ada', 7)).resolves.toEqual({
      kind: 'missing',
    })
    graph.expectNoWrites()
  })
})

describe('resolveWikiTarget: path and stem dimensions', () => {
  it('resolves a path-qualified wiki target from the index', async () => {
    const graph = setup({ indexed: [{ path: 'Projects/Plan.md', markdown: '# Weekly Planning' }] })

    await expect(graph.resolver.resolveWikiTarget('Projects/Plan', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'Projects/Plan.md',
    })
    expect(graph.read).not.toHaveBeenCalled()
    graph.expectNoWrites()
  })

  it('resolves a path-qualified target from disk when the index has not caught up', async () => {
    const graph = setup({ files: { 'Projects/Plan.md': '# Weekly Planning' } })

    await expect(graph.resolver.resolveWikiTarget('Projects/Plan', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'Projects/Plan.md',
    })
    graph.expectNoWrites()
  })

  it('never falls back to a same-named file elsewhere when a path link misses', async () => {
    const graph = setup({ files: { 'Plan.md': '# Plan' } })

    await expect(graph.resolver.resolveWikiTarget('Archive/Plan', 7)).resolves.toEqual({
      kind: 'missing',
    })
    graph.expectNoWrites()
  })

  it('resolves a bare target by filename stem when no title or alias claims it', async () => {
    const graph = setup({ indexed: [{ path: 'Projects/Plan.md', markdown: '# Weekly Planning' }] })

    await expect(graph.resolver.resolveWikiTarget('Plan', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'Projects/Plan.md',
    })
    graph.expectNoWrites()
  })

  it('drops a fragment before looking the target up', async () => {
    const graph = setup({ indexed: [{ path: 'Projects/Plan.md', markdown: '# Weekly Planning' }] })

    await expect(graph.resolver.resolveWikiTarget('Projects/Plan#Next', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'Projects/Plan.md',
    })
    graph.expectNoWrites()
  })

  it('resolves a fragment-only target to its source note', async () => {
    const graph = setup()

    await expect(graph.resolver.resolveWikiTarget('#Next', 7, 'Projects/Plan.md')).resolves.toEqual(
      {
        kind: 'resolved',
        path: 'Projects/Plan.md',
      },
    )
    graph.expectUntouched()
  })

  it('treats a percent sign in a bare target as literal text', async () => {
    const graph = setup({ indexed: [{ path: 'notes/100.md', markdown: '# 100%\n' }] })

    await expect(graph.resolver.resolveWikiTarget('100%', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/100.md',
    })
    graph.expectNoWrites()
  })

  // The #806 regression point: an already-read candidate that does not match
  // must never veto the missing verdict that permits creation.
  it('reports missing when the vault has an unindexed note that does not match', async () => {
    const graph = setup({ files: { 'Projects/Plan.md': '# Plan' } })

    await expect(graph.resolver.resolveWikiTarget('Brand New Topic', 7)).resolves.toEqual({
      kind: 'missing',
    })
    graph.expectNoWrites()
  })
})

describe('resolveWikiTarget: colon and slash names', () => {
  it('resolves a colon-prefixed title through the index', async () => {
    const graph = setup({
      indexed: [
        {
          path: 'notes/test-long-with-parens-ampersand-follow-up.md',
          markdown: '# Test: Long With Parens & Ampersand Follow-up\n',
        },
      ],
    })

    await expect(
      graph.resolver.resolveWikiTarget('Test: Long With Parens & Ampersand Follow-up', 7),
    ).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/test-long-with-parens-ampersand-follow-up.md',
    })
    graph.expectNoWrites()
  })

  it('still refuses a URL-shaped target outright', async () => {
    const graph = setup()

    await expect(graph.resolver.resolveWikiTarget('https://example.com/Plan', 7)).resolves.toEqual({
      kind: 'missing',
    })
    graph.expectUntouched()
  })

  it('falls back to the folded name when a slashed target names no file', async () => {
    const graph = setup({
      indexed: [
        { path: 'notes/johnsally-meeting-notes.md', markdown: '# john/sally meeting notes\n' },
      ],
    })

    await expect(graph.resolver.resolveWikiTarget('john/sally meeting notes', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/johnsally-meeting-notes.md',
    })
    graph.expectNoWrites()
  })

  it('prefers the exact file over a note titled with the same slashed spelling', async () => {
    const graph = setup({
      indexed: [
        { path: 'john/sally meeting notes.md', markdown: '# Whatever\n' },
        { path: 'notes/johnsally-meeting-notes.md', markdown: '# john/sally meeting notes\n' },
      ],
    })

    await expect(graph.resolver.resolveWikiTarget('john/sally meeting notes', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'john/sally meeting notes.md',
    })
    graph.expectNoWrites()
  })

  it('keeps an unreadable exact-path match unavailable, not name-resolved', async () => {
    const graph = setup({
      indexed: [
        { path: 'notes/johnsally-meeting-notes.md', markdown: '# john/sally meeting notes\n' },
      ],
      readErrors: ['john/sally meeting notes.md'],
    })

    await expect(graph.resolver.resolveWikiTarget('john/sally meeting notes', 7)).resolves.toEqual({
      kind: 'unavailable',
      paths: ['john/sally meeting notes.md'],
    })
    graph.expectNoWrites()
  })

  it('keeps a rooted path strict, with no name fallback', async () => {
    const graph = setup({ indexed: [{ path: 'notes/plan.md', markdown: '# Plan\n' }] })

    await expect(graph.resolver.resolveWikiTarget('/Plan', 7)).resolves.toEqual({
      kind: 'missing',
    })
    graph.expectNoWrites()
  })
})

describe('resolveMarkdownHref', () => {
  it('resolves a source-relative Markdown href', async () => {
    const graph = setup({ indexed: [{ path: 'Projects/Plan.md', markdown: '# Plan\n' }] })

    await expect(
      graph.resolver.resolveMarkdownHref('Projects/Journal.md', './Plan.md', 7),
    ).resolves.toEqual({ kind: 'resolved', path: 'Projects/Plan.md' })
    graph.expectNoWrites()
  })

  it('reports missing for an external or unsafe href without touching the graph', async () => {
    const graph = setup()

    await expect(
      graph.resolver.resolveMarkdownHref('Note.md', 'https://example.com/x.md', 7),
    ).resolves.toEqual({ kind: 'missing' })
    await expect(
      graph.resolver.resolveMarkdownHref('Note.md', '../../outside.md', 7),
    ).resolves.toEqual({ kind: 'missing' })
    graph.expectUntouched()
  })
})
