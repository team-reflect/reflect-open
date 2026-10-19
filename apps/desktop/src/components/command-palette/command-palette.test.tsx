import type { MaybePromise } from '@reflect/utils'
import { deepLinkForRoute, formatBinding } from '@reflect/app'
import { createTestAppServices, createTestWindowService } from '@reflect/app/testing'
import { userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect, type ReactNode } from 'react'
import type { RetrievalService, SearchService, SuggestionService } from '@reflect/core'
import {
  createTestCoreServices,
  createTestEmbeddingRuntimeService,
  createTestNoteFileService,
  createTestRetrievalService,
} from '@reflect/core/testing'
import type { CommandContext } from '@/lib/commands/types.ts'
import { useRouter } from '@/routing/router.tsx'
import { expectLocatorToHaveCount } from '@/test-utils/expect.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { CommandPalette } from './command-palette.tsx'
import { PaletteProvider, usePalette } from './palette-provider.tsx'

// The palette runs on the real `PaletteSearchService` of the test app
// services; each test scripts the index reads below it.
const suggestWikiTargets = vi.fn<SuggestionService['suggestWikiTargets']>()
const searchWithFilters = vi.fn<SearchService['searchWithFilters']>()
const retrieve = vi.fn<RetrievalService['retrieve']>()
/**
 * Receives the `reflect://` link of every note window a test opens.
 */
const openNoteWindow = vi.fn<(deepLink: string) => MaybePromise<boolean>>()
// The model is absent by default: the palette is exactly the lexical surface
// it was before Plan 09 (hybrid mode is additive). The gating tests flip both
// halves of the hybrid opt-in.
let embedReady = false
let semanticEnabled = false
/**
 * The note files the preview pane reads; a missing one previews as Empty.
 */
let files: Record<string, string> = {}

beforeEach(() => {
  embedReady = false
  semanticEnabled = false
  files = {}
  suggestWikiTargets.mockReset().mockResolvedValue([])
  searchWithFilters.mockReset().mockResolvedValue([])
  retrieve.mockReset().mockResolvedValue([])
  openNoteWindow.mockReset().mockResolvedValue(true)
})

/**
 * A search hit with the fields the palette does not read filled in.
 */
function hit(fields: {
  path: string
  title: string
  snippet: string | null
  dailyDate: string | null
}) {
  return {
    ...fields,
    highlightedTitle: fields.title,
    preview: '',
    mtime: 0,
    isPinned: false,
  }
}

function OpenOnMount({ query }: { query: string }) {
  const { openPalette } = usePalette()
  useEffect(() => {
    openPalette(query)
  }, [openPalette, query])
  return null
}

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

async function renderPalette(query: string, context?: Partial<CommandContext>) {
  const navigate = vi.fn()
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    suggestions: {
      suggestWikiTargets,
      suggestWikiLinkTargets: () => ({
        suggestions: [],
        claimedTargetKeys: [],
        queryReadsAsDate: false,
      }),
      suggestTags: () => [],
    },
    search: { searchWithFilters },
    retrieval: createTestRetrievalService({ retrieve }),
    embeddingRuntime: createTestEmbeddingRuntimeService({
      status: embedReady
        ? { status: 'ready', model: 'all-MiniLM-L6-v2' }
        : { status: 'uninitialized' },
    }),
    noteFile: createTestNoteFileService({ files }),
  })
  const appLayer = createTestAppServices(app, {
    window: createTestWindowService({ openNoteWindow }),
  })
  const fullContext: CommandContext = {
    services: app,
    app: appLayer,
    navigate,
    route: () => ({ kind: 'today' }),
    notePath: () => null,
    back: vi.fn(),
    forward: vi.fn(),
    clearScrollState: vi.fn(),
    togglePin: vi.fn(() => {}),
    togglePrivate: vi.fn(() => {}),
    toggleTheme: vi.fn(),
    toggleSidebar: vi.fn(),
    newChat: vi.fn(),
    openNoteFind: vi.fn(),
    findNextInNote: vi.fn(),
    findPreviousInNote: vi.fn(),
    switchGraph: vi.fn(),
    toggleAudioMemo: vi.fn(),
    openPalette: vi.fn(),
    openShortcuts: vi.fn(),
    openTemplatePicker: vi.fn(),
    openTemplateCreate: vi.fn(),
    enableSemanticSearch: vi.fn(),
    ...context,
  }
  const view = await renderInApp(
    <PaletteProvider>
      <OpenOnMount query={query} />
      <CommandPalette context={fullContext} />
      <RouteProbe />
    </PaletteProvider>,
    {
      app,
      appServices: appLayer,
      graph: { root: '/g', name: 'g', generation: 1 },
      settings: { semanticSearchEnabled: semanticEnabled, dateFormat: 'mdy' },
    },
  )
  return { view, navigate, app }
}

describe('CommandPalette', () => {
  it('never shows "No results" while the recall feed is still loading', async () => {
    const pending = Promise.withResolvers<never[]>()
    suggestWikiTargets.mockReturnValue(pending.promise)
    const { view } = await renderPalette('')
    expect(view.getByText('No results').query()).toBeNull() // loading ≠ empty
    pending.resolve([])
    await expect.element(view.getByText('No results')).toBeInTheDocument()
  })

  it('no "No results" while FTS is still answering a non-empty query', async () => {
    suggestWikiTargets.mockResolvedValue([]) // titles answered: nothing
    const pending = Promise.withResolvers<never[]>()
    searchWithFilters.mockImplementation(() => pending.promise)
    const { view } = await renderPalette('rust')
    await vi.waitFor(() => expect(suggestWikiTargets).toHaveBeenCalled())
    expect(view.getByText('No results').query()).toBeNull() // body hits still in flight
    pending.resolve([])
    await expect.element(view.getByText('No results')).toBeInTheDocument()
  })

  it('a failed index query shows an error, not "No results"', async () => {
    suggestWikiTargets.mockRejectedValue(new Error('index unavailable'))
    const { view } = await renderPalette('')
    await expect
      .element(view.getByText('Search unavailable — the index didn’t answer.'))
      .toBeInTheDocument()
    expect(view.getByText('No results').query()).toBeNull()
  })

  it('empty query shows the recent-notes recall feed', async () => {
    suggestWikiTargets.mockResolvedValue([
      { target: 'Recent One', path: 'notes/r1.md', title: 'Recent One', alias: null, date: null },
    ])
    const { view } = await renderPalette('')
    await expect.element(view.getByText('Recent One')).toBeInTheDocument()
    await expect.element(view.getByText('Recent', { exact: true })).toBeInTheDocument()
    expect(view.getByText('Commands').query()).toBeNull() // recall feed only (decided)
  })

  it('a typed query shows ranked notes with highlighted snippets and Enter opens the top hit', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([
      hit({
        path: 'notes/rust.md',
        title: 'Rust Notes',
        snippet: 'about rust things',
        dailyDate: null,
      }),
    ])
    const { view } = await renderPalette('rust')
    await expect.element(view.getByText('Rust Notes')).toBeInTheDocument()
    expect(view.getByText('rust', { exact: true }).element().tagName).toBe('MARK')

    await userEvent.keyboard('{Enter}')
    await expect.element(view.getByTestId('route')).toMatchTextContent('notes/rust.md')
    expect(openNoteWindow).not.toHaveBeenCalled()
    expect(view.getByTestId('palette-overlay').query()).toBeNull()
  })

  it('modifier-click opens one note window and closes the palette synchronously', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([
      hit({ path: 'notes/rust.md', title: 'Rust Notes', snippet: null, dailyDate: null }),
    ])
    const pendingOpen = Promise.withResolvers<boolean>()
    openNoteWindow.mockReturnValue(pendingOpen.promise)
    const { view } = await renderPalette('rust')
    const result = view.getByText('Rust Notes')

    await result.click({ modifiers: ['ControlOrMeta'] })

    expect(view.getByTestId('palette-overlay').query()).toBeNull()
    expect(openNoteWindow).toHaveBeenCalledTimes(1)
    expect(openNoteWindow).toHaveBeenCalledWith(
      deepLinkForRoute({
        kind: 'note',
        path: 'notes/rust.md',
      }),
    )
    expect(view.getByTestId('route').element().textContent).toBe(JSON.stringify({ kind: 'today' }))
    pendingOpen.resolve(true)
  })

  it('falls back in-window after a declined modifier-click even though the palette closed', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([
      hit({ path: 'notes/rust.md', title: 'Rust Notes', snippet: null, dailyDate: null }),
    ])
    openNoteWindow.mockResolvedValue(false)
    const { view } = await renderPalette('rust')
    const result = view.getByText('Rust Notes')

    await result.click({ modifiers: ['ControlOrMeta'] })

    expect(view.getByTestId('palette-overlay').query()).toBeNull()
    await expect.element(view.getByTestId('route')).toMatchTextContent('notes/rust.md')
  })

  it('Mod+Enter opens the highlighted note in one note window', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([
      hit({ path: 'notes/rust.md', title: 'Rust Notes', snippet: null, dailyDate: null }),
    ])
    const { view } = await renderPalette('rust')
    await expect.element(view.getByText('Rust Notes')).toBeInTheDocument()

    await userEvent.keyboard('{ControlOrMeta>}{Enter}{/ControlOrMeta}')

    expect(view.getByTestId('palette-overlay').query()).toBeNull()
    expect(openNoteWindow).toHaveBeenCalledTimes(1)
    expect(openNoteWindow).toHaveBeenCalledWith(
      deepLinkForRoute({
        kind: 'note',
        path: 'notes/rust.md',
      }),
    )
    expect(view.getByTestId('route').element().textContent).toBe(JSON.stringify({ kind: 'today' }))
  })

  it('falls back in-window after a declined Mod+Enter', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([
      hit({ path: 'notes/rust.md', title: 'Rust Notes', snippet: null, dailyDate: null }),
    ])
    openNoteWindow.mockResolvedValue(false)
    const { view } = await renderPalette('rust')
    await expect.element(view.getByText('Rust Notes')).toBeInTheDocument()

    await userEvent.keyboard('{ControlOrMeta>}{Enter}{/ControlOrMeta}')

    expect(view.getByTestId('palette-overlay').query()).toBeNull()
    await expect.element(view.getByTestId('route')).toMatchTextContent('notes/rust.md')
  })

  it('> filters to commands and Enter runs the selection', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([])
    const { view } = await renderPalette('> toggle theme')
    await expect.element(view.getByText('Toggle theme')).toBeInTheDocument()
    expect(view.getByText('Notes', { exact: true }).query()).toBeNull()
  })

  it('bound commands show keycap hints', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([])
    const { view, app } = await renderPalette('> go to today')
    const row = view.getByText('Go to today')
    await expect.element(row).toBeInTheDocument()
    const item = row.element().closest('[cmdk-item]')
    for (const key of formatBinding('Mod-d', app.platform.isApplePlatform)) {
      expect(item?.textContent).toContain(key)
    }
  })

  it('filter tokens run the constrained search and render its rows', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([
      hit({
        path: 'daily/2026-06-08.md',
        title: '2026-06-08',
        dailyDate: '2026-06-08',
        snippet: null,
      }),
      hit({ path: 'notes/w.md', title: 'Work log', dailyDate: null, snippet: null }),
    ])
    const { view } = await renderPalette('#work is:daily')
    await expect.element(view.getByText('Work log')).toBeInTheDocument()
    // The label renders in the row and again as the preview pane's header.
    await expectLocatorToHaveCount(view.getByText('Mon, June 8th, 2026'), 2)
    expect(searchWithFilters.mock.calls.at(-1)?.[0]).toMatchObject({
      filtered: true,
      filters: { tags: ['work'], dailyOnly: true },
    })

    await userEvent.keyboard('{Enter}')
    await expect.element(view.getByTestId('route')).toMatchTextContent('2026-06-08')
  })

  it('stays lexical when the model is ready but semantic search is disabled', async () => {
    embedReady = true
    semanticEnabled = false
    await renderPalette('rust')
    // Disabling must bite immediately, even while the model is still loaded.
    await vi.waitFor(() => expect(searchWithFilters).toHaveBeenCalled())
    expect(retrieve).not.toHaveBeenCalled()
  })

  it('blends semantic hits once enabled and the model is ready', async () => {
    embedReady = true
    semanticEnabled = true
    retrieve.mockResolvedValue([
      {
        path: 'notes/rust.md',
        title: 'Rust Notes',
        score: 0.9,
        snippet: 'borrow checker notes',
        heading: null,
        isPrivate: false,
      },
    ])
    const { view } = await renderPalette('rust')
    await expect.element(view.getByText('Rust Notes')).toBeInTheDocument()
    expect(retrieve).toHaveBeenCalledWith('rust', { mode: 'hybrid' })
  })

  it('previews the highlighted note and follows arrow-key selection', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([
      hit({ path: 'notes/first.md', title: 'First', dailyDate: null, snippet: null }),
      hit({ path: 'notes/second.md', title: 'Second', dailyDate: null, snippet: null }),
    ])
    files = {
      'notes/first.md': '# First\n\nfirst body\n',
      'notes/second.md': '# Second\n\nsecond body\n',
    }
    const { view } = await renderPalette('note')
    await expect.element(view.getByRole('option', { name: 'First' })).toBeInTheDocument()

    // cmdk highlights the top hit; its content renders in the preview pane.
    const preview = view.getByTestId('palette-preview')
    await expect.element(preview).toMatchTextContent('first body')

    await userEvent.keyboard('{ArrowDown}')
    await expect.element(view.getByTestId('palette-preview')).toMatchTextContent('second body')
  })

  it('frontmatter never reaches the preview', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([
      hit({ path: 'notes/pinned.md', title: 'Pinned', dailyDate: null, snippet: null }),
    ])
    files = { 'notes/pinned.md': '---\npinned: true\n---\n# Pinned\n\nbody\n' }
    const { view } = await renderPalette('pinned')
    const preview = view.getByTestId('palette-preview')
    await expect.element(preview).toMatchTextContent('body')
    expect(preview.element().textContent).not.toContain('pinned: true')
  })

  it('a daily note without a file yet previews as Empty under its day label', async () => {
    suggestWikiTargets.mockResolvedValue([
      { target: '2026-06-16', path: null, title: '2026-06-16', alias: null, date: '2026-06-16' },
    ])
    searchWithFilters.mockResolvedValue([])
    const { view } = await renderPalette('2026-06-16')
    const preview = view.getByTestId('palette-preview')
    await expect.element(preview).toMatchTextContent('Empty')
    expect(preview.element().textContent).toContain('Tue, June 16th, 2026')
  })

  it('a query matching only commands still highlights one, so Enter runs it', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([])
    const toggleTheme = vi.fn()
    const { view } = await renderPalette('toggle theme', { toggleTheme })
    await expect.element(view.getByText('Toggle theme')).toBeInTheDocument()

    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() => expect(toggleTheme).toHaveBeenCalled())
  })

  it('> command mode renders the single column without a preview pane', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([])
    const { view } = await renderPalette('> toggle theme')
    await expect.element(view.getByText('Toggle theme')).toBeInTheDocument()
    expect(view.getByTestId('palette-preview').query()).toBeNull()
    expect(view.getByText('No note selected').query()).toBeNull()
  })

  it('a daily suggestion renders its day label and opens the daily route', async () => {
    suggestWikiTargets.mockResolvedValue([
      {
        target: '2026-06-09',
        path: 'daily/2026-06-09.md',
        title: '2026-06-09',
        alias: null,
        date: '2026-06-09',
      },
    ])
    searchWithFilters.mockResolvedValue([])
    const { view } = await renderPalette('2026-06-09')
    // The label renders in the row and again as the preview pane's header.
    await expectLocatorToHaveCount(view.getByText('Tue, June 9th, 2026'), 2)

    await userEvent.keyboard('{Enter}')
    await expect.element(view.getByTestId('route')).toMatchTextContent('2026-06-09')
  })

  it('shows a `//` note by its first segment and names the alias it matched through', async () => {
    suggestWikiTargets.mockResolvedValue([
      {
        target: 'Tim MacCaw // Dad',
        path: 'notes/tim-maccaw-dad.md',
        title: 'Tim MacCaw // Dad',
        alias: 'Dad',
        date: null,
      },
    ])
    searchWithFilters.mockResolvedValue([])
    const { view } = await renderPalette('dad')
    await expect.element(view.getByText('Tim MacCaw', { exact: true })).toBeInTheDocument()
    await expect.element(view.getByText('Dad → Tim MacCaw')).toBeInTheDocument()
    expect(view.getByText('Tim MacCaw // Dad').query()).toBeNull()

    await userEvent.keyboard('{Enter}')
    await expect.element(view.getByTestId('route')).toMatchTextContent('notes/tim-maccaw-dad.md')
  })
})
