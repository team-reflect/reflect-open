import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge, type EmbedStatus, type GraphInfo } from '@reflect/core'
import { formatFullDate } from '@/lib/dates'
import { resetOperations } from '@/lib/operations'
import { SettingsProvider } from '@/providers/settings-provider'
import { UpdateProvider } from '@/providers/update-provider'
import { SettingsScreen } from './settings-screen'

// The rebuild-index field reads the open index generation — and the Backup
// section the open graph + sync state — from per-graph providers the screen
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

// jsdom doesn't implement this; Radix Select scrolls the selected option into
// view when the listbox opens.
Element.prototype.scrollIntoView ??= () => {}

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

function renderScreen(): void {
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <UpdateProvider autoCheck={false}>
          <SettingsScreen />
        </UpdateProvider>
      </SettingsProvider>
    </QueryClientProvider>,
  )
}

function radio(name: RegExp): HTMLInputElement {
  const element = screen.getByRole('radio', { name })
  if (!(element instanceof HTMLInputElement)) {
    throw new Error('expected an <input type="radio">')
  }
  return element
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
  cleanup() // `globals: false` disables testing-library's automatic cleanup
  setBridge(null)
  queryClient.clear()
})

describe('SettingsScreen', () => {
  it('shows update controls when the native bridge is available', () => {
    renderScreen()
    expect(screen.getByRole('button', { name: /check for updates/i })).toBeTruthy()
  })

  it('confirms before forgetting the open graph from saved graphs', async () => {
    graph.current = { root: '/graphs/work', name: 'Work', cloudSync: null, generation: 1 }
    renderScreen()

    const section = screen.getByRole('region', { name: 'Danger zone' })
    fireEvent.click(within(section).getByRole('button', { name: /forget graph/i }))

    const dialog = screen.getByRole('dialog', { name: /forget graph/i })
    expect(within(dialog).getByText('/graphs/work')).toBeTruthy()
    expect(graph.forget).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: /forget graph/i }))

    await waitFor(() => expect(graph.forget).toHaveBeenCalledWith('/graphs/work'))
  })

  it('reflects the persisted markdown syntax mode', async () => {
    stored = { editorMarkdownSyntax: 'show' }
    renderScreen()
    await waitFor(() => expect(radio(/^show/i).checked).toBe(true))
    expect(radio(/^hide/i).checked).toBe(false)
  })

  it('selecting Show applies instantly and persists', async () => {
    renderScreen()
    await waitFor(() => expect(radio(/^hide/i).checked).toBe(true))

    fireEvent.click(radio(/^show/i))

    await waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'show',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
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
    expect(radio(/^show/i).checked).toBe(true)
    expect(radio(/^hide/i).checked).toBe(false)
  })

  it('reflects a persisted spell check opt-out', async () => {
    stored = { editorSpellCheck: false }
    renderScreen()
    const toggle = screen.getByRole('switch', { name: /spell check/i })
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
  })

  it('toggling spell check off applies instantly and persists', async () => {
    renderScreen()
    const toggle = screen.getByRole('switch', { name: /spell check/i })
    // On by default.
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: false,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
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
    renderScreen()
    const toggle = screen.getByRole('switch', { name: /start with a bullet/i })
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
  })

  it('toggling the default bullet off applies instantly and persists', async () => {
    renderScreen()
    const toggle = screen.getByRole('switch', { name: /start with a bullet/i })
    // On by default.
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: false,
          editorBulletAfterHeading: true,
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
    renderScreen()
    const toggle = screen.getByRole('switch', { name: /bullet after a heading/i })
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
  })

  it('toggling bullet-after-heading off persists independently of the seed bullet', async () => {
    renderScreen()
    const toggle = screen.getByRole('switch', { name: /bullet after a heading/i })
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: false,
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
    renderScreen()
    await waitFor(() => expect(radio(/^dark/i).checked).toBe(true))

    fireEvent.click(radio(/^light/i))

    expect(radio(/^light/i).checked).toBe(true)
    await waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
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
    renderScreen()
    const trigger = screen.getByRole('combobox', { name: 'Date format' })
    // The options label themselves with today's date in each order.
    await waitFor(() => expect(trigger.textContent).toContain(formatFullDate(new Date(), 'dmy')))
  })

  it('selecting day-month-year persists the date format', async () => {
    renderScreen()
    const trigger = screen.getByRole('combobox', { name: 'Date format' })
    await waitFor(() => expect(trigger.textContent).toContain(formatFullDate(new Date(), 'mdy')))

    // Keyboard-driven (the pointer path needs capture APIs jsdom lacks).
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(
      await screen.findByRole('option', { name: formatFullDate(new Date(), 'dmy') }),
      { key: 'Enter' },
    )

    expect(trigger.textContent).toContain(formatFullDate(new Date(), 'dmy'))
    await waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
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
    renderScreen()
    const dateTime = screen.getByRole('region', { name: 'Date & time' })
    const appearance = screen.getByRole('region', { name: 'Appearance' })

    await waitFor(() =>
      expect(within(dateTime).getByRole('combobox', { name: 'Start week on' })).toBeTruthy(),
    )
    expect(within(appearance).queryByRole('combobox', { name: 'Start week on' })).toBeNull()
  })

  it('selecting Sunday persists the week start day', async () => {
    renderScreen()
    const trigger = screen.getByRole('combobox', { name: 'Start week on' })
    await waitFor(() => expect(trigger.textContent).toContain('Monday'))

    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(await screen.findByRole('option', { name: 'Sunday' }), { key: 'Enter' })

    expect(trigger.textContent).toContain('Sunday')
    await waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
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
    renderScreen()
    const trigger = screen.getByRole('combobox', { name: 'Time format' })
    await waitFor(() => expect(trigger.textContent).toContain('24-hour'))
  })

  it('selecting 24-hour persists the time format', async () => {
    renderScreen()
    const trigger = screen.getByRole('combobox', { name: 'Time format' })
    await waitFor(() => expect(trigger.textContent).toContain('12-hour'))

    // Keyboard-driven (the pointer path needs capture APIs jsdom lacks).
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(await screen.findByRole('option', { name: '24-hour' }), { key: 'Enter' })

    expect(trigger.textContent).toContain('24-hour')
    await waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
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
    renderScreen()
    const input = screen.getByLabelText('Add filter tag')

    fireEvent.change(input, { target: { value: ' #Meeting ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(screen.getByText('#meeting')).toBeTruthy()
    await waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
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
    renderScreen()
    const input = screen.getByLabelText('Add filter tag')
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('expected an <input>')
    }

    fireEvent.change(input, { target: { value: 'my tag' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(screen.getByRole('alert').textContent).toContain(`"my tag" can't be a tag`)
    // The draft stays put for fixing, and nothing reaches the store.
    expect(input.value).toBe('my tag')
    await waitFor(() => expect(saved).toEqual([]))
  })

  it('ignores adding a duplicate filter tag', async () => {
    stored = { allNotesFilterTags: ['book'] }
    renderScreen()
    // Defaults render before the disk document lands — wait for hydration
    // (the stored list has no `person`) so the click edits the loaded list.
    await waitFor(() => expect(screen.queryByText('#person')).toBeNull())
    expect(screen.getByText('#book')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Add filter tag'), { target: { value: 'BOOK' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(saved).toEqual([]))
  })

  it('removes a filter tag and persists the rest', async () => {
    stored = { allNotesFilterTags: ['book', 'person'] }
    renderScreen()
    // Wait for hydration (the stored list has no `link`), not just defaults.
    await waitFor(() => expect(screen.queryByText('#link')).toBeNull())
    expect(screen.getByText('#book')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Remove book' }))

    expect(screen.queryByText('#book')).toBeNull()
    await waitFor(() =>
      expect(saved).toEqual([
        {
          editorMarkdownSyntax: 'hide',
          editorSpellCheck: true,
          editorDefaultBullet: true,
          editorBulletAfterHeading: true,
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
    renderScreen()
    const enable = await screen.findByRole('button', { name: /enable semantic search/i })

    fireEvent.click(enable)

    await waitFor(() =>
      expect(saved).toEqual([
        { editorMarkdownSyntax: 'hide', editorSpellCheck: true, editorDefaultBullet: true, editorBulletAfterHeading: true, semanticSearchEnabled: true, describeAssets: true, mobileOnboarded: false, theme: 'system', timeFormat: '12h', dateFormat: 'mdy', weekStartDay: 'monday', allNotesFilterTags: ['book', 'link', 'person'], graphColors: {}, aiProviders: [], defaultAiProviderId: null, chatModelSelection: null },
      ]),
    )
    // The control flips to the loading state (EmbeddingsSync owns the actual
    // download; the runtime here still reports `uninitialized`).
    expect(screen.getByRole('progressbar', { name: /model download/i })).toBeTruthy()
  })

  it('shows byte-level progress while the model downloads', async () => {
    stored = { semanticSearchEnabled: true }
    embedStatus = { status: 'loading', progress: { downloaded: 45_000_000, total: 90_000_000 } }
    renderScreen()

    const bar = await screen.findByRole('progressbar', { name: /model download/i })
    await waitFor(() => expect(bar.getAttribute('aria-valuenow')).toBe('50'))
    expect(screen.getByText('Downloading the model — 45 MB of 90 MB')).toBeTruthy()
  })

  it('shows the downloaded model once ready and persists a disable', async () => {
    stored = { semanticSearchEnabled: true }
    embedStatus = { status: 'ready', model: 'all-MiniLM-L6-v2' }
    renderScreen()

    expect(await screen.findByText(/model downloaded \(all-MiniLM-L6-v2\)/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /disable/i }))

    await waitFor(() =>
      expect(saved).toEqual([
        { editorMarkdownSyntax: 'hide', editorSpellCheck: true, editorDefaultBullet: true, editorBulletAfterHeading: true, semanticSearchEnabled: false, describeAssets: true, mobileOnboarded: false, theme: 'system', timeFormat: '12h', dateFormat: 'mdy', weekStartDay: 'monday', allNotesFilterTags: ['book', 'link', 'person'], graphColors: {}, aiProviders: [], defaultAiProviderId: null, chatModelSelection: null },
      ]),
    )
    expect(screen.getByRole('button', { name: /enable semantic search/i })).toBeTruthy()
    // Disabling is immediate — every semantic consumer gates on the setting,
    // so there is no "takes effect on the next launch" caveat to show even
    // while the runtime still reports `ready`.
    expect(screen.queryByText(/next launch/i)).toBeNull()
  })

  it('re-enabling after a failed load retries the download', async () => {
    embedStatus = { status: 'failed', message: 'offline' }
    renderScreen()
    const enable = await screen.findByRole('button', { name: /enable semantic search/i })

    fireEvent.click(enable)

    // The opt-in persists AND the broken runtime gets a fresh embed_ensure —
    // EmbeddingsSync only loads `uninitialized` runtimes, so the explicit
    // action carries the retry.
    await waitFor(() => expect(invoked).toContain('embed_ensure'))
    await waitFor(() =>
      expect(saved).toEqual([
        { editorMarkdownSyntax: 'hide', editorSpellCheck: true, editorDefaultBullet: true, editorBulletAfterHeading: true, semanticSearchEnabled: true, describeAssets: true, mobileOnboarded: false, theme: 'system', timeFormat: '12h', dateFormat: 'mdy', weekStartDay: 'monday', allNotesFilterTags: ['book', 'link', 'person'], graphColors: {}, aiProviders: [], defaultAiProviderId: null, chatModelSelection: null },
      ]),
    )
  })

  it('surfaces a failed load with retry and disable affordances', async () => {
    stored = { semanticSearchEnabled: true }
    embedStatus = { status: 'failed', message: 'no disk space' }
    renderScreen()

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/no disk space/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy()

    // Backing out after a failure must work too — the opt-in isn't a trap.
    fireEvent.click(screen.getByRole('button', { name: /disable/i }))

    await waitFor(() =>
      expect(saved).toEqual([
        { editorMarkdownSyntax: 'hide', editorSpellCheck: true, editorDefaultBullet: true, editorBulletAfterHeading: true, semanticSearchEnabled: false, describeAssets: true, mobileOnboarded: false, theme: 'system', timeFormat: '12h', dateFormat: 'mdy', weekStartDay: 'monday', allNotesFilterTags: ['book', 'link', 'person'], graphColors: {}, aiProviders: [], defaultAiProviderId: null, chatModelSelection: null },
      ]),
    )
    expect(screen.getByRole('button', { name: /enable semantic search/i })).toBeTruthy()
  })

  it('rebuilding the index wipes and re-applies the projection through the bridge', async () => {
    try {
      renderScreen()

      fireEvent.click(screen.getByRole('button', { name: /rebuild index/i }))

      // The whole chain: button → rebuildIndexVisibly → wipe, then the
      // projection-version stamp that marks a completed rebuild. (The graph is
      // empty here, so there is no apply batch in between.)
      await waitFor(() => expect(invoked).toContain('index_clear'))
      await waitFor(() => expect(invoked).toContain('index_meta_set'))
    } finally {
      resetOperations()
    }
  })

  it('disables the index rebuild until a graph index is open', () => {
    graph.indexGeneration = null
    renderScreen()
    const button = screen.getByRole('button', { name: /rebuild index/i })
    expect(button.hasAttribute('disabled')).toBe(true)
  })

  it('lists registered shortcuts from both keymap scopes', () => {
    renderScreen()
    // App scope (command titles) and editor scope (binding descriptions).
    expect(screen.getByText('Toggle sidebar')).toBeTruthy()
    expect(screen.getByText('Go to today')).toBeTruthy()
    expect(screen.getByText('Bold')).toBeTruthy()
    expect(screen.getByText('Heading 1')).toBeTruthy()
  })
})
