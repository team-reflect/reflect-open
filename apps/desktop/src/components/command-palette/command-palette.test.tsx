import { cleanup, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect } from 'react'
import type { CommandContext } from '@/lib/commands/types'
import { CommandPalette } from './command-palette'
import { PaletteProvider, usePalette } from './palette-provider'

const suggestWikiTargets = vi.hoisted(() => vi.fn())
const searchWithFilters = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  suggestWikiTargets,
  searchWithFilters,
}))
vi.mock('@/lib/use-embed-status', () => ({
  // The model is absent in these tests: the palette is exactly the lexical
  // surface it was before Plan 09 (hybrid mode is additive).
  useEmbedStatus: () => ({ status: 'uninitialized' }),
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', cloudSync: null, generation: 1 } }),
}))
// Register after the core mock is installed so commands see the mocked graph.
const { registerAppCommands } = await import('@/lib/commands/app-commands')
registerAppCommands()

// RTL auto-cleanup isn't wired globally in this project: without this, a
// previous test's still-mounted palette leaks into the next test's
// document.body queries (e.g. its settled "No results").
afterEach(cleanup)

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
    back: vi.fn(),
    forward: vi.fn(),
    toggleTheme: vi.fn(),
    toggleSidebar: vi.fn(),
    generation: () => 1,
    openPalette: vi.fn(),
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
    expect(view.getByText('Monday, June 8')).toBeDefined() // dailies keep labels
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
    await view.findByText('Tuesday, June 9')

    await userEvent.keyboard('{Enter}')
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ kind: 'daily', date: '2026-06-09' }),
    )
  })
})
