import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { setBridge, type EmbedStatus, type GraphInfo } from '@reflect/core'
import { formatFullDate } from '@/lib/dates'
import { resetOperations } from '@/lib/operations'
import { SettingsProvider } from '@/providers/settings-provider'
import { UpdateProvider } from '@/providers/update-provider'
import { SettingsScreen } from './settings-screen'

// The rebuild-index field reads the open index generation (and the Backup
// section the open graph + sync state) from per-graph providers the screen
// tests don't mount, so stub both hooks (backup disconnected).
const graph = vi.hoisted(() => ({
  current: null as GraphInfo | null,
  indexGeneration: 7 as number | null,
  forget: vi.fn<(root: string) => Promise<void>>(async () => {}),
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    graph: graph.current,
    indexGeneration: graph.indexGeneration,
    forget: graph.forget,
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
        default:
          return null
      }
    },
    listen: async () => () => {},
  })
}

let queryClient: QueryClient

async function renderScreen(): Promise<void> {
  await render(
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <UpdateProvider autoCheck={false}>
          <SettingsScreen />
        </UpdateProvider>
      </SettingsProvider>
    </QueryClientProvider>,
  )
}

function radio(name: RegExp) {
  return page.getByRole('radio', { name })
}

beforeEach(() => {
  stored = {}
  embedStatus = { status: 'uninitialized' }
  graph.current = null
  graph.indexGeneration = 7
  graph.forget.mockClear()
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  installFakeBridge()
})

afterEach(() => {
  setBridge(null)
  queryClient.clear()
})

describe('SettingsScreen', () => {
  it('shows update controls when the native bridge is available', async () => {
    await renderScreen()
    await expect.element(page.getByRole('button', { name: /check for updates/i })).toBeInTheDocument()
  })

  it('confirms before forgetting the open graph from saved graphs', async () => {
    graph.current = { root: '/graphs/work', name: 'Work', cloudSync: null, generation: 1 }
    await renderScreen()

    const section = page.getByRole('region', { name: 'Danger zone' })
    await userEvent.click(section.getByRole('button', { name: /forget graph/i }))

    const dialog = page.getByRole('dialog', { name: /forget graph/i })
    await expect.element(dialog.getByText('/graphs/work')).toBeInTheDocument()
    expect(graph.forget).not.toHaveBeenCalled()

    await userEvent.click(dialog.getByRole('button', { name: /forget graph/i }))

    await vi.waitFor(() => expect(graph.forget).toHaveBeenCalledWith('/graphs/work'))
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

    await userEvent.click(radio(/^show/i))

    await vi.waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'show',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
          editorTextSize: 'small',
          semanticSearchEnabled: false,
          describeAssets: true,
          mobileOnboarded: false,
          theme: 'system',
          timeFormat: '12h',
          dateFormat: 'mdy',
          weekStartDay: 'monday',
          allNotesFilterTags: ['book', 'link', 'person'],
          graphColors: {},
          aiProviders: [],
          defaultAiProviderId: null,
          chatModelSelection: null,
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

    await userEvent.click(radio(/^large/i))

    await vi.waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
          editorTextSize: 'large',
          semanticSearchEnabled: false,
          describeAssets: true,
          mobileOnboarded: false,
          theme: 'system',
          timeFormat: '12h',
          dateFormat: 'mdy',
          weekStartDay: 'monday',
          allNotesFilterTags: ['book', 'link', 'person'],
          graphColors: {},
          aiProviders: [],
          defaultAiProviderId: null,
          chatModelSelection: null,
        },
      ]),
    )
    await expect.element(radio(/^large/i)).toBeChecked()
    await expect.element(radio(/^medium/i)).not.toBeChecked()
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

    await userEvent.click(toggle)

    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
    await vi.waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: false,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
          editorTextSize: 'small',
          semanticSearchEnabled: false,
          describeAssets: true,
          mobileOnboarded: false,
          theme: 'system',
          timeFormat: '12h',
          dateFormat: 'mdy',
          weekStartDay: 'monday',
          allNotesFilterTags: ['book', 'link', 'person'],
          graphColors: {},
          aiProviders: [],
          defaultAiProviderId: null,
          chatModelSelection: null,
        },
      ]),
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

    await userEvent.click(toggle)

    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
    await vi.waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: false,
          editorBulletAfterHeading: true,
          editorTextSize: 'small',
          semanticSearchEnabled: false,
          describeAssets: true,
          mobileOnboarded: false,
          theme: 'system',
          timeFormat: '12h',
          dateFormat: 'mdy',
          weekStartDay: 'monday',
          allNotesFilterTags: ['book', 'link', 'person'],
          graphColors: {},
          aiProviders: [],
          defaultAiProviderId: null,
          chatModelSelection: null,
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

    await userEvent.click(toggle)

    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
    await vi.waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: false,
          editorTextSize: 'small',
          semanticSearchEnabled: false,
          describeAssets: true,
          mobileOnboarded: false,
          theme: 'system',
          timeFormat: '12h',
          dateFormat: 'mdy',
          weekStartDay: 'monday',
          allNotesFilterTags: ['book', 'link', 'person'],
          graphColors: {},
          aiProviders: [],
          defaultAiProviderId: null,
          chatModelSelection: null,
        },
      ]),
    )
  })

  it('reflects the persisted theme and persists a new choice', async () => {
    stored = { theme: 'dark' }
    await renderScreen()
    await expect.element(radio(/^dark/i)).toBeChecked()

    // The theme radios are visually hidden (sr-only) cards, so Playwright won't
    // click them; a native click on the input still fires its onChange.
    const lightRadio = radio(/^light/i).element() as HTMLElement
    lightRadio.click()

    await expect.element(radio(/^light/i)).toBeChecked()
    await vi.waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
          editorTextSize: 'small',
          semanticSearchEnabled: false,
          describeAssets: true,
          mobileOnboarded: false,
          theme: 'light',
          timeFormat: '12h',
          dateFormat: 'mdy',
          weekStartDay: 'monday',
          allNotesFilterTags: ['book', 'link', 'person'],
          graphColors: {},
          aiProviders: [],
          defaultAiProviderId: null,
          chatModelSelection: null,
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

    // Open the listbox and pick the option (the real pointer path works here).
    await userEvent.click(trigger)
    await userEvent.click(page.getByRole('option', { name: formatFullDate(new Date(), 'dmy') }))

    await expect.element(trigger).toHaveTextContent(formatFullDate(new Date(), 'dmy'))
    await vi.waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
          editorTextSize: 'small',
          semanticSearchEnabled: false,
          describeAssets: true,
          mobileOnboarded: false,
          theme: 'system',
          timeFormat: '12h',
          dateFormat: 'dmy',
          weekStartDay: 'monday',
          allNotesFilterTags: ['book', 'link', 'person'],
          graphColors: {},
          aiProviders: [],
          defaultAiProviderId: null,
          chatModelSelection: null,
        },
      ]),
    )
  })

  it('shows the week start setting in Date & time', async () => {
    await renderScreen()
    const dateTime = page.getByRole('region', { name: 'Date & time' })
    const appearance = page.getByRole('region', { name: 'Appearance' })

    await expect.element(dateTime.getByRole('combobox', { name: 'Start week on' })).toBeInTheDocument()
    await expect
      .element(appearance.getByRole('combobox', { name: 'Start week on' }))
      .not.toBeInTheDocument()
  })

  it('selecting Sunday persists the week start day', async () => {
    await renderScreen()
    const trigger = page.getByRole('combobox', { name: 'Start week on' })
    await expect.element(trigger).toHaveTextContent('Monday')

    await userEvent.click(trigger)
    await userEvent.click(page.getByRole('option', { name: 'Sunday' }))

    await expect.element(trigger).toHaveTextContent('Sunday')
    await vi.waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
          editorTextSize: 'small',
          semanticSearchEnabled: false,
          describeAssets: true,
          mobileOnboarded: false,
          theme: 'system',
          timeFormat: '12h',
          dateFormat: 'mdy',
          weekStartDay: 'sunday',
          allNotesFilterTags: ['book', 'link', 'person'],
          graphColors: {},
          aiProviders: [],
          defaultAiProviderId: null,
          chatModelSelection: null,
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

    // Open the listbox and pick the option (the real pointer path works here).
    await userEvent.click(trigger)
    await userEvent.click(page.getByRole('option', { name: '24-hour' }))

    await expect.element(trigger).toHaveTextContent('24-hour')
    await vi.waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
          editorTextSize: 'small',
          semanticSearchEnabled: false,
          describeAssets: true,
          mobileOnboarded: false,
          theme: 'system',
          timeFormat: '24h',
          dateFormat: 'mdy',
          weekStartDay: 'monday',
          allNotesFilterTags: ['book', 'link', 'person'],
          graphColors: {},
          aiProviders: [],
          defaultAiProviderId: null,
          chatModelSelection: null,
        },
      ]),
    )
  })

  it('adds an All Notes filter tag, normalized, and persists it', async () => {
    await renderScreen()
    const input = page.getByLabelText('Add filter tag')

    await userEvent.fill(input, ' #Meeting ')
    await userEvent.click(page.getByRole('button', { name: 'Add', exact: true }))

    await expect.element(page.getByText('#meeting')).toBeInTheDocument()
    await vi.waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
          editorTextSize: 'small',
          semanticSearchEnabled: false,
          describeAssets: true,
          mobileOnboarded: false,
          theme: 'system',
          timeFormat: '12h',
          dateFormat: 'mdy',
          weekStartDay: 'monday',
          allNotesFilterTags: ['book', 'link', 'person', 'meeting'],
          graphColors: {},
          aiProviders: [],
          defaultAiProviderId: null,
          chatModelSelection: null,
        },
      ]),
    )
  })

  it('rejects a tag name outside the #tag grammar with an inline error', async () => {
    await renderScreen()
    const input = page.getByLabelText('Add filter tag')
    const inputEl = input.element()
    if (!(inputEl instanceof HTMLInputElement)) {
      throw new Error('expected an <input>')
    }

    await userEvent.fill(input, 'my tag')
    await userEvent.click(page.getByRole('button', { name: 'Add', exact: true }))

    await expect.element(page.getByRole('alert')).toHaveTextContent(`"my tag" can't be a tag`)
    // The draft stays put for fixing, and nothing reaches the store.
    expect(inputEl.value).toBe('my tag')
    await vi.waitFor(() => expect(saved).toEqual([]))
  })

  it('ignores adding a duplicate filter tag', async () => {
    stored = { allNotesFilterTags: ['book'] }
    await renderScreen()
    // Defaults render before the disk document lands, so wait for hydration
    // (the stored list has no `person`) so the click edits the loaded list.
    await expect.element(page.getByText('#person')).not.toBeInTheDocument()
    await expect.element(page.getByText('#book')).toBeInTheDocument()

    await userEvent.fill(page.getByLabelText('Add filter tag'), 'BOOK')
    await userEvent.click(page.getByRole('button', { name: 'Add', exact: true }))

    await vi.waitFor(() => expect(saved).toEqual([]))
  })

  it('removes a filter tag and persists the rest', async () => {
    stored = { allNotesFilterTags: ['book', 'person'] }
    await renderScreen()
    // Wait for hydration (the stored list has no `link`), not just defaults.
    await expect.element(page.getByText('#link')).not.toBeInTheDocument()
    await expect.element(page.getByText('#book')).toBeInTheDocument()

    await userEvent.click(page.getByRole('button', { name: 'Remove book' }))

    await expect.element(page.getByText('#book')).not.toBeInTheDocument()
    await vi.waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
          editorTextSize: 'small',
          semanticSearchEnabled: false,
          describeAssets: true,
          mobileOnboarded: false,
          theme: 'system',
          timeFormat: '12h',
          dateFormat: 'mdy',
          weekStartDay: 'monday',
          allNotesFilterTags: ['person'],
          graphColors: {},
          aiProviders: [],
          defaultAiProviderId: null,
          chatModelSelection: null,
        },
      ]),
    )
  })

  it('enabling semantic search persists the opt-in', async () => {
    await renderScreen()

    await userEvent.click(page.getByRole('button', { name: /enable semantic search/i }))

    await vi.waitFor(() =>
      expect(saved).toEqual([
        { editorMarkdownSyntax: 'hide', editorSpellCheck: true, editorDefaultBullet: true, editorBulletAfterHeading: true, editorTextSize: 'small', semanticSearchEnabled: true, describeAssets: true, mobileOnboarded: false, theme: 'system', timeFormat: '12h', dateFormat: 'mdy', weekStartDay: 'monday', allNotesFilterTags: ['book', 'link', 'person'], graphColors: {}, aiProviders: [], defaultAiProviderId: null, chatModelSelection: null },
      ]),
    )
    // The control flips to the loading state (EmbeddingsSync owns the actual
    // download; the runtime here still reports `uninitialized`).
    await expect.element(page.getByRole('progressbar', { name: /model download/i })).toBeInTheDocument()
  })

  it('shows byte-level progress while the model downloads', async () => {
    stored = { semanticSearchEnabled: true }
    embedStatus = { status: 'loading', progress: { downloaded: 45_000_000, total: 90_000_000 } }
    await renderScreen()

    const bar = page.getByRole('progressbar', { name: /model download/i })
    await expect.element(bar).toHaveAttribute('aria-valuenow', '50')
    await expect.element(page.getByText(/Downloading the model.*45 MB of 90 MB/)).toBeInTheDocument()
  })

  it('shows the downloaded model once ready and persists a disable', async () => {
    stored = { semanticSearchEnabled: true }
    embedStatus = { status: 'ready', model: 'all-MiniLM-L6-v2' }
    await renderScreen()

    await expect.element(page.getByText(/model downloaded \(all-MiniLM-L6-v2\)/i)).toBeInTheDocument()

    await userEvent.click(page.getByRole('button', { name: /disable/i }))

    await vi.waitFor(() =>
      expect(saved).toEqual([
        { editorMarkdownSyntax: 'hide', editorSpellCheck: true, editorDefaultBullet: true, editorBulletAfterHeading: true, editorTextSize: 'small', semanticSearchEnabled: false, describeAssets: true, mobileOnboarded: false, theme: 'system', timeFormat: '12h', dateFormat: 'mdy', weekStartDay: 'monday', allNotesFilterTags: ['book', 'link', 'person'], graphColors: {}, aiProviders: [], defaultAiProviderId: null, chatModelSelection: null },
      ]),
    )
    await expect.element(page.getByRole('button', { name: /enable semantic search/i })).toBeInTheDocument()
    // Disabling is immediate (every semantic consumer gates on the setting),
    // so there is no "takes effect on the next launch" caveat to show even
    // while the runtime still reports `ready`.
    await expect.element(page.getByText(/next launch/i)).not.toBeInTheDocument()
  })

  it('re-enabling after a failed load retries the download', async () => {
    embedStatus = { status: 'failed', message: 'offline' }
    await renderScreen()

    await userEvent.click(page.getByRole('button', { name: /enable semantic search/i }))

    // The opt-in persists AND the broken runtime gets a fresh embed_ensure.
    // EmbeddingsSync only loads `uninitialized` runtimes, so the explicit
    // action carries the retry.
    await vi.waitFor(() => expect(invoked).toContain('embed_ensure'))
    await vi.waitFor(() =>
      expect(saved).toEqual([
        { editorMarkdownSyntax: 'hide', editorSpellCheck: true, editorDefaultBullet: true, editorBulletAfterHeading: true, editorTextSize: 'small', semanticSearchEnabled: true, describeAssets: true, mobileOnboarded: false, theme: 'system', timeFormat: '12h', dateFormat: 'mdy', weekStartDay: 'monday', allNotesFilterTags: ['book', 'link', 'person'], graphColors: {}, aiProviders: [], defaultAiProviderId: null, chatModelSelection: null },
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

    // Backing out after a failure must work too: the opt-in isn't a trap.
    await userEvent.click(page.getByRole('button', { name: /disable/i }))

    await vi.waitFor(() =>
      expect(saved).toEqual([
        { editorMarkdownSyntax: 'hide', editorSpellCheck: true, editorDefaultBullet: true, editorBulletAfterHeading: true, editorTextSize: 'small', semanticSearchEnabled: false, describeAssets: true, mobileOnboarded: false, theme: 'system', timeFormat: '12h', dateFormat: 'mdy', weekStartDay: 'monday', allNotesFilterTags: ['book', 'link', 'person'], graphColors: {}, aiProviders: [], defaultAiProviderId: null, chatModelSelection: null },
      ]),
    )
    await expect.element(page.getByRole('button', { name: /enable semantic search/i })).toBeInTheDocument()
  })

  it('rebuilding the index wipes and re-applies the projection through the bridge', async () => {
    try {
      await renderScreen()

      await userEvent.click(page.getByRole('button', { name: /rebuild index/i }))

      // The whole chain: button -> rebuildIndexVisibly -> wipe, then the
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
    await expect.element(page.getByRole('button', { name: /rebuild index/i })).toBeDisabled()
  })

  it('lists registered shortcuts from both keymap scopes', async () => {
    await renderScreen()
    // App scope (command titles) and editor scope (binding descriptions).
    await expect.element(page.getByText('Toggle sidebar')).toBeInTheDocument()
    await expect.element(page.getByText('Go to today')).toBeInTheDocument()
    await expect.element(page.getByText('Bold')).toBeInTheDocument()
    await expect.element(page.getByText('Heading 1')).toBeInTheDocument()
  })
})
