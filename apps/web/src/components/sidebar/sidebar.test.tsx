import type { PinnedNoteRow } from '@reflect/types'
import type { MaybePromise } from '@reflect/utils'
import type { ReactNode } from 'react'
import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  DEFAULT_SETTINGS,
  isOstensiblyEmptyNoteSource,
  type AiProviderConfig,
  type GraphSessionService,
  type NoteDocumentService,
  type SettingsService,
} from '@reflect/core'
import {
  type GraphBootService,
  type AppCommandId,
  type NativeContextMenuOptions,
  deepLinkForRoute,
  type Route,
} from '@reflect/app'
import {
  createTestOperationsService,
  createTestWindowService,
  type TestOpenerService,
  type TestOperationsService,
  createTestAppServices,
} from '@reflect/app/testing'
import {
  createTestDatabaseService,
  createTestCoreServices,
  createTestGitSyncService,
} from '@reflect/core/testing'
import { AudioMemoProvider } from '@/providers/audio-memo-provider.tsx'
import { SidebarProvider } from '@/providers/sidebar-provider.tsx'
import { UpdateProvider } from '@/providers/update-provider.tsx'
import { expectLocatorToHaveCount } from '@/test-utils/expect.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { Sidebar } from './sidebar.tsx'

const openNativeContextMenu = vi.fn((options: NativeContextMenuOptions) => {
  return Promise.try(() => {
    options.items[0]?.action()
  })
})

const GRAPH = { root: '/notes', name: 'Notes', generation: 1 }

/**
 * A provider that can transcribe audio memos.
 */
const OPENAI: AiProviderConfig = {
  id: 'cfg-openai',
  provider: 'openai',
  model: 'gpt-5.1',
  keyHint: 'wxyz1',
}

// What the app's fakes answer; each test sets them before `renderSidebar`.
const getPinnedNotes = vi.fn<() => Promise<PinnedNoteRow[]>>()
const commitNoteFrontmatter = vi.fn<NoteDocumentService['commitFrontmatter']>()
const openNoteWindow = vi.fn<(deepLink: string) => MaybePromise<boolean>>()
let aiProviders: AiProviderConfig[]

// The services of the rendered app; set by `renderSidebar`.
let opener: TestOpenerService
let operations: TestOperationsService
/**
 * A fresh untitled placeholder path, as the new-note route has it.
 */
function untitledNotePath(): string {
  return createTestCoreServices({
    database: createTestDatabaseService(),
  }).noteCreation.untitledNotePath()
}

let openRecent: MockInstance<GraphSessionService['openRecent']>
let pickAndOpen: MockInstance<GraphBootService['pickAndOpen']>
let chooseGraph: MockInstance<GraphBootService['chooseGraph']>
let updateSettingsWith: MockInstance<SettingsService['updateWith']>

beforeEach(() => {
  getPinnedNotes.mockReset().mockResolvedValue([])
  commitNoteFrontmatter.mockReset().mockResolvedValue(undefined)
  openNoteWindow.mockReset().mockResolvedValue(true)
  aiProviders = [OPENAI]
  openNativeContextMenu.mockClear()
})

const SIDEBAR_COMMANDS: readonly AppCommandId[] = [
  'nav.today',
  'nav.allNotes',
  'nav.tasks',
  'note.new',
  'chat.open',
  'settings.open',
  'palette.open',
]

async function renderSidebar(initialRoute?: Route) {
  const readSource = (): Promise<string> => Promise.resolve('# Rust\n')
  operations = createTestOperationsService()
  const core = createTestCoreServices({
    database: createTestDatabaseService(),
    progress: operations,
    noteDocuments: {
      readSource,
      readExisting: readSource,
      commitFrontmatter: commitNoteFrontmatter,
      commitSourceEdit: () => Promise.reject(new Error('commitSourceEdit is not stubbed')),
      isOstensiblyEmpty: isOstensiblyEmptyNoteSource,
    },
    gitSync: createTestGitSyncService({ state: { phase: 'disconnected' } }),
  })
  const appLayer = createTestAppServices(core, {
    window: createTestWindowService({ openNoteWindow }),
  })
  // The commands the sidebar ran, in order. The main window's own handlers
  // are tested with `useWorkspaceCommands`.
  const ran: string[] = []
  const handlers = new AbortController()
  for (const id of SIDEBAR_COMMANDS) {
    appLayer.commands.handle(id, () => void ran.push(id), handlers.signal)
  }
  vi.spyOn(core.indexQuery, 'getPinnedNotes').mockImplementation(getPinnedNotes)
  vi.spyOn(appLayer.nativeMenu, 'openContextMenu').mockImplementation(openNativeContextMenu)
  openRecent = vi.spyOn(core.graphSession, 'openRecent').mockResolvedValue(true)
  pickAndOpen = vi.spyOn(appLayer.graphBoot, 'pickAndOpen').mockResolvedValue()
  chooseGraph = vi.spyOn(appLayer.graphBoot, 'chooseGraph').mockResolvedValue()
  updateSettingsWith = vi.spyOn(core.settings, 'updateWith')
  opener = appLayer.opener
  // The app constrains the sidebar to its rail width; without it the graph
  // menu's anchor spans the viewport and popper pushes the submenu off-screen.
  const view = await renderInApp(<Sidebar graph={GRAPH} />, {
    core,
    appServices: appLayer,
    graph: GRAPH,
    graphState: {
      recents: [
        { root: '/notes', name: 'Notes', openedMs: 2 },
        { root: '/work', name: 'Work', openedMs: 1 },
      ],
    },
    settings: {
      dateFormat: 'mdy',
      graphColors: {},
      aiProviders,
      defaultAiProviderId: aiProviders[0]?.id ?? null,
    },
    route: initialRoute,
    wrapper: (children: ReactNode) => (
      <div style={{ width: 260, height: 560 }}>
        <UpdateProvider autoCheck={false}>
          <SidebarProvider>
            <AudioMemoProvider graph={GRAPH}>{children}</AudioMemoProvider>
          </SidebarProvider>
        </UpdateProvider>
      </div>
    ),
  })
  return { view, ran, core, navigation: appLayer.navigation }
}

describe('Sidebar', () => {
  it('section rows return to where their section was left, and light for it', async () => {
    const { view, ran, navigation } = await renderSidebar({ kind: 'tasks' })
    const tasks = view.getByRole('button', { name: /tasks/i })

    navigation.navigate({ kind: 'note', path: 'notes/meeting.md' })
    await expect.element(tasks).toHaveAttribute('aria-current', 'page')

    // Off the stream, Daily notes returns to its last day without focus.
    await view.getByRole('button', { name: /daily notes/i }).click()
    await vi.waitFor(() => expect(navigation.get().route).toEqual({ kind: 'today' }))
    expect(ran).toEqual([])

    await tasks.click()
    await view.getByRole('button', { name: /all notes/i }).click()
    await view.getByRole('button', { name: /settings/i }).click()
    await view.getByRole('button', { name: /chat/i }).click()
    await vi.waitFor(() => {
      expect(ran).toEqual(['nav.tasks', 'nav.allNotes', 'settings.open', 'chat.open'])
    })
  })

  it('Daily notes on the stream re-anchors to today with focus', async () => {
    const { view, ran } = await renderSidebar({ kind: 'daily', date: '2026-01-02' })

    await view.getByRole('button', { name: /daily notes/i }).click()
    await vi.waitFor(() => expect(ran).toEqual(['nav.today']))
  })

  it('the compose button runs the new-note command', async () => {
    const { view, ran } = await renderSidebar()

    await view.getByRole('button', { name: 'New note' }).click()
    await vi.waitFor(() => expect(ran).toEqual(['note.new']))
  })

  it('All notes stays active while editing a note opened from it', async () => {
    const { view, navigation } = await renderSidebar({ kind: 'allNotes', tag: null })
    navigation.navigate({ kind: 'note', path: 'notes/meeting.md' })
    await expect
      .element(view.getByRole('button', { name: /all notes/i }))
      .toHaveAttribute('aria-current', 'page')
  })

  it('a fresh untitled note lights the section it was created from', async () => {
    const { view, navigation } = await renderSidebar({ kind: 'today' })
    navigation.navigate({ kind: 'note', path: untitledNotePath() })
    await expect
      .element(view.getByRole('button', { name: /daily notes/i }))
      .toHaveAttribute('aria-current', 'page')
  })

  it('the search affordance opens the palette', async () => {
    const { view, ran } = await renderSidebar()
    await view.getByRole('button', { name: /search anything/i }).click()
    expect(ran).toEqual(['palette.open'])
  })

  it('the mic button starts an audio memo', async () => {
    const { view, core } = await renderSidebar()
    await view.getByRole('button', { name: /record audio memo/i }).click()
    await vi.waitFor(() => {
      expect(core.audioRecorder.calls().some((call) => call.method === 'start')).toBe(true)
    })
  })

  it('the mic button disables (without vanishing) when no provider can transcribe', async () => {
    aiProviders = []
    const { view, core } = await renderSidebar()
    const micButton = view.getByRole('button', { name: /record audio memo/i })
    await expect.element(micButton).toHaveAttribute('aria-disabled', 'true')
    // `aria-disabled` fails Playwright's enabled actionability check, but the
    // element still receives real clicks — force past the check.
    await micButton.click({ force: true })
    expect(core.audioRecorder.calls().some((call) => call.method === 'start')).toBe(false)
  })

  it('pinned notes render their own section', async () => {
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/roadmap.md', title: 'Roadmap', dailyDate: null, pinnedOrder: null },
    ])
    const { view } = await renderSidebar()

    const pinnedSection = view.getByRole('region', { name: /pinned notes/i })
    await expect.element(pinnedSection).toMatchTextContent('Roadmap')
    await expectLocatorToHaveCount(view.getByRole('button', { name: 'Roadmap' }), 1)

    const roadmap = pinnedSection.getByRole('button', { name: 'Roadmap' })
    await expect.element(roadmap).toBeInTheDocument()
    const roadmapPreview = roadmap.element().firstElementChild
    expect(roadmapPreview?.getAttribute('class')).toContain('hover:bg-surface-hover')
    expect(roadmapPreview?.getAttribute('class')).toContain('hover:text-text')
    await roadmap.click()
    await expect.element(roadmap).toHaveAttribute('aria-current', 'page')
    expect(roadmapPreview?.getAttribute('class')).toContain('dark:text-accent')
  })

  it('holding Mod reveals every nav shortcut and the top four pinned shortcuts', async () => {
    getPinnedNotes.mockResolvedValue(
      ['One', 'Two', 'Three', 'Four', 'Five'].map((title) => ({
        path: `notes/${title.toLowerCase()}.md`,
        title,
        dailyDate: null,
        pinnedOrder: null,
      })),
    )
    const { view, core } = await renderSidebar()
    const pinnedSection = view.getByRole('region', { name: /pinned notes/i })
    await expect.element(pinnedSection).toMatchTextContent('Five')
    const keycaps = (): string[] => {
      return Array.from(
        pinnedSection.element().querySelectorAll('kbd'),
        (key) => key.textContent ?? '',
      )
    }

    const hiddenNavKeycaps = (): number => {
      return view
        .getByRole('navigation', { name: 'Primary' })
        .element()
        .querySelectorAll('button > span.invisible').length
    }

    expect(keycaps()).toEqual([])
    expect(hiddenNavKeycaps()).toBe(4) // hover-only until Mod is held
    const apple = core.platform.isApplePlatform
    const modKey = apple ? 'Meta' : 'Control'
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: modKey, metaKey: apple, ctrlKey: !apple }),
    )
    await vi.waitFor(() => {
      return expect(keycaps().filter((key) => /\d/.test(key))).toEqual(['6', '7', '8', '9'])
    })
    expect(hiddenNavKeycaps()).toBe(0)

    window.dispatchEvent(new KeyboardEvent('keyup', { key: modKey }))
    await vi.waitFor(() => expect(keycaps()).toEqual([]))
    expect(hiddenNavKeycaps()).toBe(4)
  })

  it('modifier-click opens a pinned note in a new window without changing routes', async () => {
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/roadmap.md', title: 'Roadmap', dailyDate: null, pinnedOrder: null },
    ])
    const { view } = await renderSidebar()
    const roadmap = view.getByRole('button', { name: 'Roadmap' })

    await roadmap.click({ modifiers: ['ControlOrMeta'] })

    await vi.waitFor(() => {
      expect(openNoteWindow).toHaveBeenCalledWith(
        deepLinkForRoute({
          kind: 'note',
          path: 'notes/roadmap.md',
        }),
      )
    })
    expect(openNoteWindow).toHaveBeenCalledTimes(1)
    await expect.element(roadmap).not.toHaveAttribute('aria-current')
  })

  it('renders wiki links in pinned note titles as display text', async () => {
    getPinnedNotes.mockResolvedValue([
      {
        path: 'notes/meeting.md',
        title: 'Meeting with [[Ada Lovelace|Ada]]',
        dailyDate: null,
        pinnedOrder: null,
      },
    ])
    const { view } = await renderSidebar()

    const pinnedSection = view.getByRole('region', { name: /pinned notes/i })
    await expect.element(pinnedSection).toMatchTextContent('Meeting with Ada')
    expect(pinnedSection.element().textContent).not.toContain('[[Ada Lovelace|Ada]]')
    await expect.element(view.getByRole('button', { name: 'Meeting with Ada' })).toBeInTheDocument()
  })

  it('All notes is inactive while the active note is pinned', async () => {
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/roadmap.md', title: 'Roadmap', dailyDate: null, pinnedOrder: null },
    ])
    const { view } = await renderSidebar({ kind: 'note', path: 'notes/roadmap.md' })

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
      { path: 'notes/rust.md', title: 'Rust', dailyDate: null, pinnedOrder: null },
    ])
    const { view } = await renderSidebar()
    const rust = view.getByRole('button', { name: 'Rust' })

    await rust.click({ button: 'right' })

    await vi.waitFor(() => {
      expect(openNativeContextMenu).toHaveBeenCalledWith({
        items: [
          expect.objectContaining({
            text: 'Unpin Note',
          }),
        ],
      })
    })
    await expectLocatorToHaveCount(view.getByRole('button', { name: 'Rust' }), 0)
    expect(commitNoteFrontmatter).toHaveBeenCalledWith('notes/rust.md', { pinned: false }, 1)
  })

  it('restores an optimistically removed pinned row when unpin fails', async () => {
    commitNoteFrontmatter.mockRejectedValueOnce(new Error('disk failed'))
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/rust.md', title: 'Rust', dailyDate: null, pinnedOrder: null },
    ])
    const { view } = await renderSidebar()
    const rust = view.getByRole('button', { name: 'Rust' })

    await rust.click({ button: 'right' })

    await vi.waitFor(() => {
      expect(commitNoteFrontmatter).toHaveBeenCalledWith('notes/rust.md', { pinned: false }, 1)
    })
    await expect.element(view.getByRole('button', { name: 'Rust' })).toBeInTheDocument()
    expect(operations.snapshot()).toMatchObject([
      { label: 'Updating pin', status: 'failed', message: 'disk failed' },
    ])
  })

  it('history arrows walk the router stack and disable at its edges', async () => {
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/rust.md', title: 'Rust', dailyDate: null, pinnedOrder: null },
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
    const work = page.getByRole('menuitem', { name: 'Work', exact: true })
    await expect.element(work).toBeVisible()
    expect(
      [...work.element().querySelectorAll('kbd')].map((keycap) => keycap.textContent),
    ).toContain('2')
    await work.click()
    expect(openRecent).toHaveBeenCalledWith('/work')

    await view.getByRole('button', { name: /Notes/ }).click()
    await page.getByRole('menuitem', { name: /open another graph/i }).click()
    expect(chooseGraph).toHaveBeenCalled()
    expect(pickAndOpen).not.toHaveBeenCalled()
  })

  it('the graph footer opens preferences from the graph menu', async () => {
    const { view, ran } = await renderSidebar()

    await view.getByRole('button', { name: /Notes/ }).click()
    await page.getByRole('menuitem', { name: 'Preferences' }).click()

    await vi.waitFor(() => expect(ran).toEqual(['settings.open']))
  })

  it('the graph menu offers the iOS app and browser extension in their stores', async () => {
    const { view } = await renderSidebar()

    await view.getByRole('button', { name: /Notes/ }).click()
    await page.getByRole('menuitem', { name: 'Get Reflect apps…' }).click()

    const dialog = page.getByRole('dialog', { name: 'Take Reflect with you' })
    await expect.element(dialog).toBeVisible()
    await expect.element(page.getByRole('menu')).not.toBeInTheDocument()

    await dialog.getByRole('button', { name: 'Get iOS app' }).click()
    expect(opener.openedUrls()).toEqual(['https://apps.apple.com/us/app/reflect-open/id6787385615'])
    await dialog.getByRole('button', { name: 'Get Chrome extension' }).click()
    expect(opener.openedUrls()).toEqual([
      'https://apps.apple.com/us/app/reflect-open/id6787385615',
      'https://chromewebstore.google.com/detail/reflect-capture/ccabifmooehighoonjeiololjfofkhkd',
    ])

    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect.element(dialog).not.toBeInTheDocument()
  })

  it('opens the apps dialog from the keyboard and restores graph focus on Escape', async () => {
    const { view } = await renderSidebar()
    const graphTrigger = view.getByRole('button', { name: /Notes/ })
    graphTrigger.element().focus()
    await userEvent.keyboard('{Enter}')
    await userEvent.keyboard('Get Reflect apps')
    await expect.element(page.getByRole('menuitem', { name: 'Get Reflect apps…' })).toHaveFocus()
    await userEvent.keyboard('{Enter}')

    const dialog = page.getByRole('dialog', { name: 'Take Reflect with you' })
    await expect.element(dialog).toBeVisible()
    await vi.waitFor(() => expect(dialog.element().contains(document.activeElement)).toBe(true))

    await userEvent.keyboard('{Escape}')
    await expect.element(dialog).not.toBeInTheDocument()
    await expect.element(graphTrigger).toHaveFocus()

    await userEvent.keyboard('{Enter}')
    await expect.element(page.getByRole('menuitem', { name: 'Get Reflect apps…' })).toBeVisible()
  })

  it('the graph footer opens the current graph in the system file manager', async () => {
    const { view } = await renderSidebar()

    await view.getByRole('button', { name: /Notes/ }).click()
    await page.getByRole('menuitem', { name: /reveal graph in finder/i }).click()

    await vi.waitFor(() => expect(opener.revealedPaths()).toEqual(['/notes']))
  })

  it.each([
    { name: 'Notes', root: '/notes' },
    { name: 'Work', root: '/work' },
  ])('recolors $name from its swatch without switching graphs', async ({ name, root }) => {
    const { view } = await renderSidebar()

    await view.getByRole('button', { name: /Notes/ }).click()
    await expect
      .element(page.getByRole('menuitem', { name: 'Graph color', exact: true }))
      .not.toBeInTheDocument()
    await page.getByRole('menuitem', { name: `Change color for ${name}` }).click()
    await expect
      .element(page.getByRole('menuitemradio', { name: 'Indigo' }))
      .toHaveAttribute('aria-checked', 'true')
    await page.getByRole('menuitemradio', { name: 'Teal' }).click()
    await expect.element(page.getByRole('menuitemradio', { name: 'Teal' })).not.toBeInTheDocument()
    expect(updateSettingsWith).toHaveBeenCalledTimes(1)
    expect(openRecent).not.toHaveBeenCalled()

    const updater = updateSettingsWith.mock.lastCall?.[0]
    expect(updater?.({ ...DEFAULT_SETTINGS, graphColors: { '/other': 'red' } })).toEqual({
      graphColors: { '/other': 'red', [root]: 'teal' },
    })
  })

  it('opens and dismisses a graph color menu from the keyboard', async () => {
    const { view } = await renderSidebar()
    view.getByRole('button', { name: /Notes/ }).element().focus()
    await userEvent.keyboard('{ArrowDown}')
    const swatch = page.getByRole('menuitem', { name: 'Change color for Notes' })
    await expect.element(swatch).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    await expect.element(page.getByRole('menuitemradio', { name: 'Indigo' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await expect.element(swatch).toHaveFocus()
    await expect.element(swatch).toBeVisible()
    expect(updateSettingsWith).not.toHaveBeenCalled()

    await userEvent.keyboard('{ArrowRight}')
    await expect.element(page.getByRole('menuitemradio', { name: 'Indigo' })).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    await expect.element(page.getByRole('menuitemradio', { name: 'Blue' })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() => expect(updateSettingsWith).toHaveBeenCalledTimes(1))
    expect(updateSettingsWith.mock.lastCall?.[0](DEFAULT_SETTINGS)).toEqual({
      graphColors: { '/notes': 'blue' },
    })
    expect(openRecent).not.toHaveBeenCalled()
  })
})
