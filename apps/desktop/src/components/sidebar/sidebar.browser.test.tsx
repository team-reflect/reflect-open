import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { DEFAULT_SETTINGS, type GraphInfo, type PinnedNote, type Settings } from '@reflect/core'
import type { CommandContext } from '@/lib/commands/types'
import { act } from '@/test-utils/act'
import { untitledNotePath } from '@/lib/create-note'
import type { Route } from '@/routing/route'
import { TooltipProvider } from '@/components/ui/tooltip'
import { UpdateProvider } from '@/providers/update-provider'
import { RouterProvider } from '@/routing/router'

const getPinnedNotes = vi.hoisted(() => vi.fn<() => Promise<PinnedNote[]>>(async () => []))
const revealItemInDir = vi.hoisted(() => vi.fn<(path: string) => Promise<void>>(async () => {}))
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
vi.mock('@tauri-apps/plugin-opener', () => ({ revealItemInDir }))
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

const GRAPH: GraphInfo = { root: '/notes', name: 'Notes', cloudSync: null, generation: 1 }

// Import after the core mock so the command registry sees the mocked module.
const { Sidebar } = await import('./sidebar')
const { registerAppCommands } = await import('@/lib/commands/app-commands')
registerAppCommands()

beforeEach(() => {
  // The hoisted mock is shared module state, so restore it so mic-related cases
  // can't inherit mutations from earlier tests.
  audioMemo.available = true
  audioMemo.unavailableReason = null
  audioMemo.toggle.mockReset()
  revealItemInDir.mockClear()
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
    toggleTheme: vi.fn(),
    toggleSidebar: vi.fn(),
    newChat: vi.fn(),
    toggleAudioMemo: vi.fn(),
    generation: () => 1,
    openPalette,
    openShortcuts: vi.fn(),
    enableSemanticSearch: vi.fn(),
    ...overrides,
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = await render(
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
  it('nav rows run their registered commands', async () => {
    const { view, navigate } = await renderSidebar()

    await userEvent.click(view.getByRole('button', { name: /daily notes/i }))
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ kind: 'today' }))

    await userEvent.click(view.getByRole('button', { name: /settings/i }))
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ kind: 'settings' }))

    await userEvent.click(view.getByRole('button', { name: /chat/i }))
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ kind: 'chat' }))
  })

  it('New note runs its command and shows active while the placeholder note is open', async () => {
    // The route a ⌘N/new-note click lands on: a fresh ULID placeholder path.
    const { view, navigate } = await renderSidebar(undefined, {
      kind: 'note',
      path: untitledNotePath(),
    })
    const newNote = view.getByRole('button', { name: /new note/i })

    // Active like every other row whose route is current, until the birth
    // rename moves the note onto a title slug.
    expect(newNote.element().getAttribute('aria-current')).toBe('page')

    await userEvent.click(newNote)
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'note', path: expect.stringMatching(/^notes\/.+\.md$/) }),
      ),
    )
  })

  it('New note is inactive on slug-named note routes', async () => {
    const { view } = await renderSidebar(undefined, { kind: 'note', path: 'notes/meeting.md' })
    expect(
      view.getByRole('button', { name: /new note/i }).element().getAttribute('aria-current'),
    ).toBeNull()
  })

  it('All notes stays active while editing a slug-named note', async () => {
    const { view } = await renderSidebar(undefined, { kind: 'note', path: 'notes/meeting.md' })
    expect(
      view.getByRole('button', { name: /all notes/i }).element().getAttribute('aria-current'),
    ).toBe('page')
  })

  it('only "New note", not "All notes", lights for the untitled placeholder', async () => {
    // A brand-new note is still an untitled placeholder, so the two rows must
    // never light at once.
    const { view } = await renderSidebar(undefined, { kind: 'note', path: untitledNotePath() })
    expect(
      view.getByRole('button', { name: /new note/i }).element().getAttribute('aria-current'),
    ).toBe('page')
    expect(
      view.getByRole('button', { name: /all notes/i }).element().getAttribute('aria-current'),
    ).toBeNull()
  })

  it('the search affordance opens the palette', async () => {
    const { view, openPalette } = await renderSidebar()
    await userEvent.click(view.getByRole('button', { name: /search anything/i }))
    expect(openPalette).toHaveBeenCalled()
  })

  it('the mic button starts an audio memo', async () => {
    const { view } = await renderSidebar()
    await userEvent.click(view.getByRole('button', { name: /record audio memo/i }))
    expect(audioMemo.toggle).toHaveBeenCalled()
  })

  it('the mic button disables (without vanishing) when no provider can transcribe', async () => {
    audioMemo.available = false
    audioMemo.unavailableReason = 'Add an OpenAI or Gemini model in Settings to record audio memos'
    const { view } = await renderSidebar()
    const micButton = view.getByRole('button', { name: /record audio memo/i })
    expect(micButton.element().getAttribute('aria-disabled')).toBe('true')
    // Native click, not userEvent: Playwright treats aria-disabled as
    // un-clickable and would time out; the point is the handler ignores a click.
    const micEl = micButton.element() as HTMLElement
    micEl.click()
    expect(audioMemo.toggle).not.toHaveBeenCalled()
  })

  it('pinned notes render their own section', async () => {
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/roadmap.md', title: 'Roadmap', dailyDate: null },
    ])
    const { view } = await renderSidebar()

    const pinnedSection = view.getByRole('region', { name: /pinned notes/i })
    await expect.element(pinnedSection).toHaveTextContent('Roadmap')
    await expect.element(view.getByRole('button', { name: 'Roadmap' })).toHaveLength(1)

    const roadmap = view.getByRole('button', { name: 'Roadmap' })
    expect(pinnedSection.element().contains(roadmap.element())).toBe(true)
    await userEvent.click(roadmap)
    await vi.waitFor(() => expect(roadmap.element().getAttribute('aria-current')).toBe('page'))
  })

  it('the pinned section is hidden while nothing is pinned', async () => {
    getPinnedNotes.mockResolvedValue([])
    const { view } = await renderSidebar()
    await vi.waitFor(() => expect(getPinnedNotes).toHaveBeenCalled())
    await expect.element(view.getByRole('region', { name: /pinned notes/i })).not.toBeInTheDocument()
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
    await userEvent.click(rust)
    await expect.element(backButton).toBeEnabled()

    await userEvent.click(backButton)
    await vi.waitFor(() => expect(rust.element().getAttribute('aria-current')).toBeNull())
    await expect.element(forwardButton).toBeEnabled()

    await userEvent.click(forwardButton)
    await vi.waitFor(() => expect(rust.element().getAttribute('aria-current')).toBe('page'))
  })

  it('the graph footer switches to another recent graph', async () => {
    const { view } = await renderSidebar()

    await userEvent.click(view.getByRole('button', { name: /Notes/ }))
    await userEvent.click(view.getByRole('menuitem', { name: 'Work' }))
    expect(openRecent).toHaveBeenCalledWith('/work')

    await userEvent.click(view.getByRole('button', { name: /Notes/ }))
    await userEvent.click(view.getByRole('menuitem', { name: /open another graph/i }))
    expect(pickAndOpen).toHaveBeenCalled()
  })

  it('the graph footer opens user settings from the graph menu', async () => {
    const { view, navigate } = await renderSidebar()

    await userEvent.click(view.getByRole('button', { name: /Notes/ }))
    await userEvent.click(view.getByRole('menuitem', { name: /user settings/i }))

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ kind: 'settings' }))
  })

  it('the graph footer opens the current graph in the system file manager', async () => {
    const { view } = await renderSidebar()

    await userEvent.click(view.getByRole('button', { name: /Notes/ }))
    await userEvent.click(view.getByRole('menuitem', { name: /reveal graph in finder/i }))

    expect(revealItemInDir).toHaveBeenCalledWith('/notes')
  })

  it('the graph footer recolors the current graph', async () => {
    const { view } = await renderSidebar()

    await userEvent.click(view.getByRole('button', { name: /Notes/ }))
    // "Graph color" is a Radix submenu trigger. Open it with the keyboard
    // (ArrowRight): a hover-opened submenu closes as the pointer leaves the
    // trigger to reach the item, but a keyboard-opened one stays put.
    const colorTrigger = view.getByRole('menuitem', { name: 'Graph color' })
    await expect.element(colorTrigger).toBeVisible()
    colorTrigger.element().focus()
    await userEvent.keyboard('{ArrowRight}') // open the color submenu
    const teal = view.getByRole('menuitem', { name: 'Teal' })
    await expect.element(teal).toBeVisible()
    // Dispatch the click directly on the item: a real pointer click races Radix
    // closing the submenu as the pointer leaves the trigger, and keyboard select
    // does not reliably reach a nested item in headless mode.
    await act(async () => {
      teal.element().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    // The patch composes over the latest settings at apply time, so feed the
    // updater a document and check the record it builds.
    const updater = updateSettingsWith.mock.lastCall?.[0]
    expect(updater?.(DEFAULT_SETTINGS)).toEqual({ graphColors: { '/notes': 'teal' } })
  })
})
