import { describe, expect, it } from 'vitest'
import {
  buildIndexedNote,
  createDailyNoteService,
  createDatabaseService,
  createIpcBridgeService,
  createSearchService,
  createSuggestionService,
  createWikiResolverService,
  parseHighlights,
  parseNote,
  parseSearchQuery,
  type DailyNoteService,
  type IndexedNote,
  type SearchService,
  type SuggestionService,
  type WikiResolverService,
} from '@reflect/core'
import {
  createTestClockService,
  createTestActivityPort,
  createTestLoggerService,
} from '@reflect/core/testing'
import type { TestDatabaseService } from '@reflect/core/testing'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { buildAllNotesSearch, EMPTY_ALL_NOTES_FILTERS, searchPlanFor } from '@reflect/app'
import { noop } from '@ocavue/utils'

function sampleNote(overrides: Partial<IndexedNote> = {}): IndexedNote {
  return {
    path: 'notes/sample.md',
    id: '01hv3xq7c2dm8k4t9w5e6r1n99',
    title: 'Sample Note',
    titleKey: 'sample note',
    pathKey: 'notes/sample.md',
    kind: 'note',
    dailyDate: null,
    isPrivate: false,
    isPinned: false,
    pinnedOrder: null,
    hasContent: true,
    gistUrl: null,
    gistStale: false,
    fileHash: 'hash-1',
    mtime: 1_700_000_000_000,
    text: 'Sample Note body about local-first sync',
    assetText: '',
    preview: 'body about local-first sync',
    links: [
      {
        kind: 'wiki',
        targetRaw: 'Other Note',
        targetKey: 'other note',
        targetPathKey: null,
        alias: null,
        posFrom: 3,
        posTo: 16,
      },
    ],
    tags: [{ tag: 'book', tagKey: 'book' }],
    aliases: [],
    claims: [
      { key: 'sample note', tier: 2 },
      { key: 'sample', tier: 4 },
    ],
    emails: [{ email: 'Sample@Example.com', emailKey: 'sample@example.com' }],
    assets: [],
    tasks: [
      {
        astPath: '[1,0]',
        markdown: 'Do the thing',
        breadcrumbs: ['Project'],
        checked: false,
        dueDate: null,
      },
    ],
    ...overrides,
  }
}

async function searchTitles(
  index: IndexServices,
  query: string,
): Promise<{ path: string; title: string }[]> {
  const hits = await index.search.searchWithFilters(parseSearchQuery(query))
  return hits.map(({ path, title }) => ({ path, title }))
}

function openDb(): TestDatabaseService {
  return createWasmTestDatabaseService()
}

interface CapturedQuery {
  readonly sql: string
  readonly params: readonly unknown[]
}

interface IndexServices {
  readonly search: SearchService
  readonly dailyNotes: DailyNoteService
  readonly wikiResolver: WikiResolverService
  readonly suggestions: SuggestionService
}

/**
 * The index read services over a transport that answers `db_query` from `db`.
 */
function connectIndex(db: TestDatabaseService, captured: CapturedQuery[] = []): IndexServices {
  const ipc = createIpcBridgeService({
    transport: {
      invoke: (command, args) => {
        return Promise.try(() => {
          if (command !== 'db_query') {
            throw new Error(`Unexpected command: ${command}`)
          }
          const sql = String(args['sql'])
          const params = (args['params'] as readonly unknown[]) ?? []
          captured.push({ sql, params })
          return db.invoke('db_query', { sql, params })
        })
      },
      listen: () => Promise.resolve(noop),
    },
    logger: createTestLoggerService(),
  })
  const database = createDatabaseService({ ipc })
  const wikiResolver = createWikiResolverService({ database })
  const clock = createTestClockService()
  return {
    search: createSearchService({ database, wikiResolver }),
    dailyNotes: createDailyNoteService({
      database,
      clock,
      activity: createTestActivityPort(),
    }),
    wikiResolver,
    suggestions: createSuggestionService({ database }),
  }
}

describe('the index read services', () => {
  it('marks only the calendar days whose daily note has content', async () => {
    const db = openDb()
    for (const [path, source] of [
      ['daily/2026-06-01.md', 'Bought milk\n'],
      ['daily/2026-06-02.md', '\n'],
      ['daily/2026-06-03.md', '+ [ ] \n'],
      ['daily/2026-06-04.md', '![](assets/beach.png)\n'],
    ] as const) {
      db.applyProjection(
        buildIndexedNote(parseNote({ path, source }), {
          fileHash: `hash-${path}`,
          mtime: 1_700_000_000_000,
          source,
        }),
      )
    }
    const index = connectIndex(db)

    await expect(index.dailyNotes.dailyDatesInRange('2026-06-01', '2026-06-30')).resolves.toEqual([
      '2026-06-01',
      '2026-06-04',
    ])
  })

  it('finds a note by a URL it links to', async () => {
    const db = openDb()
    const path = 'notes/field-jacket-hunter.md'
    const source =
      '# Field Jacket Hunter\n\n' +
      '[Field Jacket Hunter](https://www.alfredorifugio.com/products/field-jacket-hunter?utm_source=Meta)\n'
    db.applyProjection(
      buildIndexedNote(parseNote({ path, source }), {
        fileHash: 'field-jacket-hunter-hash',
        mtime: 1_700_000_000_000,
        source,
      }),
    )
    const index = connectIndex(db)

    await expect(searchTitles(index, 'alfredorifugio')).resolves.toEqual([
      { path, title: 'Field Jacket Hunter' },
    ])
  })

  it('finds a short Japanese term inside a title as well as a note body', async () => {
    const db = openDb()
    db.applyProjection(
      sampleNote({
        path: 'notes/tokyo-trip.md',
        id: '01hv3xq7c2dm8k4t9w5e6r1n91',
        title: '来週の東京旅行計画',
        titleKey: '来週の東京旅行計画',
        isPinned: false,
        text: 'An otherwise unrelated body.',
        preview: 'An otherwise unrelated body.',
        mtime: 100,
      }),
    )
    db.applyProjection(
      sampleNote({
        path: 'notes/body-hit.md',
        id: '01hv3xq7c2dm8k4t9w5e6r1n92',
        title: '別のノート',
        titleKey: '別のノート',
        isPinned: true,
        text: 'An otherwise unrelated 東京 body token.',
        preview: 'An otherwise unrelated 東京 body token.',
        mtime: 200,
      }),
    )
    const captured: CapturedQuery[] = []
    const index = connectIndex(db, captured)

    const hits = await index.search.searchWithFilters(parseSearchQuery('東京'))

    expect(hits.map((hit) => hit.path)).toEqual(['notes/tokyo-trip.md', 'notes/body-hit.md'])
    expect(parseHighlights(hits[0]!.highlightedTitle)).toEqual([
      { text: '来週の', highlighted: false },
      { text: '東京', highlighted: true },
      { text: '旅行計画', highlighted: false },
    ])
    expect(hits[1]!.highlightedTitle).toBe('別のノート')
    expect(hits[0]!.snippet).toBeNull()
    expect(hits[1]!.snippet).toContain('東京')
    const plan = db.invoke('db_query', {
      sql: `EXPLAIN QUERY PLAN ${captured[0]!.sql}`,
      params: captured[0]!.params,
    }) as Record<string, unknown>[]
    expect(plan.some((row) => String(row['detail']).includes('MATERIALIZE lexical'))).toBe(true)
    await expect(searchTitles(index, '東京')).resolves.toEqual([
      { path: 'notes/tokyo-trip.md', title: '来週の東京旅行計画' },
      { path: 'notes/body-hit.md', title: '別のノート' },
    ])
    const multiTermHits = await index.search.searchWithFilters(parseSearchQuery('東京 旅行'))
    expect(multiTermHits).toMatchObject([
      { path: 'notes/tokyo-trip.md', title: '来週の東京旅行計画', snippet: null },
    ])
    expect(parseHighlights(multiTermHits[0]!.highlightedTitle)).toEqual([
      { text: '来週の', highlighted: false },
      { text: '東京旅行', highlighted: true },
      { text: '計画', highlighted: false },
    ])

    const filtered = await index.search.searchWithFilters(parseSearchQuery('is:pinned 東京'))
    expect(filtered.map((hit) => hit.path)).toEqual(['notes/body-hit.md'])
  })

  it('matches Latin terms at title word starts only, never mid-word', async () => {
    const db = openDb()
    db.applyProjection(
      sampleNote({
        path: 'notes/car-log.md',
        id: '01hv3xq7c2dm8k4t9w5e6r1n93',
        title: 'Car maintenance log',
        titleKey: 'car maintenance log',
        isPinned: false,
        text: 'An otherwise unrelated body.',
        preview: 'An otherwise unrelated body.',
        tags: [],
        mtime: 100,
      }),
    )
    db.applyProjection(
      sampleNote({
        path: 'notes/car-wash.md',
        id: '01hv3xq7c2dm8k4t9w5e6r1n94',
        title: 'Weekend car wash',
        titleKey: 'weekend car wash',
        isPinned: false,
        text: 'An otherwise unrelated body.',
        preview: 'An otherwise unrelated body.',
        tags: [],
        mtime: 50,
      }),
    )
    db.applyProjection(
      sampleNote({
        path: 'notes/oscar.md',
        id: '01hv3xq7c2dm8k4t9w5e6r1n95',
        title: 'Oscar party plans',
        titleKey: 'oscar party plans',
        isPinned: false,
        text: 'An otherwise unrelated body.',
        preview: 'An otherwise unrelated body.',
        tags: [],
        mtime: 300,
      }),
    )
    db.applyProjection(
      sampleNote({
        path: 'notes/garage.md',
        id: '01hv3xq7c2dm8k4t9w5e6r1n96',
        title: 'Garage',
        titleKey: 'garage',
        isPinned: false,
        text: 'The car needs new brakes.',
        preview: 'The car needs new brakes.',
        tags: [],
        mtime: 200,
      }),
    )
    const index = connectIndex(db)

    // Title-prefix (rank 1) leads, then the word-start title match (rank 2),
    // then the FTS body hit (rank 3). `Oscar party plans` contains `car` only
    // mid-word and must not surface at all.
    const hits = await index.search.searchWithFilters(parseSearchQuery('car'))
    expect(hits.map((hit) => hit.path)).toEqual([
      'notes/car-log.md',
      'notes/car-wash.md',
      'notes/garage.md',
    ])
    expect(parseHighlights(hits[0]!.highlightedTitle)[0]).toEqual({
      text: 'Car',
      highlighted: true,
    })
    expect(parseHighlights(hits[1]!.highlightedTitle)).toContainEqual({
      text: 'car',
      highlighted: true,
    })
    expect(hits[2]!.highlightedTitle).toBe('Garage')
  })

  it('prefix-matches partial terms in note bodies', async () => {
    const db = openDb()
    db.applyProjection(
      sampleNote({
        path: 'notes/security-rollout.md',
        id: '01hv3xq7c2dm8k4t9w5e6r1n87',
        title: 'Security rollout',
        titleKey: 'security rollout',
        text: 'The plan covers authentication migration.',
        preview: 'The plan covers authentication migration.',
        tags: [],
      }),
    )
    const index = connectIndex(db)

    const hits = await index.search.searchWithFilters(parseSearchQuery('authent migr'))

    expect(hits).toMatchObject([{ path: 'notes/security-rollout.md', title: 'Security rollout' }])
    expect(hits[0]!.snippet).toContain('authentication')
    await expect(searchTitles(index, 'authent migr')).resolves.toEqual([
      { path: 'notes/security-rollout.md', title: 'Security rollout' },
    ])
    await expect(searchTitles(index, 'thentication')).resolves.toEqual([])

    const mixedHits = await index.search.searchWithFilters(parseSearchQuery('secur migr'))
    expect(mixedHits).toMatchObject([
      { path: 'notes/security-rollout.md', title: 'Security rollout' },
    ])
    expect(mixedHits[0]!.snippet).toContain('migration')
    expect(parseHighlights(mixedHits[0]!.highlightedTitle)).toEqual([
      { text: 'Secur', highlighted: true },
      { text: 'ity rollout', highlighted: false },
    ])
    await expect(searchTitles(index, 'migr secur')).resolves.toEqual([
      { path: 'notes/security-rollout.md', title: 'Security rollout' },
    ])
  })

  it('ignores a term that tokenizes to nothing instead of emptying the result', async () => {
    const db = openDb()
    db.applyProjection(
      sampleNote({
        path: 'notes/meeting-notes.md',
        id: '01hv3xq7c2dm8k4t9w5e6r1n92',
        title: 'Meeting Notes',
        titleKey: 'meeting notes',
        text: 'Agenda items for the sync.',
        preview: 'Agenda items for the sync.',
        tags: [],
      }),
    )
    const index = connectIndex(db)

    await expect(searchTitles(index, 'meeting - notes')).resolves.toEqual([
      { path: 'notes/meeting-notes.md', title: 'Meeting Notes' },
    ])
    await expect(searchTitles(index, 'agenda &')).resolves.toEqual([
      { path: 'notes/meeting-notes.md', title: 'Meeting Notes' },
    ])
  })

  it('drops an ignored term from title recall, not just from the FTS match', async () => {
    const db = openDb()
    db.applyProjection(
      sampleNote({
        path: 'notes/tokyo-trip.md',
        id: '01hv3xq7c2dm8k4t9w5e6r1n96',
        title: '来週の東京旅行計画',
        titleKey: '来週の東京旅行計画',
        text: 'An otherwise unrelated body.',
        preview: 'An otherwise unrelated body.',
        tags: [],
      }),
    )
    db.applyProjection(
      sampleNote({
        path: 'notes/dotfiles.md',
        id: '01hv3xq7c2dm8k4t9w5e6r1n97',
        title: '.hidden files',
        titleKey: '.hidden files',
        text: 'An otherwise unrelated body.',
        preview: 'An otherwise unrelated body.',
        tags: [],
      }),
    )
    const index = connectIndex(db)

    // Only title recall can reach a term inside an unsegmented title run, so
    // the ignored term has to leave recall too, not just the FTS expression.
    await expect(searchTitles(index, '東京 -')).resolves.toEqual([
      { path: 'notes/tokyo-trip.md', title: '来週の東京旅行計画' },
    ])
    // A punctuation-only query keeps its terms, so recall still matches them.
    await expect(searchTitles(index, '.')).resolves.toEqual([
      { path: 'notes/dotfiles.md', title: '.hidden files' },
    ])
  })

  it('uses pinning to break ties between title-only prefix hits', async () => {
    const db = openDb()
    db.applyProjection(
      sampleNote({
        path: 'notes/tim-maccaw-planning.md',
        id: '01hv3xq7c2dm8k4t9w5e6r1n81',
        title: 'Tim MacCaw Extended Project Planning',
        titleKey: 'tim maccaw extended project planning',
        isPinned: true,
        text: 'An otherwise unrelated body.',
        preview: 'An otherwise unrelated body.',
        tags: [],
        mtime: 100,
      }),
    )
    db.applyProjection(
      sampleNote({
        path: 'notes/tim-macrae.md',
        id: '01hv3xq7c2dm8k4t9w5e6r1n82',
        title: 'Tim MacRae',
        titleKey: 'tim macrae',
        isPinned: false,
        text: 'An otherwise unrelated body.',
        preview: 'An otherwise unrelated body.',
        tags: [],
        mtime: 200,
      }),
    )
    const index = connectIndex(db)

    const hits = await index.search.searchWithFilters(parseSearchQuery('Tim Mac'))
    expect(hits.map((hit) => hit.path)).toEqual([
      'notes/tim-maccaw-planning.md',
      'notes/tim-macrae.md',
    ])
    expect(hits.map((hit) => hit.snippet)).toEqual([null, null])
  })

  it('returns title markers from SQLite for tokenizer-normalized matches', async () => {
    const db = openDb()
    db.applyProjection(
      sampleNote({
        path: 'notes/cafe-alpha.md',
        id: '01hv3xq7c2dm8k4t9w5e6r1n90',
        title: 'Café Alpha',
        titleKey: 'café alpha',
        text: 'An otherwise unrelated body.',
        preview: 'An otherwise unrelated body.',
        tags: [],
      }),
    )
    db.applyProjection(
      sampleNote({
        path: 'notes/car-punctuation.md',
        id: '01hv3xq7c2dm8k4t9w5e6r1n88',
        title: 'Car, car',
        titleKey: 'car, car',
        text: 'An otherwise unrelated body.',
        preview: 'An otherwise unrelated body.',
        tags: [],
      }),
    )
    db.applyProjection(
      sampleNote({
        path: 'notes/body-cafe.md',
        id: '01hv3xq7c2dm8k4t9w5e6r1n89',
        title: 'Unrelated note',
        titleKey: 'unrelated note',
        text: 'A cafe appears in this body.',
        preview: 'A cafe appears in this body.',
        tags: [],
      }),
    )
    const index = connectIndex(db)

    const accentHits = await index.search.searchWithFilters(parseSearchQuery('cafe'))
    expect(accentHits.map((hit) => hit.path)).toEqual(['notes/cafe-alpha.md', 'notes/body-cafe.md'])
    const accentHit = accentHits[0]!
    expect(parseHighlights(accentHit.highlightedTitle)).toEqual([
      { text: 'Café', highlighted: true },
      { text: ' Alpha', highlighted: false },
    ])

    const punctuationHit = (await index.search.searchWithFilters(parseSearchQuery('alpha,')))[0]!
    expect(parseHighlights(punctuationHit.highlightedTitle)).toEqual([
      { text: 'Café ', highlighted: false },
      { text: 'Alpha', highlighted: true },
    ])

    const mergedHit = (await index.search.searchWithFilters(parseSearchQuery('car,')))[0]!
    expect(parseHighlights(mergedHit.highlightedTitle)).toEqual([
      { text: 'Car,', highlighted: true },
      { text: ' ', highlighted: false },
      { text: 'car', highlighted: true },
    ])
  })

  it('finds a partial multi-term title through the mobile All search plan', async () => {
    const db = openDb()
    db.applyProjection(
      sampleNote({
        path: 'notes/tim-maccaw.md',
        id: '01hv3xq7c2dm8k4t9w5e6r1n97',
        title: 'Tim MacCaw',
        titleKey: 'tim maccaw',
        text: 'An otherwise unrelated body.',
        preview: 'An otherwise unrelated body.',
        tags: [],
      }),
    )
    const index = connectIndex(db)

    const parsed = buildAllNotesSearch('Tim Mac', EMPTY_ALL_NOTES_FILTERS, null)
    const hits = await index.search.searchWithFilters(parsed, searchPlanFor(parsed))
    expect(hits).toMatchObject([
      { path: 'notes/tim-maccaw.md', title: 'Tim MacCaw', snippet: null },
    ])
    expect(parseHighlights(hits[0]!.highlightedTitle)).toEqual([
      { text: 'Tim Mac', highlighted: true },
      { text: 'Caw', highlighted: false },
    ])
  })

  it('keeps title-recall highlights when the body also creates an FTS hit', async () => {
    const db = openDb()
    db.applyProjection(
      sampleNote({
        path: 'notes/tim-maccaw.md',
        id: '01hv3xq7c2dm8k4t9w5e6r1n89',
        title: 'Tim MacCaw',
        titleKey: 'tim maccaw',
        text: 'The mac migration is documented here.',
        preview: 'The mac migration is documented here.',
        tags: [],
      }),
    )
    const index = connectIndex(db)

    const hit = (await index.search.searchWithFilters(parseSearchQuery('mac')))[0]!
    expect(hit.snippet).toContain('mac')
    expect(parseHighlights(hit.highlightedTitle)).toEqual([
      { text: 'Tim ', highlighted: false },
      { text: 'Mac', highlighted: true },
      { text: 'Caw', highlighted: false },
    ])
  })

  it('serves a rich title end to end: derived alias suggests, inserts, resolves', async () => {
    const db = openDb()
    const source = '# Meeting with [[Ada Lovelace|Ada]]\n'
    db.applyProjection(
      buildIndexedNote(parseNote({ path: 'notes/meeting.md', source }), {
        fileHash: 'hash-rich',
        mtime: 1,
        source,
      }),
    )
    const index = connectIndex(db)

    const { suggestions } = await index.suggestions.suggestWikiLinkTargets('meeting with ada')
    expect(suggestions).toMatchObject([
      {
        path: 'notes/meeting.md',
        title: 'Meeting with [[Ada Lovelace|Ada]]',
        target: 'Meeting with Ada',
        insertText: 'Meeting with Ada',
      },
    ])
    await expect(index.wikiResolver.resolveWikiTarget(suggestions[0]!.insertText)).resolves.toEqual(
      {
        kind: 'resolved',
        ref: 'notes/meeting.md',
      },
    )
  })
})
