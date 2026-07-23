import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  untitledNotePath,
  type GraphInfo,
  type PinnedNote,
  type Settings,
} from '@reflect/core'
import type { CommandContext } from '@/lib/commands/types'
import type { NoteRoute, Route } from '@/routing/route'
import { TooltipProvider } from '@/components/ui/tooltip'
import { UpdateProvider } from '@/providers/update-provider'
import { RouterProvider } from '@/routing/router'
import { expectLocatorToHaveCount } from '@/test-utils/expect'

const getPinnedNotes = vi.hoisted(() => vi.fn<() => Promise<PinnedNote[]>>(async () => []))
const revealItemInDir = vi.hoisted(() => vi.fn<(path: string) => Promise<void>>(async () => {}))
const openRouteInNewWindow = vi.hoisted(() =>
  vi.fn<(route: NoteRoute) => Promise<boolean>>(),
)
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
vi.mock('@/lib/windows/open-in-new-window', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/windows/open-in-new-window')>()),
  openRouteInNewWindow,
}))
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
  openRouteInNewWindow.mockReset().mockResolvedValue(true)
  openRecent.mockClear()
  pickAndOpen.mockClear()
  chooseGraph.mockClear()
  openNativeContextMenu.mockClear()
  unpinNote.mockClear()
})

async function renderSidebar(overrides?: Partial<CommandContext>, initialRoute?: Route) {
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
  // The app constrains the sidebar to its rail width; without it the graph
  // menu's anchor spans the viewport and popper pushes the submenu off-screen.
  const view = await render(
    <div style={{ width: 260, height: 560 }}>
      <TooltipProvider>
        <QueryClientProvider client={client}>
          <UpdateProvider autoCheck={false}>
            <RouterProvider initialRoute={initialRoute}>
              <Sidebar graph={GRAPH} context={context} />
            </RouterProvider>
          </UpdateProvider>
        </QueryClientProvider>
      </TooltipProvider>
    </div>,
  )
  return { view, navigate, openPalette, context }
}

describe('Sidebar', () => {
  it('nav rows navigate, with Daily notes always re-anchoring to today', async () => {
    const { view, navigate } = await renderSidebar(undefined, { kind: 'settings' })

    // The Daily row shares the ⌘D capture command: omitting
    // `restoreSurfaceScroll` makes even an off-surface return discard the
    // stream's saved position and re-anchor on today.
    await view.getByRole('button', { name: /daily notes/i }).click()
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ kind: 'today' }, { focusEditor: true }),
    )

    await view.getByRole('button', { name: /settings/i }).click()
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ kind: 'settings' }))

    await view.getByRole('button', { name: /chat/i }).click()
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ kind: 'chat' }))
  })

  it('New note runs its command and shows active while the placeholder note is open', async () => {
    // The route a ⌘N/new-note click lands on: a fresh ULID placeholder path.
    const { view, navigate } = await renderSidebar(undefined, {
      kind: 'note',
      path: untitledNotePath(),
    })
    const newNote = view.getByRole('button', { name: /new note/i })

    // Active like every other row whose route is current — until the birth
    // rename moves the note onto a title slug.
    await expect.element(newNote).toHaveAttribute('aria-current', 'page')

    await newNote.click()
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'note', path: expect.stringMatching(/^notes\/.+\.md$/) }),
      ),
    )
  })

  it('New note is inactive on slug-named note routes', async () => {
    const { view } = await renderSidebar(undefined, { kind: 'note', path: 'notes/meeting.md' })
    await expect
      .element(view.getByRole('button', { name: /new note/i }))
      .not.toHaveAttribute('aria-current')
  })

  it('All notes stays active while editing a slug-named note', async () => {
    const { view } = await renderSidebar(undefined, { kind: 'note', path: 'notes/meeting.md' })
    await expect
      .element(view.getByRole('button', { name: /all notes/i }))
      .toHaveAttribute('aria-current', 'page')
  })

  it('only "New note" — not "All notes" — lights for the untitled placeholder', async () => {
    // A brand-new note is still an untitled placeholder, so the two rows must
    // never light at once.
    const { view } = await renderSidebar(undefined, { kind: 'note', path: untitledNotePath() })
    await expect
      .element(view.getByRole('button', { name: /new note/i }))
      .toHaveAttribute('aria-current', 'page')
    await expect
      .element(view.getByRole('button', { name: /all notes/i }))
      .not.toHaveAttribute('aria-current')
  })

  it('the search affordance opens the palette', async () => {
    const { view, openPalette } = await renderSidebar()
    await view.getByRole('button', { name: /search anything/i }).click()
    expect(openPalette).toHaveBeenCalled()
  })

  it('the mic button starts an audio memo', async () => {
    const { view } = await renderSidebar()
    await view.getByRole('button', { name: /record audio memo/i }).click()
    expect(audioMemo.toggle).toHaveBeenCalled()
  })

  it('the mic button disables (without vanishing) when no provider can transcribe', async () => {
    audioMemo.available = false
    audioMemo.unavailableReason = 'Add an OpenAI or Gemini model in Settings to record audio memos'
    const { view } = await renderSidebar()
    const micButton = view.getByRole('button', { name: /record audio memo/i })
    await expect.element(micButton).toHaveAttribute('aria-disabled', 'true')
    // `aria-disabled` fails Playwright's enabled actionability check, but the
    // element still receives real clicks — force past the check.
    await micButton.click({ force: true })
    expect(audioMemo.toggle).not.toHaveBeenCalled()
  })

  it('pinned notes render their own section', async () => {
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/roadmap.md', title: 'Roadmap', dailyDate: null },
    ])
    const { view } = await renderSidebar()

    const pinnedSection = view.getByRole('region', { name: /pinned notes/i })
    await expect.element(pinnedSection).toHaveTextContent('Roadmap')
    await expectLocatorToHaveCount(view.getByRole('button', { name: 'Roadmap' }), 1)

    const roadmap = pinnedSection.getByRole('button', { name: 'Roadmap' })
    await expect.element(roadmap).toBeInTheDocument()
    const roadmapPreview = roadmap.element().firstElementChild
    expect(roadmapPreview?.getAttribute('class')).toContain('hover:bg-surface-hover')
    expect(roadmapPreview?.getAttribute('class')).toContain('hover:text-text')
    await roadmap.click()
    await expect.element(roadmap).toHaveAttribute('aria-current', 'page')
  })

  it('modifier-click opens a pinned note in a new window without changing routes', async () => {
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/roadmap.md', title: 'Roadmap', dailyDate: null },
    ])
    const { view } = await renderSidebar()
    const roadmap = view.getByRole('button', { name: 'Roadmap' })

    await roadmap.click({ modifiers: ['Meta'] })

    await vi.waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({
        kind: 'note',
        path: 'notes/roadmap.md',
      }),
    )
    expect(openRouteInNewWindow).toHaveBeenCalledTimes(1)
    await expect.element(roadmap).not.toHaveAttribute('aria-current')
  })

  it('renders wiki links in pinned note titles as display text', async () => {
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/meeting.md', title: 'Meeting with [[Ada Lovelace|Ada]]', dailyDate: null },
    ])
    const { view } = await renderSidebar()

    const pinnedSection = view.getByRole('region', { name: /pinned notes/i })
    await expect.element(pinnedSection).toHaveTextContent('Meeting with Ada')
    expect(pinnedSection.element().textContent).not.toContain('[[Ada Lovelace|Ada]]')
    await expect
      .element(view.getByRole('button', { name: 'Meeting with Ada' }))
      .toBeInTheDocument()
  })

  it('All notes is inactive while the active note is pinned', async () => {
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/roadmap.md', title: 'Roadmap', dailyDate: null },
    ])
    const { view } = await renderSidebar(undefined, { kind: 'note', path: 'notes/roadmap.md' })

    const roadmap = view.getByRole('button', { name: 'Roadmap' })
    await expect.element(roadmap).toHaveAttribute('aria-current', 'page')
    await expect
      .element(view.getByRole('button', { name: /all notes/i }))
      .not.toHaveAttribute('aria-current')
  })

  it('the pinned section is hidden while nothing is pinned', async () => {
    getPinnedNotes.mockResolvedValue([])
    const { view } = await renderSidebar()
    await vi.waitFor(() => expect(getPinnedNotes).toHaveBeenCalled())
    expect(view.getByRole('region', { name: /pinned notes/i }).query()).toBeNull()
  })

  it('right-click unpins a pinned row through the native context menu', async () => {
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/rust.md', title: 'Rust', dailyDate: null },
    ])
    const { view } = await renderSidebar()
    const rust = view.getByRole('button', { name: 'Rust' })

    await rust.click({ button: 'right' })

    await vi.waitFor(() => expect(openNativeContextMenu).toHaveBeenCalledWith({
      items: [
        expect.objectContaining({
          text: 'Unpin Note',
        }),
      ],
    }))
    await expectLocatorToHaveCount(view.getByRole('button', { name: 'Rust' }), 0)
    expect(unpinNote).toHaveBeenCalledWith('notes/rust.md', 1)
  })

  it('restores an optimistically removed pinned row when unpin fails', async () => {
    unpinNote.mockRejectedValueOnce(new Error('disk failed'))
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/rust.md', title: 'Rust', dailyDate: null },
    ])
    const { view } = await renderSidebar()
    const rust = view.getByRole('button', { name: 'Rust' })

    await rust.click({ button: 'right' })

    await vi.waitFor(() => expect(unpinNote).toHaveBeenCalledWith('notes/rust.md', 1))
    await expect.element(view.getByRole('button', { name: 'Rust' })).toBeInTheDocument()
  })

  it('history arrows walk the router stack and disable at its edges', async () => {
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/rust.md', title: 'Rust', dailyDate: null },
    ])
    const { view } = await renderSidebar()
    const backButton = view.getByRole('button', { name: 'Go back' })
    const forwardButton = view.getByRole('button', { name: 'Go forward' })
    await expect.element(backButton).toBeDisabled()
    await expect.element(forwardButton).toBeDisabled()

    // Pinned rows push onto the real router, enabling history navigation.
    const rust = view.getByRole('button', { name: 'Rust' })
    await rust.click()
    await expect.element(backButton).toBeEnabled()

    await backButton.click()
    await expect.element(rust).not.toHaveAttribute('aria-current')
    await expect.element(forwardButton).toBeEnabled()

    await forwardButton.click()
    await expect.element(rust).toHaveAttribute('aria-current', 'page')
  })

  it('the graph footer switches to another recent graph', async () => {
    const { view } = await renderSidebar()

    await view.getByRole('button', { name: /Notes/ }).click()
    const work = page.getByRole('menuitem', { name: 'Work' })
    await expect.element(work).toBeVisible()
    expect([...work.element().querySelectorAll('kbd')].map((keycap) => keycap.textContent)).toContain('2')
    await work.click()
    expect(openRecent).toHaveBeenCalledWith('/work')

    await view.getByRole('button', { name: /Notes/ }).click()
    await page.getByRole('menuitem', { name: /open another graph/i }).click()
    expect(chooseGraph).toHaveBeenCalled()
    expect(pickAndOpen).not.toHaveBeenCalled()
  })

  it('the graph footer opens user settings from the graph menu', async () => {
    const { view, navigate } = await renderSidebar()

    await view.getByRole('button', { name: /Notes/ }).click()
    await page.getByRole('menuitem', { name: /user settings/i }).click()

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ kind: 'settings' }))
  })

  it('the graph footer opens the current graph in the system file manager', async () => {
    const { view } = await renderSidebar()

    await view.getByRole('button', { name: /Notes/ }).click()
    await page.getByRole('menuitem', { name: /reveal graph in finder/i }).click()

    expect(revealItemInDir).toHaveBeenCalledWith('/notes')
  })

  it('the graph footer recolors the current graph', async () => {
    const { view } = await renderSidebar()

    await view.getByRole('button', { name: /Notes/ }).click()
    await page.getByRole('menuitem', { name: 'Graph color' }).click()
    await page.getByRole('menuitem', { name: 'Teal' }).click()
    await vi.waitFor(() => expect(updateSettingsWith).toHaveBeenCalled())

    // The patch composes over the latest settings at apply time — feed the
    // updater a document and check the record it builds.
    const updater = updateSettingsWith.mock.lastCall?.[0]
    expect(updater?.(DEFAULT_SETTINGS)).toEqual({ graphColors: { '/notes': 'teal' } })
  })
})
