import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { Locator } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { setBridge, type EmbedStatus, type GraphInfo } from '@reflect/core'
import { formatFullDate } from '@/lib/dates'
import { resetOperations } from '@/lib/operations'
import { NoteTemplatesProvider } from '@/providers/note-templates-provider'
import { ShortcutsProvider } from '@/providers/shortcuts-provider'
import { SettingsProvider } from '@/providers/settings-provider'
import { UpdateProvider } from '@/providers/update-provider'
import { RouterProvider } from '@/routing/router'
import { expectLocatorToHaveCount } from '@/test-utils/expect'
import { ShortcutsDialog } from './shortcuts-dialog'
import { SettingsScreen } from './settings-screen'

// The rebuild-index field reads the open index generation — and the Backup
// section the open graph + sync state — from per-graph providers the screen
// tests don't mount, so stub both hooks (backup disconnected).
const graph = vi.hoisted(() => ({
  current: null as GraphInfo | null,
  indexGeneration: 7 as number | null,
  forget: vi.fn<(root: string) => Promise<void>>(async () => {}),
  deleteGraph: vi.fn<() => Promise<void>>(async () => {}),
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    graph: graph.current,
    indexGeneration: graph.indexGeneration,
    forget: graph.forget,
    deleteGraph: graph.deleteGraph,
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
// The Import section only hands the picked zip to the workspace-level V1
// import controller, which these screen tests don't mount.
vi.mock('@/providers/v1-import-provider', () => ({
  useV1Import: () => ({
    state: { phase: 'idle' },
    startImport: () => {},
    cancelImport: () => {},
    dismiss: () => {},
  }),
}))

let stored: Record<string, unknown>
let saved: unknown[]
let invoked: string[]
let embedStatus: EmbedStatus

function installFakeBridge(): void {
  saved = []
  invoked = []
  setBridge({
    invoke: async (command, args) => {
      invoked.push(command)
      switch (command) {
        case 'settings_load':
          return stored
        case 'settings_save':
          saved.push(args['settings'])
          return null
        case 'embed_status':
        case 'embed_ensure':
          return embedStatus
        case 'list_files':
          return []
        case 'db_query':
          return [] // the Note templates section lists `kind = 'template'` rows
        default:
          return null
      }
    },
    listen: async () => () => {},
  })
}

let queryClient: QueryClient

function renderScreen() {
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <UpdateProvider autoCheck={false}>
          {/* The Note templates section opens files (router) and shares the
              "New template" dialog state (templates provider). */}
          <RouterProvider>
            <ShortcutsProvider>
              <NoteTemplatesProvider>
                <SettingsScreen />
                <ShortcutsDialog />
              </NoteTemplatesProvider>
            </ShortcutsProvider>
          </RouterProvider>
        </UpdateProvider>
      </SettingsProvider>
    </QueryClientProvider>,
  )
}

function radio(name: RegExp): Locator {
  return page.getByRole('radio', { name })
}

/** Clicks a radio's option card — the `<input>` itself is `sr-only`. */
async function pickRadio(name: RegExp): Promise<void> {
  const label = radio(name).element().closest('label')
  if (!(label instanceof HTMLLabelElement)) {
    throw new Error('expected the radio to sit inside its option card')
  }
  await userEvent.click(label)
}

beforeEach(() => {
  stored = {}
  embedStatus = { status: 'uninitialized' }
  graph.current = null
  graph.indexGeneration = 7
  graph.forget.mockClear()
  graph.deleteGraph.mockClear()
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  installFakeBridge()
})

afterEach(() => {
  vi.useRealTimers()
  setBridge(null)
  queryClient.clear()
})

describe('SettingsScreen', () => {
  it('shows update controls when the native bridge is available', async () => {
    await renderScreen()
    await expect
      .element(page.getByRole('button', { name: /check for updates/i }))
      .toBeInTheDocument()
  })

  it('persists the default-on transcription auto-format preference', async () => {
    await renderScreen()
    const toggle = page.getByRole('switch', { name: /transcription auto-format/i })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'true')
    const descriptionId = toggle.element().getAttribute('aria-describedby')
    expect(descriptionId).not.toBeNull()
    expect(document.getElementById(descriptionId ?? '')?.textContent).toContain(
      'Use AI to add punctuation, paragraphs, and light Markdown',
    )

    await toggle.click()

    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
    await vi.waitFor(() =>
      expect(saved.at(-1)).toMatchObject({ transcriptionFormat: false }),
    )
  })

  it('reflects a persisted transcription auto-format opt-out', async () => {
    stored = { transcriptionFormat: false }
    await renderScreen()

    const toggle = page.getByRole('switch', { name: /transcription auto-format/i })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('confirms before forgetting the open graph from saved graphs', async () => {
    graph.current = { root: '/graphs/work', name: 'Work', generation: 1 }
    await renderScreen()

    const section = page.getByRole('region', { name: 'Danger zone' })
    await section.getByRole('button', { name: /forget graph/i }).click()

    const dialog = page.getByRole('dialog', { name: /forget graph/i })
    await expect.element(dialog.getByText('/graphs/work')).toBeInTheDocument()
    expect(graph.forget).not.toHaveBeenCalled()

    await dialog.getByRole('button', { name: /forget graph/i }).click()

    await vi.waitFor(() => expect(graph.forget).toHaveBeenCalledWith('/graphs/work'))
  })

  it('requires typing the graph name before deleting the graph', async () => {
    graph.current = { root: '/graphs/work', name: 'Work', generation: 1 }
    await renderScreen()

    const section = page.getByRole('region', { name: 'Danger zone' })
    await section.getByRole('button', { name: /delete graph/i }).click()

    const dialog = page.getByRole('dialog', { name: /delete graph/i })
    await expect.element(dialog.getByText('/graphs/work')).toBeInTheDocument()
    // Deleting an adopted vault trashes the user's own folder — the dialog
    // must say so in as many words.
    await expect.element(dialog.getByText(/everything inside it to Trash/)).toBeInTheDocument()
    const confirm = dialog.getByRole('button', { name: /delete graph/i })
    await expect.element(confirm).toBeDisabled()

    const nameInput = dialog.getByLabelText('Graph name')
    await nameInput.fill('Wor')
    await expect.element(confirm).toBeDisabled()
    // Enter with a mismatched name must not delete either.
    await userEvent.keyboard('{Enter}')
    expect(graph.deleteGraph).not.toHaveBeenCalled()

    await nameInput.fill('Work')
    await expect.element(confirm).not.toBeDisabled()
    await confirm.click()

    await vi.waitFor(() => expect(graph.deleteGraph).toHaveBeenCalledTimes(1))
  })

  it('reflects the persisted markdown syntax mode', async () => {
    stored = { editorMarkdownSyntax: 'show' }
    await renderScreen()
    await expect.element(radio(/^show/i)).toBeChecked()
    await expect.element(radio(/^hide/i)).not.toBeChecked()
  })

  it('selecting Show applies instantly and persists', async () => {
    await renderScreen()
    await expect.element(radio(/^hide/i)).toBeChecked()

    await pickRadio(/^show/i)

    await vi.waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'show',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
          editorSmoothCaretAnimation: true,
          editorTextSize: 'small',
          editorFullWidth: false,
          sidebarWidth: 260,
          contextSidebarWidth: 320,
          semanticSearchEnabled: false,
          describeAssets: true,
          transcriptionFormat: true,
          contactsEnabled: false,
          mobileOnboarded: false,
          mobileStorage: 'local',
          mobileGraphName: '',
          theme: 'system',
          timeFormat: '12h',
          dateFormat: 'mdy',
          weekStartDay: 'monday',
          allNotesFilterTags: ['book', 'link', 'person'],
          calendarEnabled: false,
          calendarIds: [],
          graphColors: {},
          aiProviders: [],
          defaultAiProviderId: null,
          chatModelSelection: null,
          chatSystemPrompt: '',
          aiPrompts: [],
        },
      ]),
    )
    await expect.element(radio(/^show/i)).toBeChecked()
    await expect.element(radio(/^hide/i)).not.toBeChecked()
  })

  it('reflects the persisted text size', async () => {
    stored = { editorTextSize: 'large' }
    await renderScreen()
    await expect.element(radio(/^large/i)).toBeChecked()
    await expect.element(radio(/^medium/i)).not.toBeChecked()
  })

  it('selecting Large applies instantly and persists the text size', async () => {
    await renderScreen()
    await expect.element(radio(/^small/i)).toBeChecked()

    await pickRadio(/^large/i)

    await vi.waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
          editorSmoothCaretAnimation: true,
          editorTextSize: 'large',
          editorFullWidth: false,
          sidebarWidth: 260,
          contextSidebarWidth: 320,
          semanticSearchEnabled: false,
          describeAssets: true,
          transcriptionFormat: true,
          contactsEnabled: false,
          mobileOnboarded: false,
          mobileStorage: 'local',
          mobileGraphName: '',
          theme: 'system',
          timeFormat: '12h',
          dateFormat: 'mdy',
          weekStartDay: 'monday',
          allNotesFilterTags: ['book', 'link', 'person'],
          calendarEnabled: false,
          calendarIds: [],
          graphColors: {},
          aiProviders: [],
          defaultAiProviderId: null,
          chatModelSelection: null,
          chatSystemPrompt: '',
          aiPrompts: [],
        },
      ]),
    )
    await expect.element(radio(/^large/i)).toBeChecked()
    await expect.element(radio(/^medium/i)).not.toBeChecked()
  })

  it('enables full-width notes instantly and persists the preference', async () => {
    await renderScreen()
    const toggle = page.getByRole('switch', { name: /full-width notes/i })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')

    await toggle.click()

    await expect.element(toggle).toHaveAttribute('aria-checked', 'true')
    await vi.waitFor(() => expect(saved.at(-1)).toMatchObject({ editorFullWidth: true }))
  })

  it('reflects a persisted spell check opt-out', async () => {
    stored = { editorSpellCheck: false }
    await renderScreen()
    const toggle = page.getByRole('switch', { name: /spell check/i })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('toggling spell check off applies instantly and persists', async () => {
    await renderScreen()
    const toggle = page.getByRole('switch', { name: /spell check/i })
    // On by default.
    await expect.element(toggle).toHaveAttribute('aria-checked', 'true')

    await toggle.click()

    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
    await vi.waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: false,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
          editorSmoothCaretAnimation: true,
          editorTextSize: 'small',
          editorFullWidth: false,
          sidebarWidth: 260,
          contextSidebarWidth: 320,
          semanticSearchEnabled: false,
          describeAssets: true,
          transcriptionFormat: true,
          contactsEnabled: false,
          mobileOnboarded: false,
          mobileStorage: 'local',
          mobileGraphName: '',
          theme: 'system',
          timeFormat: '12h',
          dateFormat: 'mdy',
          weekStartDay: 'monday',
          allNotesFilterTags: ['book', 'link', 'person'],
          calendarEnabled: false,
          calendarIds: [],
          graphColors: {},
          aiProviders: [],
          defaultAiProviderId: null,
          chatModelSelection: null,
          chatSystemPrompt: '',
          aiPrompts: [],
        },
      ]),
    )
  })

  it('reflects a persisted smooth caret animation opt-out', async () => {
    stored = { editorSmoothCaretAnimation: false }
    await renderScreen()
    const toggle = page.getByRole('switch', { name: /smooth caret animation/i })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('disables smooth caret animation instantly and persists the preference', async () => {
    await renderScreen()
    const toggle = page.getByRole('switch', { name: /smooth caret animation/i })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'true')

    await toggle.click()

    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
    await vi.waitFor(() =>
      expect(saved.at(-1)).toMatchObject({ editorSmoothCaretAnimation: false }),
    )
  })

  it('reflects a persisted default-bullet opt-out', async () => {
    stored = { editorDefaultBullet: false }
    await renderScreen()
    const toggle = page.getByRole('switch', { name: /start with a bullet/i })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('toggling the default bullet off applies instantly and persists', async () => {
    await renderScreen()
    const toggle = page.getByRole('switch', { name: /start with a bullet/i })
    // On by default.
    await expect.element(toggle).toHaveAttribute('aria-checked', 'true')

    await toggle.click()

    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
    await vi.waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: false,
          editorBulletAfterHeading: true,
          editorSmoothCaretAnimation: true,
          editorTextSize: 'small',
          editorFullWidth: false,
          sidebarWidth: 260,
          contextSidebarWidth: 320,
          semanticSearchEnabled: false,
          describeAssets: true,
          transcriptionFormat: true,
          contactsEnabled: false,
          mobileOnboarded: false,
          mobileStorage: 'local',
          mobileGraphName: '',
          theme: 'system',
          timeFormat: '12h',
          dateFormat: 'mdy',
          weekStartDay: 'monday',
          allNotesFilterTags: ['book', 'link', 'person'],
          calendarEnabled: false,
          calendarIds: [],
          graphColors: {},
          aiProviders: [],
          defaultAiProviderId: null,
          chatModelSelection: null,
          chatSystemPrompt: '',
          aiPrompts: [],
        },
      ]),
    )
  })

  it('reflects a persisted bullet-after-heading opt-out', async () => {
    stored = { editorBulletAfterHeading: false }
    await renderScreen()
    const toggle = page.getByRole('switch', { name: /bullet after a heading/i })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('toggling bullet-after-heading off persists independently of the seed bullet', async () => {
    await renderScreen()
    const toggle = page.getByRole('switch', { name: /bullet after a heading/i })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'true')

    await toggle.click()

    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
    await vi.waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: false,
          editorSmoothCaretAnimation: true,
          editorTextSize: 'small',
          editorFullWidth: false,
          sidebarWidth: 260,
          contextSidebarWidth: 320,
          semanticSearchEnabled: false,
          describeAssets: true,
          transcriptionFormat: true,
          contactsEnabled: false,
          mobileOnboarded: false,
          mobileStorage: 'local',
          mobileGraphName: '',
          theme: 'system',
          timeFormat: '12h',
          dateFormat: 'mdy',
          weekStartDay: 'monday',
          allNotesFilterTags: ['book', 'link', 'person'],
          calendarEnabled: false,
          calendarIds: [],
          graphColors: {},
          aiProviders: [],
          defaultAiProviderId: null,
          chatModelSelection: null,
          chatSystemPrompt: '',
          aiPrompts: [],
        },
      ]),
    )
  })

  it('reflects the persisted theme and persists a new choice', async () => {
    stored = { theme: 'dark' }
    await renderScreen()
    await expect.element(radio(/^dark/i)).toBeChecked()

    await pickRadio(/^light/i)

    await expect.element(radio(/^light/i)).toBeChecked()
    await vi.waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
          editorSmoothCaretAnimation: true,
          editorTextSize: 'small',
          editorFullWidth: false,
          sidebarWidth: 260,
          contextSidebarWidth: 320,
          semanticSearchEnabled: false,
          describeAssets: true,
          transcriptionFormat: true,
          contactsEnabled: false,
          mobileOnboarded: false,
          mobileStorage: 'local',
          mobileGraphName: '',
          theme: 'light',
          timeFormat: '12h',
          dateFormat: 'mdy',
          weekStartDay: 'monday',
          allNotesFilterTags: ['book', 'link', 'person'],
          calendarEnabled: false,
          calendarIds: [],
          graphColors: {},
          aiProviders: [],
          defaultAiProviderId: null,
          chatModelSelection: null,
          chatSystemPrompt: '',
          aiPrompts: [],
        },
      ]),
    )
  })

  it('reflects the persisted date format', async () => {
    stored = { dateFormat: 'dmy' }
    await renderScreen()
    const trigger = page.getByRole('combobox', { name: 'Date format' })
    // The options label themselves with today's date in each order.
    await expect.element(trigger).toHaveTextContent(formatFullDate(new Date(), 'dmy'))
  })

  it('selecting day-month-year persists the date format', async () => {
    await renderScreen()
    const trigger = page.getByRole('combobox', { name: 'Date format' })
    await expect.element(trigger).toHaveTextContent(formatFullDate(new Date(), 'mdy'))

    await trigger.click()
    await page.getByRole('option', { name: formatFullDate(new Date(), 'dmy') }).click()

    await expect.element(trigger).toHaveTextContent(formatFullDate(new Date(), 'dmy'))
    await vi.waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
          editorSmoothCaretAnimation: true,
          editorTextSize: 'small',
          editorFullWidth: false,
          sidebarWidth: 260,
          contextSidebarWidth: 320,
          semanticSearchEnabled: false,
          describeAssets: true,
          transcriptionFormat: true,
          contactsEnabled: false,
          mobileOnboarded: false,
          mobileStorage: 'local',
          mobileGraphName: '',
          theme: 'system',
          timeFormat: '12h',
          dateFormat: 'dmy',
          weekStartDay: 'monday',
          allNotesFilterTags: ['book', 'link', 'person'],
          calendarEnabled: false,
          calendarIds: [],
          graphColors: {},
          aiProviders: [],
          defaultAiProviderId: null,
          chatModelSelection: null,
          chatSystemPrompt: '',
          aiPrompts: [],
        },
      ]),
    )
  })

  it('selecting ISO persists the date format', async () => {
    const now = new Date(2026, 5, 10, 12, 0, 0)
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(now)

    await renderScreen()
    const trigger = page.getByRole('combobox', { name: 'Date format' })
    const isoLabel = formatFullDate(now, 'iso')
    await expect.element(trigger).toHaveTextContent(formatFullDate(now, 'mdy'))

    await trigger.click()
    await page.getByRole('option', { name: isoLabel }).click()

    await expect.element(trigger).toHaveTextContent(isoLabel)
    await vi.waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
          editorSmoothCaretAnimation: true,
          editorTextSize: 'small',
          editorFullWidth: false,
          sidebarWidth: 260,
          contextSidebarWidth: 320,
          semanticSearchEnabled: false,
          describeAssets: true,
          transcriptionFormat: true,
          contactsEnabled: false,
          mobileOnboarded: false,
          mobileStorage: 'local',
          mobileGraphName: '',
          theme: 'system',
          timeFormat: '12h',
          dateFormat: 'iso',
          weekStartDay: 'monday',
          allNotesFilterTags: ['book', 'link', 'person'],
          calendarEnabled: false,
          calendarIds: [],
          graphColors: {},
          aiProviders: [],
          defaultAiProviderId: null,
          chatModelSelection: null,
          chatSystemPrompt: '',
          aiPrompts: [],
        },
      ]),
    )
  })

  it('shows the week start setting in Date & time', async () => {
    await renderScreen()
    const dateTime = page.getByRole('region', { name: 'Date & time' })
    const appearance = page.getByRole('region', { name: 'Appearance' })

    await expect
      .element(dateTime.getByRole('combobox', { name: 'Start week on' }))
      .toBeInTheDocument()
    expect(appearance.getByRole('combobox', { name: 'Start week on' }).query()).toBeNull()
  })

  it('selecting Sunday persists the week start day', async () => {
    await renderScreen()
    const trigger = page.getByRole('combobox', { name: 'Start week on' })
    await expect.element(trigger).toHaveTextContent('Monday')

    await trigger.click()
    await page.getByRole('option', { name: 'Sunday' }).click()

    await expect.element(trigger).toHaveTextContent('Sunday')
    await vi.waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
          editorSmoothCaretAnimation: true,
          editorTextSize: 'small',
          editorFullWidth: false,
          sidebarWidth: 260,
          contextSidebarWidth: 320,
          semanticSearchEnabled: false,
          describeAssets: true,
          transcriptionFormat: true,
          contactsEnabled: false,
          mobileOnboarded: false,
          mobileStorage: 'local',
          mobileGraphName: '',
          theme: 'system',
          timeFormat: '12h',
          dateFormat: 'mdy',
          weekStartDay: 'sunday',
          allNotesFilterTags: ['book', 'link', 'person'],
          calendarEnabled: false,
          calendarIds: [],
          graphColors: {},
          aiProviders: [],
          defaultAiProviderId: null,
          chatModelSelection: null,
          chatSystemPrompt: '',
          aiPrompts: [],
        },
      ]),
    )
  })

  it('reflects the persisted time format', async () => {
    stored = { timeFormat: '24h' }
    await renderScreen()
    const trigger = page.getByRole('combobox', { name: 'Time format' })
    await expect.element(trigger).toHaveTextContent('24-hour')
  })

  it('selecting 24-hour persists the time format', async () => {
    await renderScreen()
    const trigger = page.getByRole('combobox', { name: 'Time format' })
    await expect.element(trigger).toHaveTextContent('12-hour')

    await trigger.click()
    await page.getByRole('option', { name: '24-hour' }).click()

    await expect.element(trigger).toHaveTextContent('24-hour')
    await vi.waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
          editorSmoothCaretAnimation: true,
          editorTextSize: 'small',
          editorFullWidth: false,
          sidebarWidth: 260,
          contextSidebarWidth: 320,
          semanticSearchEnabled: false,
          describeAssets: true,
          transcriptionFormat: true,
          contactsEnabled: false,
          mobileOnboarded: false,
          mobileStorage: 'local',
          mobileGraphName: '',
          theme: 'system',
          timeFormat: '24h',
          dateFormat: 'mdy',
          weekStartDay: 'monday',
          allNotesFilterTags: ['book', 'link', 'person'],
          calendarEnabled: false,
          calendarIds: [],
          graphColors: {},
          aiProviders: [],
          defaultAiProviderId: null,
          chatModelSelection: null,
          chatSystemPrompt: '',
          aiPrompts: [],
        },
      ]),
    )
  })

  it('adds an All Notes filter tag, normalized, and persists it', async () => {
    await renderScreen()
    const input = page.getByLabelText('Add filter tag')

    await input.fill(' #Meeting ')
    await page.getByRole('button', { name: 'Add', exact: true }).click()

    await expect.element(page.getByText('#meeting')).toBeInTheDocument()
    await vi.waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
          editorSmoothCaretAnimation: true,
          editorTextSize: 'small',
          editorFullWidth: false,
          sidebarWidth: 260,
          contextSidebarWidth: 320,
          semanticSearchEnabled: false,
          describeAssets: true,
          transcriptionFormat: true,
          contactsEnabled: false,
          mobileOnboarded: false,
          mobileStorage: 'local',
          mobileGraphName: '',
          theme: 'system',
          timeFormat: '12h',
          dateFormat: 'mdy',
          weekStartDay: 'monday',
          allNotesFilterTags: ['book', 'link', 'person', 'meeting'],
          calendarEnabled: false,
          calendarIds: [],
          graphColors: {},
          aiProviders: [],
          defaultAiProviderId: null,
          chatModelSelection: null,
          chatSystemPrompt: '',
          aiPrompts: [],
        },
      ]),
    )
  })

  it('rejects a tag name outside the #tag grammar with an inline error', async () => {
    await renderScreen()
    const input = page.getByLabelText('Add filter tag')

    await input.fill('my tag')
    await page.getByRole('button', { name: 'Add', exact: true }).click()

    await expect.element(page.getByRole('alert')).toHaveTextContent(`"my tag" can't be a tag`)
    // The draft stays put for fixing, and nothing reaches the store.
    await expect.element(input).toHaveValue('my tag')
    await vi.waitFor(() => expect(saved).toEqual([]))
  })

  it('ignores adding a duplicate filter tag', async () => {
    stored = { allNotesFilterTags: ['book'] }
    await renderScreen()
    // Defaults render before the disk document lands — wait for hydration
    // (the stored list has no `person`) so the click edits the loaded list.
    await expectLocatorToHaveCount(page.getByText('#person'), 0)
    await expect.element(page.getByText('#book')).toBeInTheDocument()

    await page.getByLabelText('Add filter tag').fill('BOOK')
    await page.getByRole('button', { name: 'Add', exact: true }).click()

    await vi.waitFor(() => expect(saved).toEqual([]))
  })

  it('removes a filter tag and persists the rest', async () => {
    stored = { allNotesFilterTags: ['book', 'person'] }
    await renderScreen()
    // Wait for hydration (the stored list has no `link`), not just defaults.
    await expectLocatorToHaveCount(page.getByText('#link'), 0)
    await expect.element(page.getByText('#book')).toBeInTheDocument()

    await page.getByRole('button', { name: 'Remove book' }).click()

    expect(page.getByText('#book').query()).toBeNull()
    await vi.waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
          editorSmoothCaretAnimation: true,
          editorTextSize: 'small',
          editorFullWidth: false,
          sidebarWidth: 260,
          contextSidebarWidth: 320,
          semanticSearchEnabled: false,
          describeAssets: true,
          transcriptionFormat: true,
          contactsEnabled: false,
          mobileOnboarded: false,
          mobileStorage: 'local',
          mobileGraphName: '',
          theme: 'system',
          timeFormat: '12h',
          dateFormat: 'mdy',
          weekStartDay: 'monday',
          allNotesFilterTags: ['person'],
          calendarEnabled: false,
          calendarIds: [],
          graphColors: {},
          aiProviders: [],
          defaultAiProviderId: null,
          chatModelSelection: null,
          chatSystemPrompt: '',
          aiPrompts: [],
        },
      ]),
    )
  })

  it('enabling semantic search persists the opt-in', async () => {
    await renderScreen()
    const enable = page.getByRole('button', { name: /enable semantic search/i })

    await enable.click()

    await vi.waitFor(() =>
      expect(saved).toEqual([
        { editorMarkdownSyntax: 'hide', editorSpellCheck: true, editorDefaultBullet: true, editorBulletAfterHeading: true, editorSmoothCaretAnimation: true, editorTextSize: 'small', editorFullWidth: false, sidebarWidth: 260, contextSidebarWidth: 320, semanticSearchEnabled: true, describeAssets: true, transcriptionFormat: true, contactsEnabled: false, mobileOnboarded: false, mobileStorage: 'local', mobileGraphName: '', theme: 'system', timeFormat: '12h', dateFormat: 'mdy', weekStartDay: 'monday', allNotesFilterTags: ['book', 'link', 'person'], calendarEnabled: false, calendarIds: [], graphColors: {}, aiProviders: [], defaultAiProviderId: null, chatModelSelection: null, chatSystemPrompt: '', aiPrompts: [] },
      ]),
    )
    // The control flips to the loading state (EmbeddingsSync owns the actual
    // download; the runtime here still reports `uninitialized`).
    await expect
      .element(page.getByRole('progressbar', { name: /model download/i }))
      .toBeInTheDocument()
  })

  it('shows byte-level progress while the model downloads', async () => {
    stored = { semanticSearchEnabled: true }
    embedStatus = { status: 'loading', progress: { downloaded: 45_000_000, total: 90_000_000 } }
    await renderScreen()

    const bar = page.getByRole('progressbar', { name: /model download/i })
    await expect.element(bar).toHaveAttribute('aria-valuenow', '50')
    await expect
      .element(page.getByText('Downloading the model — 45 MB of 90 MB'))
      .toBeInTheDocument()
  })

  it('shows the downloaded model once ready and persists a disable', async () => {
    stored = { semanticSearchEnabled: true }
    embedStatus = { status: 'ready', model: 'all-MiniLM-L6-v2' }
    await renderScreen()

    await expect
      .element(page.getByText(/model downloaded \(all-MiniLM-L6-v2\)/i))
      .toBeInTheDocument()

    await page.getByRole('button', { name: /disable/i }).click()

    await vi.waitFor(() =>
      expect(saved).toEqual([
        { editorMarkdownSyntax: 'hide', editorSpellCheck: true, editorDefaultBullet: true, editorBulletAfterHeading: true, editorSmoothCaretAnimation: true, editorTextSize: 'small', editorFullWidth: false, sidebarWidth: 260, contextSidebarWidth: 320, semanticSearchEnabled: false, describeAssets: true, transcriptionFormat: true, contactsEnabled: false, mobileOnboarded: false, mobileStorage: 'local', mobileGraphName: '', theme: 'system', timeFormat: '12h', dateFormat: 'mdy', weekStartDay: 'monday', allNotesFilterTags: ['book', 'link', 'person'], calendarEnabled: false, calendarIds: [], graphColors: {}, aiProviders: [], defaultAiProviderId: null, chatModelSelection: null, chatSystemPrompt: '', aiPrompts: [] },
      ]),
    )
    await expect
      .element(page.getByRole('button', { name: /enable semantic search/i }))
      .toBeInTheDocument()
    // Disabling is immediate — every semantic consumer gates on the setting,
    // so there is no "takes effect on the next launch" caveat to show even
    // while the runtime still reports `ready`.
    expect(page.getByText(/next launch/i).query()).toBeNull()
  })

  it('re-enabling after a failed load retries the download', async () => {
    embedStatus = { status: 'failed', message: 'offline' }
    await renderScreen()
    const enable = page.getByRole('button', { name: /enable semantic search/i })

    await enable.click()

    // The opt-in persists AND the broken runtime gets a fresh embed_ensure —
    // EmbeddingsSync only loads `uninitialized` runtimes, so the explicit
    // action carries the retry.
    await vi.waitFor(() => expect(invoked).toContain('embed_ensure'))
    await vi.waitFor(() =>
      expect(saved).toEqual([
        { editorMarkdownSyntax: 'hide', editorSpellCheck: true, editorDefaultBullet: true, editorBulletAfterHeading: true, editorSmoothCaretAnimation: true, editorTextSize: 'small', editorFullWidth: false, sidebarWidth: 260, contextSidebarWidth: 320, semanticSearchEnabled: true, describeAssets: true, transcriptionFormat: true, contactsEnabled: false, mobileOnboarded: false, mobileStorage: 'local', mobileGraphName: '', theme: 'system', timeFormat: '12h', dateFormat: 'mdy', weekStartDay: 'monday', allNotesFilterTags: ['book', 'link', 'person'], calendarEnabled: false, calendarIds: [], graphColors: {}, aiProviders: [], defaultAiProviderId: null, chatModelSelection: null, chatSystemPrompt: '', aiPrompts: [] },
      ]),
    )
  })

  it('surfaces a failed load with retry and disable affordances', async () => {
    stored = { semanticSearchEnabled: true }
    embedStatus = { status: 'failed', message: 'no disk space' }
    await renderScreen()

    await expect.element(page.getByRole('alert')).toBeInTheDocument()
    await expect.element(page.getByText(/no disk space/i)).toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: /try again/i })).toBeInTheDocument()

    // Backing out after a failure must work too — the opt-in isn't a trap.
    await page.getByRole('button', { name: /disable/i }).click()

    await vi.waitFor(() =>
      expect(saved).toEqual([
        { editorMarkdownSyntax: 'hide', editorSpellCheck: true, editorDefaultBullet: true, editorBulletAfterHeading: true, editorSmoothCaretAnimation: true, editorTextSize: 'small', editorFullWidth: false, sidebarWidth: 260, contextSidebarWidth: 320, semanticSearchEnabled: false, describeAssets: true, transcriptionFormat: true, contactsEnabled: false, mobileOnboarded: false, mobileStorage: 'local', mobileGraphName: '', theme: 'system', timeFormat: '12h', dateFormat: 'mdy', weekStartDay: 'monday', allNotesFilterTags: ['book', 'link', 'person'], calendarEnabled: false, calendarIds: [], graphColors: {}, aiProviders: [], defaultAiProviderId: null, chatModelSelection: null, chatSystemPrompt: '', aiPrompts: [] },
      ]),
    )
    await expect
      .element(page.getByRole('button', { name: /enable semantic search/i }))
      .toBeInTheDocument()
  })

  it('rebuilding the index wipes and re-applies the projection through the bridge', async () => {
    try {
      await renderScreen()

      await page.getByRole('button', { name: /rebuild index/i }).click()

      // The whole chain: button → rebuildIndexVisibly → wipe, then the
      // projection-version stamp that marks a completed rebuild. (The graph is
      // empty here, so there is no apply batch in between.)
      await vi.waitFor(() => expect(invoked).toContain('index_clear'))
      await vi.waitFor(() => expect(invoked).toContain('index_meta_set'))
    } finally {
      resetOperations()
    }
  })

  it('disables the index rebuild until a graph index is open', async () => {
    graph.indexGeneration = null
    await renderScreen()
    const button = page.getByRole('button', { name: /rebuild index/i })
    await expect.element(button).toBeDisabled()
  })

  it('opens the global shortcuts dialog from the editor settings row', async () => {
    await renderScreen()
    const section = page.getByRole('region', { name: 'Editor' })

    await section.getByRole('button', { name: /show all/i }).click()

    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
    // App scope (command titles) and editor scope (binding descriptions) still
    // come from the global cheat-sheet, not from a duplicated settings list.
    await expect.element(dialog.getByText('Toggle sidebar')).toBeInTheDocument()
    await expect.element(dialog.getByText('Go to today')).toBeInTheDocument()
    await expect.element(dialog.getByText('Bold')).toBeInTheDocument()
    await expect.element(dialog.getByText('Heading 1')).toBeInTheDocument()
    await expect.element(dialog.getByText('Open the AI menu on the selection')).toBeInTheDocument()
  })

  it('reflects and persists the AI chat system prompt', async () => {
    stored = { chatSystemPrompt: 'Answer as a careful research partner.' }
    await renderScreen()
    const textarea = page.getByRole('textbox', { name: 'System prompt' })
    await expect.element(textarea).toHaveValue('Answer as a careful research partner.')

    await textarea.fill('  Challenge my assumptions.\nKeep the recommendation short.  ')
    await userEvent.tab()

    await vi.waitFor(() =>
      expect(saved.at(-1)).toMatchObject({
        chatSystemPrompt: 'Challenge my assumptions.\nKeep the recommendation short.',
      }),
    )
  })

  it('restores the default AI chat prompt', async () => {
    stored = { chatSystemPrompt: 'Always answer in haiku.' }
    await renderScreen()
    const section = page.getByRole('region', { name: 'AI chat' })
    await expect.element(section.getByRole('textbox')).toHaveValue('Always answer in haiku.')

    await section.getByRole('button', { name: 'Use default' }).click()

    await vi.waitFor(() => expect(saved.at(-1)).toMatchObject({ chatSystemPrompt: '' }))
  })

  it('adding an AI prompt persists the full document', async () => {
    await renderScreen()
    const section = page.getByRole('region', { name: 'AI prompts' })

    await section.getByRole('button', { name: /add prompt/i }).click()
    const dialog = page.getByRole('dialog', { name: /add prompt/i })
    await dialog.getByPlaceholder('Translate to French').fill('Translate to French')
    await dialog
      .getByPlaceholder(/Translate the following/)
      .fill('Translate to French.\n\n{{selectedText}}')
    await dialog.getByRole('button', { name: /add prompt/i }).click()

    await vi.waitFor(() =>
      expect(saved).toEqual([
        { editorMarkdownSyntax: 'hide', editorSpellCheck: true, editorDefaultBullet: true, editorBulletAfterHeading: true, editorSmoothCaretAnimation: true, editorTextSize: 'small', editorFullWidth: false, sidebarWidth: 260, contextSidebarWidth: 320, semanticSearchEnabled: false, describeAssets: true, transcriptionFormat: true, contactsEnabled: false, mobileOnboarded: false, mobileStorage: 'local', mobileGraphName: '', theme: 'system', timeFormat: '12h', dateFormat: 'mdy', weekStartDay: 'monday', allNotesFilterTags: ['book', 'link', 'person'], calendarEnabled: false, calendarIds: [], graphColors: {}, aiProviders: [], defaultAiProviderId: null, chatModelSelection: null, chatSystemPrompt: '', aiPrompts: [{ id: expect.any(String), label: 'Translate to French', body: 'Translate to French.\n\n{{selectedText}}', mode: 'replace' }] },
      ]),
    )
    await expect.element(section.getByText('Translate to French', { exact: true })).toBeInTheDocument()
  })

  it('removing a saved AI prompt persists the emptied list', async () => {
    stored = {
      aiPrompts: [
        { id: 'p1', label: 'Translate to French', body: '{{selectedText}}', mode: 'replace' },
      ],
    }
    await renderScreen()
    const section = page.getByRole('region', { name: 'AI prompts' })
    const remove = section.getByRole('button', {
      name: /remove translate to french/i,
    })

    await remove.click()

    await vi.waitFor(() =>
      expect(saved).toEqual([
        { editorMarkdownSyntax: 'hide', editorSpellCheck: true, editorDefaultBullet: true, editorBulletAfterHeading: true, editorSmoothCaretAnimation: true, editorTextSize: 'small', editorFullWidth: false, sidebarWidth: 260, contextSidebarWidth: 320, semanticSearchEnabled: false, describeAssets: true, transcriptionFormat: true, contactsEnabled: false, mobileOnboarded: false, mobileStorage: 'local', mobileGraphName: '', theme: 'system', timeFormat: '12h', dateFormat: 'mdy', weekStartDay: 'monday', allNotesFilterTags: ['book', 'link', 'person'], calendarEnabled: false, calendarIds: [], graphColors: {}, aiProviders: [], defaultAiProviderId: null, chatModelSelection: null, chatSystemPrompt: '', aiPrompts: [] },
      ]),
    )
  })

  it('editing a saved AI prompt persists the change', async () => {
    stored = {
      aiPrompts: [
        { id: 'p1', label: 'Translate to French', body: '{{selectedText}}', mode: 'replace' },
      ],
    }
    await renderScreen()
    const section = page.getByRole('region', { name: 'AI prompts' })
    const edit = section.getByRole('button', { name: /edit translate to french/i })

    await edit.click()
    const dialog = page.getByRole('dialog', { name: /edit prompt/i })
    await dialog.getByPlaceholder('Translate to French').fill('Translate to German')
    await dialog.getByRole('button', { name: /^save$/i }).click()

    await vi.waitFor(() =>
      expect(saved).toEqual([
        { editorMarkdownSyntax: 'hide', editorSpellCheck: true, editorDefaultBullet: true, editorBulletAfterHeading: true, editorSmoothCaretAnimation: true, editorTextSize: 'small', editorFullWidth: false, sidebarWidth: 260, contextSidebarWidth: 320, semanticSearchEnabled: false, describeAssets: true, transcriptionFormat: true, contactsEnabled: false, mobileOnboarded: false, mobileStorage: 'local', mobileGraphName: '', theme: 'system', timeFormat: '12h', dateFormat: 'mdy', weekStartDay: 'monday', allNotesFilterTags: ['book', 'link', 'person'], calendarEnabled: false, calendarIds: [], graphColors: {}, aiProviders: [], defaultAiProviderId: null, chatModelSelection: null, chatSystemPrompt: '', aiPrompts: [{ id: 'p1', label: 'Translate to German', body: '{{selectedText}}', mode: 'replace' }] },
      ]),
    )
  })
})
