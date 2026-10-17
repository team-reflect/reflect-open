import { describe, expect, it } from 'vitest'
import type { Command } from '../commands/command-service.ts'
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
  const commands = createCommandService<string>({
    platform: createTestPlatformService(),
    logger: createTestLoggerService(),
  })
  const clock = createTestClockService({ now: NOON_JUNE_9 })
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
    clock,
  })
  return { service, searches, retrieval, commands, clock }
}

describe('PaletteSearchService', () => {
  it('reads today from the wall clock', () => {
    const { service, clock } = setup()
    expect(service.today()).toBe('2026-06-09')
    clock.setNow(new Date(2026, 5, 10, 0, 1).getTime())
    expect(service.today()).toBe('2026-06-10')
  })

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

  it('merges the data with the registered commands', () => {
    const { service, commands } = setup()
    const toggleTheme: Command<string> = {
      id: 'theme.toggle',
      title: 'Toggle theme',
      keywords: ['dark'],
      run: () => {},
    }
    commands.register([{ id: 'nav.today', title: 'Go to today', run: () => {} }, toggleTheme])

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
