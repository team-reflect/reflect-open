import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { useEffect } from 'react'
import { isApplePlatform } from '@/lib/keybindings'
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
  useGraph: () => ({ graph: { root: '/g', name: 'g', cloudSync: null, generation: 1 } }),
}))
// Register after the core mock is installed so commands see the mocked graph.
const { registerAppCommands } = await import('@/lib/commands/app-commands')
registerAppCommands()

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

async function renderPalette(query: string, context?: Partial<CommandContext>) {
  const navigate = vi.fn()
  const fullContext: CommandContext = {
    navigate,
    route: () => ({ kind: 'today' }),
    notePath: () => null,
    back: vi.fn(),
    forward: vi.fn(),
    toggleTheme: vi.fn(),
    toggleSidebar: vi.fn(),
    newChat: vi.fn(),
    toggleAudioMemo: vi.fn(),
    generation: () => 1,
    openPalette: vi.fn(),
    openShortcuts: vi.fn(),
    enableSemanticSearch: vi.fn(),
    ...context,
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = await render(
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
    const { view } = await renderPalette('')
    await expect.element(view.getByText('No results', { exact: true })).not.toBeInTheDocument() // loading ≠ empty
    release([])
    await expect.element(view.getByText('No results', { exact: true })).toBeInTheDocument()
  })

  it('no "No results" while FTS is still answering a non-empty query', async () => {
    suggestWikiTargets.mockResolvedValue([]) // titles answered: nothing
    let release!: (value: never[]) => void
    const pending = new Promise((resolve) => {
      release = resolve
    })
    searchWithFilters.mockImplementation(() => pending)
    const { view } = await renderPalette('rust')
    await vi.waitFor(() => expect(suggestWikiTargets).toHaveBeenCalled())
    await expect.element(view.getByText('No results', { exact: true })).not.toBeInTheDocument() // body hits still in flight
    release([])
    await expect.element(view.getByText('No results', { exact: true })).toBeInTheDocument()
  })

  it('a failed index query shows an error, not "No results"', async () => {
    suggestWikiTargets.mockRejectedValue(new Error('index unavailable'))
    const { view } = await renderPalette('')
    await expect
      .element(view.getByText('Search unavailable — the index didn’t answer.'))
      .toBeInTheDocument()
    await expect.element(view.getByText('No results', { exact: true })).not.toBeInTheDocument()
  })

  it('empty query shows the recent-notes recall feed', async () => {
    suggestWikiTargets.mockResolvedValue([
      { target: 'Recent One', path: 'notes/r1.md', title: 'Recent One', alias: null, date: null },
    ])
    const { view } = await renderPalette('')
    await expect.element(view.getByText('Recent One', { exact: true })).toBeInTheDocument()
    await expect.element(view.getByText('Recent', { exact: true })).toBeInTheDocument()
    await expect.element(view.getByText('Commands', { exact: true })).not.toBeInTheDocument() // recall feed only (decided)
  })

  it('a typed query shows ranked notes with highlighted snippets and Enter opens the top hit', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([
      // \u0001 and \u0002 are the highlight start/end markers parseHighlights
      // splits on, so "rust" renders inside a <mark>.
      { path: 'notes/rust.md', title: 'Rust Notes', snippet: 'about \u0001rust\u0002 things', dailyDate: null },
    ])
    const { view, navigate } = await renderPalette('rust')
    await expect.element(view.getByText('Rust Notes', { exact: true })).toBeInTheDocument()
    expect(view.getByText('rust', { exact: true }).element().tagName).toBe('MARK')

    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ kind: 'note', path: 'notes/rust.md' }),
    )
  })

  it('> filters to commands and Enter runs the selection', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([])
    const { view } = await renderPalette('> toggle theme')
    await expect.element(view.getByText('Toggle theme', { exact: true })).toBeInTheDocument()
    await expect.element(view.getByText('Notes', { exact: true })).not.toBeInTheDocument()
  })

  it('bound commands show platform keycap hints', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([])
    const { view } = await renderPalette('> go to today')
    const row = view.getByText('Go to today', { exact: true })
    await expect.element(row).toBeInTheDocument()
    const item = row.element().closest('[cmdk-item]')
    expect(item?.textContent).toContain(isApplePlatform() ? '⌘' : 'Ctrl')
    expect(item?.textContent).toContain('D')
  })

  it('filter tokens run the constrained search and render its rows', async () => {
    suggestWikiTargets.mockClear()
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([
      { path: 'daily/2026-06-08.md', title: '2026-06-08', dailyDate: '2026-06-08', snippet: null },
      { path: 'notes/w.md', title: 'Work log', dailyDate: null, snippet: null },
    ])
    const { view, navigate } = await renderPalette('#work is:daily')
    await expect.element(view.getByText('Work log', { exact: true })).toBeInTheDocument()
    // The label renders in the row and again as the preview pane's header.
    await vi.waitFor(() =>
      expect(view.getByText('Mon, June 8th, 2026', { exact: true }).elements()).toHaveLength(2),
    )
    expect(searchWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        filtered: true,
        filters: expect.objectContaining({ tags: ['work'], dailyOnly: true }),
      }),
    )

    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ kind: 'daily', date: '2026-06-08' }),
    )
  })

  it('stays lexical when the model is ready but semantic search is disabled', async () => {
    embedReady.value = true
    semanticSetting.enabled = false
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockClear().mockResolvedValue([])
    retrieve.mockClear()
    await renderPalette('rust')
    // Disabling must bite immediately, even while the model is still loaded.
    await vi.waitFor(() => expect(searchWithFilters).toHaveBeenCalled())
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
    const { view } = await renderPalette('rust')
    await expect.element(view.getByText('Rust Notes', { exact: true })).toBeInTheDocument()
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
    const { view } = await renderPalette('note')
    await expect.element(view.getByText('First', { exact: true })).toBeInTheDocument()

    // cmdk highlights the top hit; its content renders in the preview pane.
    const preview = view.getByTestId('markdown-preview')
    await expect.element(preview).toHaveTextContent('first body')

    await userEvent.keyboard('{ArrowDown}')
    await expect.element(view.getByTestId('markdown-preview')).toHaveTextContent('second body')
    expect(readNote).toHaveBeenCalledWith('notes/first.md')
    expect(readNote).toHaveBeenCalledWith('notes/second.md')
  })

  it('frontmatter never reaches the preview', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([
      { path: 'notes/pinned.md', title: 'Pinned', dailyDate: null, snippet: null },
    ])
    readNote.mockResolvedValue('---\npinned: true\n---\n# Pinned\n\nbody\n')
    const { view } = await renderPalette('pinned')
    const preview = view.getByTestId('markdown-preview')
    await expect.element(preview).toHaveTextContent('body')
    expect(preview.element().textContent).not.toContain('pinned: true')
  })

  it('a daily note without a file yet previews as Empty under its day label', async () => {
    suggestWikiTargets.mockResolvedValue([
      { target: '2026-06-16', path: null, title: '2026-06-16', alias: null, date: '2026-06-16' },
    ])
    searchWithFilters.mockResolvedValue([])
    readNote.mockRejectedValue({ kind: 'notFound', message: 'no such note' })
    const { view } = await renderPalette('2026-06-16')
    const preview = view.getByTestId('palette-preview')
    await expect.element(preview).toHaveTextContent('Empty')
    expect(preview.element().textContent).toContain('Tue, June 16th, 2026')
  })

  it('a query matching only commands still highlights one, so Enter runs it', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([])
    const toggleTheme = vi.fn()
    const { view } = await renderPalette('toggle theme', { toggleTheme })
    await expect.element(view.getByText('Toggle theme', { exact: true })).toBeInTheDocument()

    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() => expect(toggleTheme).toHaveBeenCalled())
  })

  it('> command mode renders the single column without a preview pane', async () => {
    suggestWikiTargets.mockResolvedValue([])
    searchWithFilters.mockResolvedValue([])
    const { view } = await renderPalette('> toggle theme')
    await expect.element(view.getByText('Toggle theme', { exact: true })).toBeInTheDocument()
    await expect.element(view.getByTestId('palette-preview')).not.toBeInTheDocument()
    await expect.element(view.getByText('No note selected', { exact: true })).not.toBeInTheDocument()
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
    const { view, navigate } = await renderPalette('2026-06-09')
    // The label renders in the row and again as the preview pane's header.
    await vi.waitFor(() =>
      expect(view.getByText('Tue, June 9th, 2026', { exact: true }).elements()).toHaveLength(2),
    )

    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ kind: 'daily', date: '2026-06-09' }),
    )
  })
})
