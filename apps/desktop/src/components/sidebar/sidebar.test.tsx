import { cleanup, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphInfo, PinnedNote } from '@reflect/core'
import type { CommandContext } from '@/lib/commands/types'
import { RouterProvider } from '@/routing/router'

const getPinnedNotes = vi.hoisted(() => vi.fn<() => Promise<PinnedNote[]>>(async () => []))
const openRecent = vi.hoisted(() => vi.fn())
const pickAndOpen = vi.hoisted(() => vi.fn())

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getPinnedNotes,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    graph: GRAPH,
    recents: [
      { root: '/notes', name: 'Notes', openedMs: 2 },
      { root: '/work', name: 'Work', openedMs: 1 },
    ],
    indexing: false,
    openRecent,
    pickAndOpen,
  }),
}))

const GRAPH: GraphInfo = { root: '/notes', name: 'Notes', cloudSync: null, generation: 1 }

// Import after the core mock so the command registry sees the mocked module.
const { Sidebar } = await import('./sidebar')
const { registerAppCommands } = await import('@/lib/commands/app-commands')
registerAppCommands()

afterEach(cleanup) // `globals: false` disables testing-library's automatic cleanup

function renderSidebar(overrides?: Partial<CommandContext>) {
  const navigate = vi.fn()
  const openPalette = vi.fn()
  const context: CommandContext = {
    navigate,
    route: () => ({ kind: 'today' }),
    back: vi.fn(),
    forward: vi.fn(),
    toggleTheme: vi.fn(),
    toggleSidebar: vi.fn(),
    generation: () => 1,
    openPalette,
    enableSemanticSearch: vi.fn(),
    ...overrides,
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider>
        <Sidebar graph={GRAPH} context={context} />
      </RouterProvider>
    </QueryClientProvider>,
  )
  return { view, navigate, openPalette, context }
}

describe('Sidebar', () => {
  it('nav rows run their registered commands', async () => {
    const { view, navigate } = renderSidebar()

    await userEvent.click(view.getByRole('button', { name: /today/i }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ kind: 'today' }))

    await userEvent.click(view.getByRole('button', { name: /settings/i }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ kind: 'settings' }))
  })

  it('the search affordance opens the palette', async () => {
    const { view, openPalette } = renderSidebar()
    await userEvent.click(view.getByRole('button', { name: /search anything/i }))
    expect(openPalette).toHaveBeenCalled()
  })

  it('pinned notes render their own section', async () => {
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/roadmap.md', title: 'Roadmap', dailyDate: null },
    ])
    const { view } = renderSidebar()

    const pinnedSection = await waitFor(() => {
      const section = view.getByRole('region', { name: /pinned notes/i })
      expect(section.textContent).toContain('Roadmap')
      return section
    })
    expect(view.getAllByRole('button', { name: 'Roadmap' })).toHaveLength(1)

    const roadmap = await view.findByRole('button', { name: 'Roadmap' })
    expect(pinnedSection.contains(roadmap)).toBe(true)
    await userEvent.click(roadmap)
    await waitFor(() => expect(roadmap.getAttribute('aria-current')).toBe('page'))
  })

  it('the pinned section is hidden while nothing is pinned', async () => {
    getPinnedNotes.mockResolvedValue([])
    const { view } = renderSidebar()
    await waitFor(() => expect(getPinnedNotes).toHaveBeenCalled())
    expect(view.queryByRole('region', { name: /pinned notes/i })).toBeNull()
  })

  it('the graph footer switches to another recent graph', async () => {
    const { view } = renderSidebar()

    await userEvent.click(view.getByRole('button', { name: /Notes/ }))
    await userEvent.click(view.getByRole('menuitem', { name: 'Work' }))
    expect(openRecent).toHaveBeenCalledWith('/work')

    await userEvent.click(view.getByRole('button', { name: /Notes/ }))
    await userEvent.click(view.getByRole('menuitem', { name: /open another graph/i }))
    expect(pickAndOpen).toHaveBeenCalled()
  })
})
