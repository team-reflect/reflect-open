import { cleanup, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect } from 'react'
import type { CommandContext } from '@/lib/commands/types'
import { CommandPalette } from './command-palette'
import { PaletteProvider, usePalette } from './palette-provider'

const suggestWikiTargets = vi.hoisted(() => vi.fn())
const searchWithFilters = vi.hoisted(() => vi.fn())
const retrieve = vi.hoisted(() => vi.fn())
const readNote = vi.hoisted(() => vi.fn<(path: string) => Promise<string>>())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  suggestWikiTargets,
  searchWithFilters,
  retrieve,
  readNote,
}))
// jsdom can't host the ProseMirror contenteditable (same stub as the
// route-content tests); the preview's data path stays real.
vi.mock('@/editor/markdown-preview', () => ({
  MarkdownPreview: ({ content }: { content: string }) => (
    <div data-testid="markdown-preview">{content}</div>
  ),
}))
// The model is absent by default: the palette is exactly the lexical surface
// it was before Plan 09 (hybrid mode is additive). The gating tests flip both
// halves of the hybrid opt-in.
const embedReady = vi.hoisted(() => ({ value: false }))
vi.mock('@/lib/use-embed-status', () => ({
  useEmbedStatus: () =>
    embedReady.value
      ? { status: 'ready', model: 'all-MiniLM-L6-v2' }
      : { status: 'uninitialized' },
}))
const semanticSetting = vi.hoisted(() => ({ enabled: false }))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: { semanticSearchEnabled: semanticSetting.enabled, dateFormat: 'mdy' },
    updateSettings: () => {},
  }),
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))
// Register after the core mock is installed so commands see the mocked graph.
const { registerAppCommands } = await import('@/lib/commands/app-commands')
registerAppCommands()

// RTL auto-cleanup isn't wired globally in this project: without this, a
// previous test's still-mounted palette leaks into the next test's
// document.body queries (e.g. its settled "No results").
afterEach(cleanup)

beforeEach(() => {
  embedReady.value = false
  semanticSetting.enabled = false
  readNote.mockReset().mockResolvedValue('')
})

// cmdk scrolls the selected item into view and observes list size; jsdom has
// no layout, so both get inert stubs.
window.HTMLElement.prototype.scrollIntoView = () => {}
window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

function OpenOnMount({ query }: { query: string }) {
  const { openPalette } = usePalette()
  useEffect(() => {
    openPalette(query)
  }, [openPalette, query])
  return null
}

function renderPalette(query: string, context?: Partial<CommandContext>) {
  const navigate = vi.fn()
  const fullContext: CommandContext = {
    navigate,
    route: () => ({ kind: 'today' }),
    notePath: () => null,
    back: vi.fn(),
    forward: vi.fn(),
    clearScrollState: vi.fn(),
    toggleTheme: vi.fn(),
    toggleSidebar: vi.fn(),
    newChat: vi.fn(),
    switchGraph: vi.fn(),
    toggleAudioMemo: vi.fn(),
    generation: () => 1,
    openPalette: vi.fn(),
    openShortcuts: vi.fn(),
    openTemplatePicker: vi.fn(),
    openTemplateCreate: vi.fn(),
    enableSemanticSearch: vi.fn(),
    ...context,
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <PaletteProvider>
        <OpenOnMount query={query} />
        <CommandPalette context={fullContext} />
      </PaletteProvider>
    </QueryClientProvider>,
  )
  return { view, navigate }
}

describe('CommandPalette', () => {
  it('never shows "No results" while the recall feed is still loading', async () => {
    let release!: (value: never[]) => void
    suggestWikiTargets.mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    const { view } = renderPalette('')
    expect(view.queryByText('No results')).toBeNull() // loading ≠ empty
    release([])
    await waitFor(() => expect(view.queryByText('No results')).not.toBeNull())
  })

  it('no "No results" while FTS is still answering a non-empty query', async () => {
    suggestWikiTargets.mockResolvedValue([]) // titles answered: nothing
    let release!: (value: never[]) => void
    const pending = new Promise((resolve) => {
      release = resolve
    })
    searchWithFilters.mockImplementation(() => pending)
    const { view } = renderPalette('rust')
    await waitFor(() => expect(suggestWikiTargets).toHaveBeenCalled())
    expect(view.queryByText('No results')).toBeNull() // body hits still in flight
    release([])
    await waitFor(() => expect(view.queryByText('No results')).not.toBeNull())
  })

  it('a failed index query shows an error, not "No results"', async () => {
    suggestWikiTargets.mockRejectedValue(new Error('index unavailable'))
    const { view } = renderPalette('')
    await view.findByText('Search unavailable — the index didn’t answer.')
    expect(view.queryByText('No results')).toBeNull()
  })

  it('empty query shows the recent-notes recall feed', async () => {
    suggestWikiTargets.mockResolvedValue([
      { target: 'Recent One', path: 'notes/r1.md', title: 'Recent One', alias: null, date: null },
    ])
    const { view } = renderPalette('')
    await view.findByText('Recent One')
    expect(view.getByText('Recent')).toBeDefined()
    expect(view.queryByText('Commands')).toBeNull() // recall feed only (decided)
  })

  it('a typed query shows ranked notes with highlighted snippets and Enter opens the top hit', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([
      { path: 'notes/rust.md', title: 'Rust Notes', snippet: 'about rust things', dailyDate: null },
    ])
    const { view, navigate } = renderPalette('rust')
    await view.findByText('Rust Notes')
    expect(view.getByText('rust').tagName).toBe('MARK')

    await userEvent.keyboard('{Enter}')
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ kind: 'note', path: 'notes/rust.md' }),
    )
  })

  it('> filters to commands and Enter runs the selection', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([])
    const { view } = renderPalette('> toggle theme')
    await view.findByText('Toggle theme')
    expect(view.queryByText('Notes')).toBeNull()
  })

  it('bound commands show keycap hints (jsdom is non-Apple: Ctrl)', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([])
    const { view } = renderPalette('> go to today')
    const row = await view.findByText('Go to today')
    const item = row.closest('[cmdk-item]')
    expect(item?.textContent).toContain('Ctrl')
    expect(item?.textContent).toContain('D')
  })

  it('filter tokens run the constrained search and render its rows', async () => {
    suggestWikiTargets.mockClear()
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([
      { path: 'daily/2026-06-08.md', title: '2026-06-08', dailyDate: '2026-06-08', snippet: null },
      { path: 'notes/w.md', title: 'Work log', dailyDate: null, snippet: null },
    ])
    const { view, navigate } = renderPalette('#work is:daily')
    await view.findByText('Work log')
    // The label renders in the row and again as the preview pane's header.
    await waitFor(() => expect(view.getAllByText('Mon, June 8th, 2026')).toHaveLength(2))
    expect(searchWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        filtered: true,
        filters: expect.objectContaining({ tags: ['work'], dailyOnly: true }),
      }),
    )

    await userEvent.keyboard('{Enter}')
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ kind: 'daily', date: '2026-06-08' }),
    )
  })

  it('stays lexical when the model is ready but semantic search is disabled', async () => {
    embedReady.value = true
    semanticSetting.enabled = false
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockClear().mockResolvedValue([])
    retrieve.mockClear()
    renderPalette('rust')
    // Disabling must bite immediately, even while the model is still loaded.
    await waitFor(() => expect(searchWithFilters).toHaveBeenCalled())
    expect(retrieve).not.toHaveBeenCalled()
  })

  it('blends semantic hits once enabled and the model is ready', async () => {
    embedReady.value = true
    semanticSetting.enabled = true
    suggestWikiTargets.mockResolvedValue([])
    retrieve.mockClear().mockResolvedValue([
      {
        path: 'notes/rust.md',
        title: 'Rust Notes',
        score: 0.9,
        snippet: 'borrow checker notes',
        heading: null,
        isPrivate: false,
      },
    ])
    const { view } = renderPalette('rust')
    await view.findByText('Rust Notes')
    expect(retrieve).toHaveBeenCalledWith('rust', { mode: 'hybrid' })
  })

  it('previews the highlighted note and follows arrow-key selection', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([
      { path: 'notes/first.md', title: 'First', dailyDate: null, snippet: null },
      { path: 'notes/second.md', title: 'Second', dailyDate: null, snippet: null },
    ])
    readNote.mockImplementation(async (path) =>
      path === 'notes/first.md' ? '# First\n\nfirst body\n' : '# Second\n\nsecond body\n',
    )
    const { view } = renderPalette('note')
    await view.findByText('First')

    // cmdk highlights the top hit; its content renders in the preview pane.
    const preview = await view.findByTestId('markdown-preview')
    await waitFor(() => expect(preview.textContent).toContain('first body'))

    await userEvent.keyboard('{ArrowDown}')
    await waitFor(() =>
      expect(view.getByTestId('markdown-preview').textContent).toContain('second body'),
    )
    expect(readNote).toHaveBeenCalledWith('notes/first.md')
    expect(readNote).toHaveBeenCalledWith('notes/second.md')
  })

  it('frontmatter never reaches the preview', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([
      { path: 'notes/pinned.md', title: 'Pinned', dailyDate: null, snippet: null },
    ])
    readNote.mockResolvedValue('---\npinned: true\n---\n# Pinned\n\nbody\n')
    const { view } = renderPalette('pinned')
    const preview = await view.findByTestId('markdown-preview')
    await waitFor(() => expect(preview.textContent).toContain('body'))
    expect(preview.textContent).not.toContain('pinned: true')
  })

  it('a daily note without a file yet previews as Empty under its day label', async () => {
    suggestWikiTargets.mockResolvedValue([
      { target: '2026-06-16', path: null, title: '2026-06-16', alias: null, date: '2026-06-16' },
    ])
    searchWithFilters.mockResolvedValue([])
    readNote.mockRejectedValue({ kind: 'notFound', message: 'no such note' })
    const { view } = renderPalette('2026-06-16')
    const preview = await view.findByTestId('palette-preview')
    await waitFor(() => expect(preview.textContent).toContain('Empty'))
    expect(preview.textContent).toContain('Tue, June 16th, 2026')
  })

  it('a query matching only commands still highlights one, so Enter runs it', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([])
    const toggleTheme = vi.fn()
    const { view } = renderPalette('toggle theme', { toggleTheme })
    await view.findByText('Toggle theme')

    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(toggleTheme).toHaveBeenCalled())
  })

  it('> command mode renders the single column without a preview pane', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([])
    const { view } = renderPalette('> toggle theme')
    await view.findByText('Toggle theme')
    expect(view.queryByTestId('palette-preview')).toBeNull()
    expect(view.queryByText('No note selected')).toBeNull()
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
    const { view, navigate } = renderPalette('2026-06-09')
    // The label renders in the row and again as the preview pane's header.
    await waitFor(() => expect(view.getAllByText('Tue, June 9th, 2026')).toHaveLength(2))

    await userEvent.keyboard('{Enter}')
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ kind: 'daily', date: '2026-06-09' }),
    )
  })
})
