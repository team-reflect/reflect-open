import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  untitledNotePath,
  type GraphInfo,
  type PinnedNote,
  type Settings,
} from '@reflect/core'
import type { CommandContext } from '@/lib/commands/types'
import type { Route } from '@/routing/route'
import { TooltipProvider } from '@/components/ui/tooltip'
import { UpdateProvider } from '@/providers/update-provider'
import { RouterProvider } from '@/routing/router'

const getPinnedNotes = vi.hoisted(() => vi.fn<() => Promise<PinnedNote[]>>(async () => []))
const revealItemInDir = vi.hoisted(() => vi.fn<(path: string) => Promise<void>>(async () => {}))
const openRecent = vi.hoisted(() => vi.fn())
const pickAndOpen = vi.hoisted(() => vi.fn())
const chooseGraph = vi.hoisted(() => vi.fn())
interface NativeContextMenuItemForTest {
  text: string
  action: () => void
}

interface NativeContextMenuOptionsForTest {
  items: NativeContextMenuItemForTest[]
}

const openNativeContextMenu = vi.hoisted(() =>
  vi.fn(async (options: NativeContextMenuOptionsForTest) => {
    options.items[0]?.action()
  }),
)
const unpinNote = vi.hoisted(() => vi.fn(async () => {}))
const updateSettingsWith = vi.hoisted(() =>
  vi.fn<(updater: (current: Settings) => Partial<Settings>) => void>(),
)

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getPinnedNotes,
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ revealItemInDir }))
vi.mock('@/lib/native-menu/context-menu', () => ({ openNativeContextMenu }))
vi.mock('@/lib/note-pin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/note-pin')>()),
  unpinNote,
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
    chooseGraph,
  }),
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: { dateFormat: 'mdy', graphColors: {} },
    updateSettings: () => {},
    updateSettingsWith,
  }),
}))
vi.mock('@/providers/sync-provider', () => ({
  useSync: () => ({
    backup: { phase: 'disconnected' },
    connectNewRepo: async () => {},
    connectExistingRepo: async () => 'connected',
    disconnectGraph: async () => {},
    signOut: async () => {},
    backUpNow: async () => {},
  }),
}))

const audioMemo = vi.hoisted(() => ({
  phase: 'idle' as const,
  elapsedMs: 0,
  stream: null,
  available: true,
  unavailableReason: null as string | null,
  error: null,
  canRetry: false,
  toggle: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
  discard: vi.fn(),
}))
vi.mock('@/providers/audio-memo-provider', () => ({
  useAudioMemo: () => audioMemo,
}))

const GRAPH: GraphInfo = { root: '/notes', name: 'Notes', generation: 1 }

// Import after the core mock so the command registry sees the mocked module.
const { Sidebar } = await import('./sidebar')
const { registerAppCommands } = await import('@/lib/commands/app-commands')
registerAppCommands()

beforeEach(() => {
  // The hoisted mock is shared module state — restore it so mic-related cases
  // can't inherit mutations from earlier tests.
  getPinnedNotes.mockReset().mockResolvedValue([])
  audioMemo.available = true
  audioMemo.unavailableReason = null
  audioMemo.toggle.mockReset()
  revealItemInDir.mockClear()
  openRecent.mockClear()
  pickAndOpen.mockClear()
  chooseGraph.mockClear()
  openNativeContextMenu.mockClear()
  unpinNote.mockClear()
})

afterEach(cleanup) // `globals: false` disables testing-library's automatic cleanup

function renderSidebar(overrides?: Partial<CommandContext>, initialRoute?: Route) {
  const navigate = vi.fn()
  const openPalette = vi.fn()
  const context: CommandContext = {
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
    openPalette,
    openShortcuts: vi.fn(),
    openTemplatePicker: vi.fn(),
    openTemplateCreate: vi.fn(),
    enableSemanticSearch: vi.fn(),
    ...overrides,
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <TooltipProvider>
      <QueryClientProvider client={client}>
        <UpdateProvider autoCheck={false}>
          <RouterProvider initialRoute={initialRoute}>
            <Sidebar graph={GRAPH} context={context} />
          </RouterProvider>
        </UpdateProvider>
      </QueryClientProvider>
    </TooltipProvider>,
  )
  return { view, navigate, openPalette, context }
}

describe('Sidebar', () => {
  it('nav rows navigate, with Daily notes restoring its surface scroll', async () => {
    const { view, navigate } = renderSidebar()

    // The Daily row is a capture gesture: it asks for editor focus (the
    // stream appends at today's end), while a genuine off-surface return
    // still restores the stream's saved position instead.
    await userEvent.click(view.getByRole('button', { name: /daily notes/i }))
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        { kind: 'today' },
        { restoreSurfaceScroll: true, focusEditor: true },
      ),
    )

    await userEvent.click(view.getByRole('button', { name: /settings/i }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ kind: 'settings' }))

    await userEvent.click(view.getByRole('button', { name: /chat/i }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ kind: 'chat' }))
  })

  it('New note runs its command and shows active while the placeholder note is open', async () => {
    // The route a ⌘N/new-note click lands on: a fresh ULID placeholder path.
    const { view, navigate } = renderSidebar(undefined, {
      kind: 'note',
      path: untitledNotePath(),
    })
    const newNote = view.getByRole('button', { name: /new note/i })

    // Active like every other row whose route is current — until the birth
    // rename moves the note onto a title slug.
    expect(newNote.getAttribute('aria-current')).toBe('page')

    await userEvent.click(newNote)
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'note', path: expect.stringMatching(/^notes\/.+\.md$/) }),
      ),
    )
  })

  it('New note is inactive on slug-named note routes', () => {
    const { view } = renderSidebar(undefined, { kind: 'note', path: 'notes/meeting.md' })
    expect(
      view.getByRole('button', { name: /new note/i }).getAttribute('aria-current'),
    ).toBeNull()
  })

  it('All notes stays active while editing a slug-named note', () => {
    const { view } = renderSidebar(undefined, { kind: 'note', path: 'notes/meeting.md' })
    expect(
      view.getByRole('button', { name: /all notes/i }).getAttribute('aria-current'),
    ).toBe('page')
  })

  it('only "New note" — not "All notes" — lights for the untitled placeholder', () => {
    // A brand-new note is still an untitled placeholder, so the two rows must
    // never light at once.
    const { view } = renderSidebar(undefined, { kind: 'note', path: untitledNotePath() })
    expect(
      view.getByRole('button', { name: /new note/i }).getAttribute('aria-current'),
    ).toBe('page')
    expect(
      view.getByRole('button', { name: /all notes/i }).getAttribute('aria-current'),
    ).toBeNull()
  })

  it('the search affordance opens the palette', async () => {
    const { view, openPalette } = renderSidebar()
    await userEvent.click(view.getByRole('button', { name: /search anything/i }))
    expect(openPalette).toHaveBeenCalled()
  })

  it('the mic button starts an audio memo', async () => {
    const { view } = renderSidebar()
    await userEvent.click(view.getByRole('button', { name: /record audio memo/i }))
    expect(audioMemo.toggle).toHaveBeenCalled()
  })

  it('the mic button disables (without vanishing) when no provider can transcribe', async () => {
    audioMemo.available = false
    audioMemo.unavailableReason = 'Add an OpenAI or Gemini model in Settings to record audio memos'
    const { view } = renderSidebar()
    const micButton = view.getByRole('button', { name: /record audio memo/i })
    expect(micButton.getAttribute('aria-disabled')).toBe('true')
    await userEvent.click(micButton)
    expect(audioMemo.toggle).not.toHaveBeenCalled()
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
    const roadmapPreview = roadmap.firstElementChild
    expect(roadmapPreview?.getAttribute('class')).toContain('hover:bg-surface-hover')
    expect(roadmapPreview?.getAttribute('class')).toContain('hover:text-text')
    await userEvent.click(roadmap)
    await waitFor(() => expect(roadmap.getAttribute('aria-current')).toBe('page'))
  })

  it('renders wiki links in pinned note titles as display text', async () => {
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/meeting.md', title: 'Meeting with [[Ada Lovelace|Ada]]', dailyDate: null },
    ])
    const { view } = renderSidebar()

    const pinnedSection = await view.findByRole('region', { name: /pinned notes/i })
    expect(pinnedSection.textContent).toContain('Meeting with Ada')
    expect(pinnedSection.textContent).not.toContain('[[Ada Lovelace|Ada]]')
    expect(view.getByRole('button', { name: 'Meeting with Ada' })).toBeTruthy()
  })

  it('All notes is inactive while the active note is pinned', async () => {
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/roadmap.md', title: 'Roadmap', dailyDate: null },
    ])
    const { view } = renderSidebar(undefined, { kind: 'note', path: 'notes/roadmap.md' })

    const roadmap = await view.findByRole('button', { name: 'Roadmap' })
    await waitFor(() => expect(roadmap.getAttribute('aria-current')).toBe('page'))
    expect(
      view.getByRole('button', { name: /all notes/i }).getAttribute('aria-current'),
    ).toBeNull()
  })

  it('the pinned section is hidden while nothing is pinned', async () => {
    getPinnedNotes.mockResolvedValue([])
    const { view } = renderSidebar()
    await waitFor(() => expect(getPinnedNotes).toHaveBeenCalled())
    expect(view.queryByRole('region', { name: /pinned notes/i })).toBeNull()
  })

  it('right-click unpins a pinned row through the native context menu', async () => {
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/rust.md', title: 'Rust', dailyDate: null },
    ])
    const { view } = renderSidebar()
    const rust = await view.findByRole('button', { name: 'Rust' })

    fireEvent.contextMenu(rust)

    await waitFor(() => expect(openNativeContextMenu).toHaveBeenCalledWith({
      items: [
        expect.objectContaining({
          text: 'Unpin Note',
        }),
      ],
    }))
    await waitFor(() => expect(view.queryByRole('button', { name: 'Rust' })).toBeNull())
    expect(unpinNote).toHaveBeenCalledWith('notes/rust.md', 1)
  })

  it('restores an optimistically removed pinned row when unpin fails', async () => {
    unpinNote.mockRejectedValueOnce(new Error('disk failed'))
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/rust.md', title: 'Rust', dailyDate: null },
    ])
    const { view } = renderSidebar()
    const rust = await view.findByRole('button', { name: 'Rust' })

    fireEvent.contextMenu(rust)

    await waitFor(() => expect(unpinNote).toHaveBeenCalledWith('notes/rust.md', 1))
    await waitFor(() => expect(view.getByRole('button', { name: 'Rust' })).toBeTruthy())
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
    const work = view.getByRole('menuitem', { name: 'Work' })
    expect([...work.querySelectorAll('kbd')].map((keycap) => keycap.textContent)).toContain('2')
    await userEvent.click(work)
    expect(openRecent).toHaveBeenCalledWith('/work')

    await userEvent.click(view.getByRole('button', { name: /Notes/ }))
    await userEvent.click(view.getByRole('menuitem', { name: /open another graph/i }))
    expect(chooseGraph).toHaveBeenCalled()
    expect(pickAndOpen).not.toHaveBeenCalled()
  })

  it('the graph footer opens user settings from the graph menu', async () => {
    const { view, navigate } = renderSidebar()

    await userEvent.click(view.getByRole('button', { name: /Notes/ }))
    await userEvent.click(view.getByRole('menuitem', { name: /user settings/i }))

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ kind: 'settings' }))
  })

  it('the graph footer opens the current graph in the system file manager', async () => {
    const { view } = renderSidebar()

    await userEvent.click(view.getByRole('button', { name: /Notes/ }))
    await userEvent.click(view.getByRole('menuitem', { name: /reveal graph in finder/i }))

    expect(revealItemInDir).toHaveBeenCalledWith('/notes')
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
