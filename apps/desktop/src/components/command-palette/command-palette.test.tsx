import { render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { useEffect } from 'react'
import type { CommandContext } from '@/lib/commands/types'
import { CommandPalette } from './command-palette'
import { PaletteProvider, usePalette } from './palette-provider'

const suggestWikiTargets = vi.hoisted(() => vi.fn())
const searchNotesRanked = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  suggestWikiTargets,
  searchNotesRanked,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', cloudSync: null, generation: 1 } }),
}))
// Import after the core mock so registration sees the mocked module graph.
await import('@/lib/commands/app-commands')

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
    searchNotesRanked.mockResolvedValue([
      { path: 'notes/rust.md', title: 'Rust Notes', snippet: 'about rust things' },
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
    searchNotesRanked.mockResolvedValue([])
    const { view } = renderPalette('> toggle theme')
    await view.findByText('Toggle theme')
    expect(view.queryByText('Notes')).toBeNull()
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
    searchNotesRanked.mockResolvedValue([])
    const { view, navigate } = renderPalette('2026-06-09')
    await view.findByText('Tuesday, June 9')

    await userEvent.keyboard('{Enter}')
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ kind: 'daily', date: '2026-06-09' }),
    )
  })
})
