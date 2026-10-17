import { describe, expect, it } from 'vitest'
import {
  createTestDatabaseService,
  seedNotes,
  type TestDatabaseService,
  type TestNote,
} from '../testing/database.ts'
import { parseSearchQuery } from './filter-query.ts'
import { createSearchService, type SearchService } from './search-service.ts'
import { createWikiResolverService } from './wiki-resolver-service.ts'

function startOfLocalDay(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year!, month! - 1, day).getTime()
}

function setup(notes: readonly TestNote[]): {
  database: TestDatabaseService
  search: SearchService
} {
  const database = createTestDatabaseService()
  seedNotes(database, notes)
  const wikiResolver = createWikiResolverService({ database })
  return { database, search: createSearchService({ database, wikiResolver }) }
}

async function searchPaths(
  notes: readonly TestNote[],
  query: string,
  options?: Parameters<SearchService['searchWithFilters']>[1],
): Promise<string[]> {
  const hits = await setup(notes).search.searchWithFilters(parseSearchQuery(query), options)
  return hits.map((hit) => hit.path)
}

describe('searchWithFilters', () => {
  it('starts tag-only recall searches from the folded tag key', async () => {
    const { search } = setup([
      { path: 'notes/work.md', markdown: '# Work\nWeekly agenda. #work\n', mtime: 2000 },
      { path: 'notes/home.md', markdown: '# Home\nChores. #home\n', mtime: 3000 },
      { path: 'templates/work.md', markdown: '# Work template\n#Work\n', mtime: 4000 },
    ])

    await expect(search.searchWithFilters(parseSearchQuery('#Work'))).resolves.toEqual([
      {
        path: 'notes/work.md',
        title: 'Work',
        highlightedTitle: 'Work',
        dailyDate: null,
        snippet: null,
        preview: 'Weekly agenda. #work',
        mtime: 2000,
        isPinned: false,
      },
    ])
  })

  it('requires every additional tag filter', async () => {
    const paths = await searchPaths(
      [
        { path: 'notes/work.md', markdown: '# Work\n#Work\n' },
        { path: 'notes/both.md', markdown: '# Both\n#work #HOME\n' },
        { path: 'notes/home.md', markdown: '# Home\n#home\n' },
      ],
      '#Work #Home',
    )

    expect(paths).toEqual(['notes/both.md'])
  })

  it('applies non-tag filters on the tag-first recall path', async () => {
    const { search } = setup([
      {
        path: 'daily/2026-01-02.md',
        markdown: '---\npinned: true\n---\nStandup notes. #work\n',
        mtime: startOfLocalDay('2026-01-02'),
      },
      {
        path: 'daily/2025-12-30.md',
        markdown: '---\npinned: true\n---\nOld standup. #work\n',
        mtime: startOfLocalDay('2025-12-30'),
      },
      {
        path: 'daily/2026-01-03.md',
        markdown: 'Unpinned. #work\n',
        mtime: startOfLocalDay('2026-01-03'),
      },
      {
        path: 'notes/pinned.md',
        markdown: '---\npinned: true\n---\n# Pinned\n#work\n',
        mtime: startOfLocalDay('2026-01-03'),
      },
    ])

    const hits = await search.searchWithFilters(
      parseSearchQuery('#Work is:daily is:pinned updated:>2026-01-01'),
    )

    expect(hits).toEqual([
      {
        path: 'daily/2026-01-02.md',
        title: '2026-01-02',
        highlightedTitle: '2026-01-02',
        dailyDate: '2026-01-02',
        snippet: null,
        preview: 'Standup notes. #work',
        mtime: startOfLocalDay('2026-01-02'),
        isPinned: true,
      },
    ])
  })

  it('ranks exact, then prefix title matches ahead of body hits on text search', async () => {
    const { search } = setup([
      { path: 'notes/body.md', markdown: '# Animals\nA quokka lives here.\n', mtime: 9000 },
      { path: 'notes/habitat.md', markdown: '# Quokka Habitat\nIslands.\n', mtime: 8000 },
      { path: 'notes/quokka.md', markdown: '# Quokka\nQuokka facts.\n', mtime: 3000 },
      { path: 'notes/other.md', markdown: '# Other\nNothing here.\n', mtime: 9500 },
    ])

    const hits = await search.searchWithFilters(parseSearchQuery('quokka'))

    expect(hits.map((hit) => hit.path)).toEqual([
      'notes/quokka.md',
      'notes/habitat.md',
      'notes/body.md',
    ])
    expect(hits[0]).toMatchObject({
      title: 'Quokka',
      highlightedTitle: '\u{1}Quokka\u{2}',
      preview: 'Quokka facts.',
      isPinned: false,
    })
    expect(hits[2]!.highlightedTitle).toBe('Animals')
    expect(hits[2]!.snippet).toContain('\u{1}quokka\u{2}')
  })

  it('breaks ties between equal title matches by pinning, then recency', async () => {
    const paths = await searchPaths(
      [
        { path: 'notes/new.md', markdown: '# Plan new\n', mtime: 3000 },
        { path: 'notes/old.md', markdown: '# Plan old\n', mtime: 1000 },
        { path: 'notes/pinned.md', markdown: '---\npinned: true\n---\n# Plan pinned\n', mtime: 0 },
      ],
      'plan',
    )

    expect(paths).toEqual(['notes/pinned.md', 'notes/new.md', 'notes/old.md'])
  })

  it('shows a `//` title by its first segment on the recall feeds', async () => {
    const { search } = setup([
      {
        path: 'notes/tim-maccaw-dad.md',
        markdown: '---\npinned: true\n---\n# Tim MacCaw // Dad\n#Family\n',
      },
    ])

    const [recall] = await search.searchWithFilters(parseSearchQuery('is:pinned'))
    const [tagged] = await search.searchWithFilters(parseSearchQuery('#Family'))

    expect(recall).toMatchObject({ title: 'Tim MacCaw // Dad', highlightedTitle: 'Tim MacCaw' })
    expect(tagged).toMatchObject({ title: 'Tim MacCaw // Dad', highlightedTitle: 'Tim MacCaw' })
  })

  it('highlights the first segment of a `//` title on text search', async () => {
    const { search } = setup([
      { path: 'notes/tim-maccaw-dad.md', markdown: '# Tim MacCaw // Dad\n' },
    ])

    const [hit] = await search.searchWithFilters(parseSearchQuery('tim'))

    expect(hit).toMatchObject({
      title: 'Tim MacCaw // Dad',
      highlightedTitle: '\u{1}Tim\u{2} MacCaw',
    })
  })

  it('shows a `//` title plain when only an alias segment matched', async () => {
    const { search } = setup([
      { path: 'notes/tim-maccaw-dad.md', markdown: '# Tim MacCaw // Dad\n' },
    ])

    const [hit] = await search.searchWithFilters(parseSearchQuery('dad'))

    expect(hit).toMatchObject({ title: 'Tim MacCaw // Dad', highlightedTitle: 'Tim MacCaw' })
  })

  it('keeps a tokenizer-only FTS highlight inside the first segment of a `//` title', async () => {
    const { search } = setup([{ path: 'notes/cafe.md', markdown: '# Café // Alias\n' }])

    const [hit] = await search.searchWithFilters(parseSearchQuery('cafe'))

    expect(hit).toMatchObject({ title: 'Café // Alias', highlightedTitle: '\u{1}Café\u{2}' })
  })

  it('folds the exact-title key the way titles were indexed', async () => {
    const paths = await searchPaths(
      [
        { path: 'notes/notes.md', markdown: '# Quokka Habitat Notes\n', mtime: 2000 },
        { path: 'notes/exact.md', markdown: '# quokka habitat\n', mtime: 1000 },
      ],
      'Quokka Habitat',
    )

    expect(paths).toEqual(['notes/exact.md', 'notes/notes.md'])
  })

  it('caps the recall feed at 12 by default and leaves it uncapped when limit is null', async () => {
    const notes = Array.from({ length: 13 }, (_, index) => ({
      path: `notes/pin-${index}.md`,
      markdown: `---\npinned: true\n---\n# Pin ${index}\n`,
    }))

    await expect(searchPaths(notes, 'is:pinned')).resolves.toHaveLength(12)
    await expect(searchPaths(notes, 'is:pinned', { limit: null })).resolves.toHaveLength(13)
  })

  it('orders the recall feed by recency, or pinned-first when asked (the All list order)', async () => {
    const notes: TestNote[] = [
      { path: 'daily/2026-01-01.md', markdown: 'Oldest\n', mtime: 1000 },
      { path: 'daily/2026-01-02.md', markdown: '---\npinned: true\n---\nBare pin\n', mtime: 2000 },
      { path: 'daily/2026-01-03.md', markdown: 'Newest\n', mtime: 3000 },
      { path: 'daily/2026-01-04.md', markdown: '---\npinned: 0\n---\nFirst pin\n', mtime: 500 },
      { path: 'notes/note.md', markdown: '# Not a daily\n', mtime: 9000 },
    ]

    await expect(searchPaths(notes, 'is:daily', { limit: null })).resolves.toEqual([
      'daily/2026-01-03.md',
      'daily/2026-01-02.md',
      'daily/2026-01-01.md',
      'daily/2026-01-04.md',
    ])
    await expect(
      searchPaths(notes, 'is:daily', { limit: null, pinnedFirst: true }),
    ).resolves.toEqual([
      'daily/2026-01-04.md',
      'daily/2026-01-02.md',
      'daily/2026-01-03.md',
      'daily/2026-01-01.md',
    ])
  })

  it('orders the tag-first recall path pinned-first when asked', async () => {
    const paths = await searchPaths(
      [
        { path: 'notes/new.md', markdown: '# New\n#work\n', mtime: 3000 },
        {
          path: 'notes/pinned.md',
          markdown: '---\npinned: true\n---\n# Pinned\n#work\n',
          mtime: 1,
        },
      ],
      '#Work',
      { limit: null, pinnedFirst: true },
    )

    expect(paths).toEqual(['notes/pinned.md', 'notes/new.md'])
  })

  const LINKED: TestNote[] = [
    { path: 'notes/alpha-1.md', markdown: '# Alpha\n' },
    { path: 'notes/alpha-2.md', markdown: '# Alpha\n' },
    { path: 'notes/hub.md', markdown: '# Hub\n[[Alpha]] and [[notes/beta]]\n#work\n' },
    { path: 'notes/hub-2.md', markdown: '# Hub 2\n[[notes/alpha-2]]\n#work\n' },
    { path: 'notes/beta.md', markdown: '# Beta\n#work\n' },
  ]

  it('resolves links: tokens by title before filtering', async () => {
    await expect(searchPaths(LINKED, 'links:Alpha')).resolves.toEqual(['notes/hub.md'])
  })

  it('matches nothing when a link token does not resolve', async () => {
    await expect(searchPaths(LINKED, 'links:Missing')).resolves.toEqual([])
    await expect(searchPaths(LINKED, 'linked-from:Missing')).resolves.toEqual([])
  })

  it('filters by a picker-exact link target without resolving titles', async () => {
    const { database, search } = setup(LINKED)
    const parsed = parseSearchQuery('')
    parsed.filters.linksToPath = 'notes/alpha-2.md'

    const hits = await search.searchWithFilters(parsed)

    expect(hits.map((hit) => hit.path)).toEqual(['notes/hub-2.md'])
    expect(database.getQueries()).toHaveLength(1)
  })

  it('filters by a picker-exact link source without resolving titles', async () => {
    const { database, search } = setup(LINKED)
    const parsed = parseSearchQuery('')
    parsed.filters.linkedFromPath = 'notes/hub.md'

    const hits = await search.searchWithFilters(parsed)

    expect(hits.map((hit) => hit.path).toSorted()).toEqual(['notes/alpha-1.md', 'notes/beta.md'])
    expect(database.getQueries()).toHaveLength(1)
  })

  it('lets an exact path win over a title target (duplicate titles cannot retarget)', async () => {
    const { database, search } = setup(LINKED)
    const parsed = parseSearchQuery('links:Alpha')
    parsed.filters.linksToPath = 'notes/alpha-2.md'

    const hits = await search.searchWithFilters(parsed)

    expect(hits.map((hit) => hit.path)).toEqual(['notes/hub-2.md'])
    expect(database.getQueries()).toHaveLength(1)
  })

  it('applies picker-exact link targets on the tag-first recall path', async () => {
    const { search } = setup(LINKED)
    const parsed = parseSearchQuery('#Work')
    parsed.filters.linkedFromPath = 'notes/hub.md'

    const hits = await search.searchWithFilters(parsed)

    expect(hits.map((hit) => hit.path)).toEqual(['notes/beta.md'])
  })

  it('restricts the population to regular notes with notesOnly', async () => {
    const notes: TestNote[] = [
      { path: 'notes/pinned.md', markdown: '---\npinned: true\n---\n# Pinned\n', mtime: 1 },
      { path: 'daily/2026-01-01.md', markdown: '---\npinned: true\n---\nDay\n', mtime: 2 },
    ]

    await expect(
      searchPaths(notes, 'is:pinned', { limit: null, notesOnly: true }),
    ).resolves.toEqual(['notes/pinned.md'])
  })

  it('lets an explicit daily filter win over notesOnly', async () => {
    const notes: TestNote[] = [
      { path: 'notes/note.md', markdown: '# Note\n', mtime: 1 },
      { path: 'daily/2026-01-01.md', markdown: 'Day\n', mtime: 2 },
    ]

    await expect(searchPaths(notes, 'is:daily', { limit: null, notesOnly: true })).resolves.toEqual(
      ['daily/2026-01-01.md'],
    )
  })
})
