import { cleanup, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type GraphInfo, type PinnedNote, type Settings } from '@reflect/core'
import type { CommandContext } from '@/lib/commands/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { RouterProvider } from '@/routing/router'

const getPinnedNotes = vi.hoisted(() => vi.fn<() => Promise<PinnedNote[]>>(async () => []))
const openRecent = vi.hoisted(() => vi.fn())
const pickAndOpen = vi.hoisted(() => vi.fn())
const updateSettingsWith = vi.hoisted(() =>
  vi.fn<(updater: (current: Settings) => Partial<Settings>) => void>(),
)

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
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: { dateFormat: 'mdy', graphColors: {} },
    updateSettings: () => {},
    updateSettingsWith,
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
    <TooltipProvider>
      <QueryClientProvider client={client}>
        <RouterProvider>
          <Sidebar graph={GRAPH} context={context} />
        </RouterProvider>
      </QueryClientProvider>
    </TooltipProvider>,
  )
  return { view, navigate, openPalette, context }
}

describe('Sidebar', () => {
  it('nav rows run their registered commands', async () => {
    const { view, navigate } = renderSidebar()

    await userEvent.click(view.getByRole('button', { name: /daily notes/i }))
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

  it('history arrows walk the router stack and disable at its edges', async () => {
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/rust.md', title: 'Rust', dailyDate: null },
    ])
    const { view } = renderSidebar()
    const backButton = view.getByRole('button', { name: 'Go back' })
    const forwardButton = view.getByRole('button', { name: 'Go forward' })
    expect(backButton).toHaveProperty('disabled', true)
    expect(forwardButton).toHaveProperty('disabled', true)

    // Pinned rows push onto the real router, enabling history navigation.
    const rust = await view.findByRole('button', { name: 'Rust' })
    await userEvent.click(rust)
    await waitFor(() => expect(backButton).toHaveProperty('disabled', false))

    await userEvent.click(backButton)
    await waitFor(() => expect(rust.getAttribute('aria-current')).toBeNull())
    expect(forwardButton).toHaveProperty('disabled', false)

    await userEvent.click(forwardButton)
    await waitFor(() => expect(rust.getAttribute('aria-current')).toBe('page'))
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

  it('the graph footer recolors the current graph', async () => {
    const { view } = renderSidebar()

    await userEvent.click(view.getByRole('button', { name: /Notes/ }))
    await userEvent.click(view.getByRole('menuitem', { name: 'Graph color' }))
    await userEvent.click(await view.findByRole('menuitem', { name: 'Teal' }))

    // The patch composes over the latest settings at apply time — feed the
    // updater a document and check the record it builds.
    const updater = updateSettingsWith.mock.lastCall?.[0]
    expect(updater?.(DEFAULT_SETTINGS)).toEqual({ graphColors: { '/notes': 'teal' } })
  })
})
