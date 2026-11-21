import { describe, expect, it } from 'vitest'
import { APP_COMMANDS } from '../commands/app-commands.ts'
import {
  createSearchService,
  createSuggestionService,
  createWikiResolverService,
  type FilteredSearchHit,
  type ParsedSearchQuery,
  type RetrieveOptions,
} from '@reflect/core'
import {
  createTestClockService,
  createTestDatabaseService,
  createTestLoggerService,
  createTestPlatformService,
  createTestRetrievalService,
  seedNotes,
} from '@reflect/core/testing'
import { createCommandService } from '../commands/command-service.ts'
import { createPaletteSearchService } from './palette-search-service.ts'
import { noop } from '@ocavue/utils'

const NOON_JUNE_9 = new Date(2026, 5, 9, 12).getTime()

function lexicalHit(path: string, title: string): FilteredSearchHit {
  return {
    path,
    title,
    highlightedTitle: title,
    dailyDate: null,
    snippet: null,
    preview: '',
    mtime: 0,
    isPinned: false,
  }
}

function setup() {
  const searches: ParsedSearchQuery[] = []
  const retrieval = createTestRetrievalService({
    retrieve: () => [
      {
        path: 'notes/rust.md',
        title: 'Rust Notes',
        score: 0.9,
        snippet: 'borrow checker notes',
        heading: null,
        isPrivate: false,
      },
      {
        path: 'daily/2026-06-08.md',
        title: '2026-06-08',
        score: 0.5,
        snippet: '',
        heading: null,
        isPrivate: false,
      },
    ],
  })
  const commands = createCommandService({
    platform: createTestPlatformService(),
    logger: createTestLoggerService(),
  })
  const service = createPaletteSearchService({
    suggestions: createSuggestionService({ database: createTestDatabaseService() }),
    search: {
      searchWithFilters: (parsed) => {
        searches.push(parsed)
        return Promise.resolve([lexicalHit('notes/lexical.md', 'Lexical')])
      },
    },
    retrieval,
    commands,
    clock: createTestClockService({ now: NOON_JUNE_9 }),
    noteVisits: { listRecent: () => Promise.resolve([]) },
  })
  return { service, searches, retrieval, commands }
}

describe('PaletteSearchService', () => {
  it('suggests at most 8 titles, generated date phrases merged in', async () => {
    const database = createTestDatabaseService()
    seedNotes(
      database,
      Array.from({ length: 10 }, (_, i) => ({
        path: `notes/tomorrow-plan-${i}.md`,
        markdown: `# Tomorrow plan ${i}\n`,
      })),
    )
    const service = createPaletteSearchService({
      suggestions: createSuggestionService({ database }),
      search: createSearchService({
        database,
        wikiResolver: createWikiResolverService({ database }),
      }),
      retrieval: createTestRetrievalService(),
      commands: createCommandService({
        platform: createTestPlatformService(),
        logger: createTestLoggerService(),
      }),
      clock: createTestClockService(),
      noteVisits: { listRecent: () => Promise.resolve([]) },
    })

    const suggestions = await service.suggestTitles('tomorrow', {
      today: '2026-06-09',
      dateFormat: 'mdy',
      weekStartDay: 'monday',
    })
    expect(suggestions).toHaveLength(8)
    expect(suggestions.find((suggestion) => suggestion.generated !== undefined)).toMatchObject({
      date: '2026-06-10',
      generated: { phrase: 'Tomorrow' },
    })
    database.close()
  })

  it('lists the recently opened notes first for an empty query', async () => {
    const database = createTestDatabaseService()
    seedNotes(database, [
      { path: 'notes/a.md', markdown: '# A\n' },
      { path: 'notes/b.md', markdown: '# B\n' },
    ])
    const service = createPaletteSearchService({
      suggestions: createSuggestionService({ database }),
      search: createSearchService({
        database,
        wikiResolver: createWikiResolverService({ database }),
      }),
      retrieval: createTestRetrievalService(),
      commands: createCommandService({
        platform: createTestPlatformService(),
        logger: createTestLoggerService(),
      }),
      clock: createTestClockService(),
      noteVisits: { listRecent: () => Promise.resolve([{ path: 'notes/b.md', title: 'B' }]) },
    })

    const suggestions = await service.suggestTitles('', {
      today: '2026-06-09',
      dateFormat: 'mdy',
      weekStartDay: 'monday',
    })
    expect(suggestions.map((suggestion) => suggestion.path)).toEqual(['notes/b.md', 'notes/a.md'])
    database.close()
  })

  it('runs plain text through the one filtered search path when not hybrid', async () => {
    const { service, searches, retrieval } = setup()
    await expect(service.search('rust', { hybrid: false })).resolves.toMatchObject([
      { path: 'notes/lexical.md', title: 'Lexical' },
    ])
    expect(searches).toMatchObject([{ text: 'rust', filtered: false }])
    expect(retrieval.retrieveCalls()).toEqual([])
  })

  it('adapts hybrid retrieval hits to palette hits', async () => {
    const { service, searches, retrieval } = setup()
    await expect(service.search('rust', { hybrid: true })).resolves.toEqual([
      {
        path: 'notes/rust.md',
        title: 'Rust Notes',
        dailyDate: null,
        snippet: 'borrow checker notes',
      },
      { path: 'daily/2026-06-08.md', title: '2026-06-08', dailyDate: '2026-06-08', snippet: null },
    ])
    const options: RetrieveOptions = { mode: 'hybrid' }
    expect(retrieval.retrieveCalls()).toEqual([{ query: 'rust', options }])
    expect(searches).toEqual([])
  })

  it('keeps a filtered query constraint-based even when hybrid is on', async () => {
    const { service, searches, retrieval } = setup()
    await service.search('#work is:daily', { hybrid: true })
    expect(searches).toMatchObject([
      { filtered: true, filters: { tags: ['work'], dailyOnly: true } },
    ])
    expect(retrieval.retrieveCalls()).toEqual([])
  })

  it('merges the data with the commands that have a handler', () => {
    const { service, commands } = setup()
    const toggleTheme = { id: 'theme.toggle', ...APP_COMMANDS['theme.toggle'] }
    const handlers = new AbortController()
    commands.handle('nav.today', noop, handlers.signal)
    commands.handle('theme.toggle', noop, handlers.signal)

    const sections = service.sections({
      query: 'dark',
      dataQuery: 'dark',
      suggestions: [
        { target: 'Dark mode', path: 'notes/dark.md', title: 'Dark mode', alias: null, date: null },
      ],
      hits: [{ path: 'notes/dark.md', title: 'Dark mode', dailyDate: null, snippet: 'body' }],
      filtered: false,
    })
    expect(sections.commandsOnly).toBe(false)
    expect(sections.notes.map((note) => note.path)).toEqual(['notes/dark.md'])
    expect(sections.commands).toEqual([toggleTheme])

    const commandsOnly = service.sections({
      query: '> today',
      dataQuery: '> today',
      suggestions: [],
      hits: [],
      filtered: false,
    })
    expect(commandsOnly.commandsOnly).toBe(true)
    expect(commandsOnly.commands.map((command) => command.id)).toEqual(['nav.today'])
  })

  it('resolves an updated-at preset against the clock', () => {
    const { service } = setup()
    expect(service.updatedPresetFilter('today')).toEqual({
      label: 'Today',
      afterMs: new Date(2026, 5, 9).getTime(),
      beforeMs: null,
    })
    expect(service.updatedPresetFilter('week')).toEqual({
      label: 'Last 7 days',
      afterMs: new Date(2026, 5, 3).getTime(),
      beforeMs: null,
    })
  })
})
