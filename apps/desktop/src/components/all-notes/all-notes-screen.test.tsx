import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type { ReactElement } from 'react'
import { setBridge } from '@reflect/core'
import { resetOperations, useOperations } from '@/lib/operations'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { RouterProvider, useRouter } from '@/routing/router'
import { expectLocatorToHaveCount } from '@/test-utils/expect'
import { AllNotesScreen } from './all-notes-screen'

/**
 * The All Notes screen over the real query layer and a fake IPC bridge: rows
 * from compiled SQL, tag tabs from settings, the Custom menu from the facet
 * query, and navigation through the real router.
 */

const settingsState = vi.hoisted((): { dateFormat: 'mdy' | 'dmy' | 'iso' } => ({
  dateFormat: 'mdy',
}))
const openRouteInNewWindow = vi.hoisted(() => vi.fn<() => Promise<boolean>>())

vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    graph: { root: '/g', name: 'g', generation: 1 },
    indexing: false,
  }),
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: {
      editorMarkdownSyntax: 'hide',
      theme: 'system',
      timeFormat: '12h',
      dateFormat: settingsState.dateFormat,
      allNotesFilterTags: ['book', 'person'],
    },
    updateSettings: () => {},
  }),
}))
vi.mock('@/lib/windows/open-in-new-window', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/windows/open-in-new-window')>()),
  openRouteInNewWindow,
}))

// Deterministic regardless of the test run's clock: both timestamps are far in
// the past, so the Updated column always renders the short-date form.
const HEALTH_MTIME = new Date(2020, 0, 15, 12, 0).getTime()
const TOKYO_MTIME = new Date(2020, 0, 10, 12, 0).getTime()

const noteRows = [
  {
    path: 'notes/health.md',
    title: 'Health Stacked',
    mtime: HEALTH_MTIME,
    preview: 'Shop your health goals.',
  },
  {
    path: 'notes/tokyo.md',
    title: 'Tokyo Gâteau',
    mtime: TOKYO_MTIME,
    preview: 'Dandelion chocolate.',
  },
]
const taggedDailyRow = {
  path: 'daily/2026-06-09.md',
  title: 'June 9, 2026',
  mtime: TOKYO_MTIME,
  preview: 'Daily travel notes.',
}
const tagRows = [
  { note_path: 'notes/health.md', tag: 'link' },
  { note_path: 'notes/tokyo.md', tag: 'link' },
  { note_path: 'daily/2026-06-09.md', tag: 'travel' },
]
const facetRows = [
  { tag: 'book', count: 3 },
  { tag: 'travel', count: 2 },
]

const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

setBridge({ invoke: mockInvoke, listen: async () => () => {} })

const manyNoteRows = Array.from({ length: 1000 }, (_, index) => ({
  path: `notes/n${index}.md`,
  title: `Note ${index}`,
  mtime: 1_000_000 - index,
  preview: '',
}))

function mockManyNotes(): void {
  mockInvoke.mockImplementation(async (command, args) => {
    if (command !== 'db_query') {
      return null
    }
    const sql = String(args['sql'])
    if (sql.includes('"preview"')) {
      return manyNoteRows
    }
    return []
  })
}

beforeEach(() => {
  resetOperations()
  settingsState.dateFormat = 'mdy'
  openRouteInNewWindow.mockReset().mockResolvedValue(true)
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command, args) => {
    if (command !== 'db_query') {
      return null
    }
    const sql = String(args['sql'])
    const params = args['params'] as unknown[]
    if (sql.includes('group by')) {
      return facetRows
    }
    if (sql.includes('"preview"')) {
      // A tag-filtered list starts from the folded tag key — only `travel`
      // has matches in this fixture.
      if (sql.includes('from "tags"')) {
        return params.includes('travel') ? [taggedDailyRow] : []
      }
      return noteRows
    }
    if (sql.includes('from "tags"')) {
      // The per-note tags fetch (a join, not an IN list); rows for unlisted
      // paths are ignored by the grouping, so always answer in full.
      return tagRows
    }
    return []
  })
})

function RouteProbe(): ReactElement {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

/** Surfaces the operations store so tests can assert a failure was reported. */
function OperationsProbe(): ReactElement {
  const operations = useOperations()
  return (
    <output data-testid="operations">
      {operations.map((operation) => `${operation.status}:${operation.message ?? ''}`).join('|')}
    </output>
  )
}

function RoutedScreen(): ReactElement {
  const { route } = useRouter()
  return <AllNotesScreen tag={route.kind === 'allNotes' ? route.tag : null} />
}

/** Navigates to the already-active route — the sidebar-click-while-here case. */
function ReArrive(): ReactElement {
  const { navigate } = useRouter()
  return (
    <button type="button" data-testid="re-arrive" onClick={() => navigate({ kind: 'allNotes', tag: null })}>
      re-arrive
    </button>
  )
}

function renderScreen(
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider initialRoute={{ kind: 'allNotes', tag: null }}>
        {/* The screen fills its container (`h-full`); hand it the viewport
            height so the scroll container gets a real, bounded size. */}
        <div style={{ height: '100vh' }}>
          <RoutedScreen />
        </div>
        <RouteProbe />
        <OperationsProbe />
        <ReArrive />
      </RouterProvider>
    </QueryClientProvider>,
  )
}

function probedRoute(view: Awaited<ReturnType<typeof renderScreen>>): unknown {
  return JSON.parse(view.getByTestId('route').element().textContent ?? 'null')
}

describe('AllNotesScreen', () => {
  it('lists non-daily notes with subject, snippet, tags, and updated columns', async () => {
    const view = await renderScreen()

    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()
    await expect.element(view.getByText('Shop your health goals.')).toBeInTheDocument()
    await expect.element(view.getByText('Tokyo Gâteau')).toBeInTheDocument()
    await expectLocatorToHaveCount(view.getByText('#link'), 2)
    await expect.element(view.getByText('1/15/2020')).toBeInTheDocument()
    await expect.element(view.getByText('1/10/2020')).toBeInTheDocument()
    await view.unmount()
  })

  it('keeps ISO updated dates on one line', async () => {
    settingsState.dateFormat = 'iso'
    const view = await renderScreen()

    const updated = view.getByText('2020-01-15')
    await expect.element(updated).toHaveClass('whitespace-nowrap')
    expect(updated.element().parentElement?.className ?? '').toContain(
      'grid-cols-[minmax(0,15rem)_minmax(0,1fr)_minmax(0,8rem)_6rem]',
    )
    await view.unmount()
  })

  it('renders a dash, not an epoch date, for a row missing its mtime', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      if (command !== 'db_query') {
        return null
      }
      const sql = String(args['sql'])
      if (sql.includes('group by')) {
        return facetRows
      }
      if (sql.includes('"preview"')) {
        return [{ path: 'notes/legacy.md', title: 'Legacy Note', mtime: 0, preview: '' }]
      }
      return []
    })
    const view = await renderScreen()

    await expect.element(view.getByText('Legacy Note')).toBeInTheDocument()
    await expect.element(view.getByText('—')).toBeInTheDocument()
    await view.unmount()
  })

  it('opens a note when its row is clicked', async () => {
    const view = await renderScreen()

    await view.getByRole('button', { name: /Health Stacked/ }).click()

    expect(probedRoute(view)).toEqual({ kind: 'note', path: 'notes/health.md' })
    await view.unmount()
  })

  it('opens a modifier-clicked note subject in a new window without selecting its row', async () => {
    const view = await renderScreen()

    await view.getByRole('button', { name: 'Health Stacked' }).click({ modifiers: ['Meta'] })

    await vi.waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({
        kind: 'note',
        path: 'notes/health.md',
      }),
    )
    expect(probedRoute(view)).toEqual({ kind: 'allNotes', tag: null })
    expect(view.getByRole('button', { name: /Trash \(/ }).query()).toBeNull()
    await view.unmount()
  })

  it('keeps a modifier-double-click from navigating the current window', async () => {
    const view = await renderScreen()
    const subject = view.getByRole('button', { name: 'Health Stacked' })

    await subject.dblClick({ modifiers: ['Meta'] })

    await vi.waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({
        kind: 'note',
        path: 'notes/health.md',
      }),
    )
    expect(openRouteInNewWindow).toHaveBeenCalledTimes(1)
    expect(probedRoute(view)).toEqual({ kind: 'allNotes', tag: null })
    await view.unmount()
  })

  it('renders pinned tags from settings as tabs and filters through the route', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await expect.element(view.getByRole('button', { name: '#person' })).toBeInTheDocument()
    await view.getByRole('button', { name: '#book' }).click()

    expect(probedRoute(view)).toEqual({ kind: 'allNotes', tag: 'book' })
    await expect.element(view.getByText('No notes tagged #book.')).toBeInTheDocument()
    expect(view.getByText('Health Stacked').query()).toBeNull()
    await view.unmount()
  })

  it('re-anchors to the top when re-arriving on the same route', async () => {
    mockManyNotes()
    const view = await renderScreen()
    await expect.element(view.getByText('Note 0', { exact: true })).toBeInTheDocument()

    const scroller = view.getByTestId('all-notes-scroll').element()
    scroller.scrollTop = 400
    expect(scroller.scrollTop).toBe(400)

    // Same-route navigation pushes no entry, but the router clears the saved
    // offset and bumps arrivalSeq — the list must re-anchor, not stay put.
    await view.getByTestId('re-arrive').click()

    await vi.waitFor(() => expect(scroller.scrollTop).toBe(0))
    await view.unmount()
  })

  it('renders rows from a warm cache without a refetch', async () => {
    // The app client uses staleTime: Infinity, so returning to All Notes with
    // fresh cached data commits exactly one render — no fetch, no follow-up.
    // virtua windows against its parent (the scroll container) and measures it a
    // microtask later, so the rows arrive a tick after that lone render. The
    // regression guarded here is a permanently blank list, not the tick.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    client.setQueryData(
      [INDEX_QUERY_SCOPE, '/g', 'all-notes', null],
      [
        {
          path: 'notes/health.md',
          title: 'Health Stacked',
          snippet: 'Shop your health goals.',
          tags: ['link'],
          mtime: HEALTH_MTIME,
        },
        {
          path: 'notes/tokyo.md',
          title: 'Tokyo Gâteau',
          snippet: 'Dandelion chocolate.',
          tags: ['link'],
          mtime: TOKYO_MTIME,
        },
      ],
    )
    client.setQueryData([INDEX_QUERY_SCOPE, '/g', 'all-notes-tags'], facetRows)

    const view = await renderScreen(client)

    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()
    await expect.element(view.getByText('Tokyo Gâteau')).toBeInTheDocument()
    await view.unmount()
  })

  it('virtualizes long lists instead of rendering every row', async () => {
    mockManyNotes()

    const view = await renderScreen()

    await expect.element(view.getByText('Note 0', { exact: true })).toBeInTheDocument()
    const rendered = view.getByTestId('all-notes-scroll').element().querySelectorAll('li')
    expect(rendered.length).toBeGreaterThan(0)
    // The list is uncapped, but only the scroll window (plus buffer) mounts.
    expect(rendered.length).toBeLessThan(100)
    await view.unmount()
  })

  it('offers unpinned tags in the Custom combobox and shows the chosen one', async () => {
    const view = await renderScreen()

    // `book` is pinned, so the combobox offers only `travel` (with its count).
    await view.getByRole('button', { name: 'Custom' }).click()
    const listbox = page.getByRole('listbox')
    await expect.element(listbox).toHaveTextContent('#travel')
    await expect.element(listbox).toHaveTextContent('2')
    expect(listbox.element().textContent).not.toContain('#book')

    await page.getByRole('option', { name: /#travel/ }).click()

    expect(probedRoute(view)).toEqual({ kind: 'allNotes', tag: 'travel' })
    await expect.element(view.getByText('June 9, 2026')).toBeInTheDocument()
    await expect.element(view.getByText('Daily travel notes.')).toBeInTheDocument()
    expect(view.getByText('Health Stacked').query()).toBeNull()
    // The trigger adopts the active custom tag.
    await expect
      .element(view.getByRole('button', { name: /#travel/, expanded: false }))
      .toBeInTheDocument()
    await view.getByRole('button', { name: 'June 9, 2026' }).click()
    expect(probedRoute(view)).toEqual({ kind: 'daily', date: '2026-06-09' })
    await view.unmount()
  })

  it('filters by an arbitrary typed tag from the Custom combobox', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByRole('button', { name: 'Custom' }).click()
    const input = page.getByPlaceholder('Filter by any tag…')

    // An exact existing tag isn't duplicated as a "Filter by" item.
    await input.fill('travel')
    expect(page.getByRole('option', { name: /Filter by/ }).query()).toBeNull()

    // A leading `#` is accepted, and the tag need not exist in the index.
    await input.fill('#zettel')
    await page.getByRole('option', { name: 'Filter by #zettel' }).click()

    expect(probedRoute(view)).toEqual({ kind: 'allNotes', tag: 'zettel' })
    await expect.element(view.getByText('No notes tagged #zettel.')).toBeInTheDocument()
    await view.unmount()
  })

  it('matches facets case-insensitively in the Custom combobox', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByRole('button', { name: 'Custom' }).click()
    const input = page.getByPlaceholder('Filter by any tag…')
    await input.fill('TRAVEL')

    // cmdk's default filter (command-score) folds case like `foldTag` does,
    // so a differently-cased query keeps the existing facet reachable instead
    // of dead-ending with a hidden list and a suppressed "Filter by" offer.
    await expect.element(page.getByRole('option', { name: /#travel/ })).toBeInTheDocument()
    expect(page.getByRole('option', { name: /Filter by/ }).query()).toBeNull()

    await page.getByRole('option', { name: /#travel/ }).click()
    expect(probedRoute(view)).toEqual({ kind: 'allNotes', tag: 'travel' })
    await view.unmount()
  })
})

describe('AllNotesScreen — selection and bulk trash', () => {
  it('selects a row on click and reveals the bulk Trash action', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    // Clicking the row body (the snippet, not a button) selects without opening.
    await view.getByText('Shop your health goals.').click()
    expect(probedRoute(view)).toEqual({ kind: 'allNotes', tag: null })
    const trashButton = view.getByRole('button', { name: /Trash \(1\)/ })
    await expect.element(trashButton).toBeInTheDocument()
    expect(view.getByRole('group', { name: 'Filter by tag' }).element().previousElementSibling).toBe(
      trashButton.element(),
    )

    // ⌘-click a second row extends the selection.
    await view.getByText('Dandelion chocolate.').click({ modifiers: ['Meta'] })
    await expect.element(view.getByRole('button', { name: /Trash \(2\)/ })).toBeInTheDocument()
    expect(openRouteInNewWindow).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('range-selects rows with Shift-click', async () => {
    const rows = [
      { path: 'notes/a.md', title: 'Note A', mtime: 3, preview: 'alpha' },
      { path: 'notes/b.md', title: 'Note B', mtime: 2, preview: 'bravo' },
      { path: 'notes/c.md', title: 'Note C', mtime: 1, preview: 'charlie' },
    ]
    mockInvoke.mockImplementation(async (command, args) => {
      if (command !== 'db_query') {
        return null
      }
      const sql = String(args['sql'])
      if (sql.includes('group by')) {
        return facetRows
      }
      if (sql.includes('"preview"')) {
        return sql.includes('from "tags"') ? [] : rows
      }
      return []
    })
    const view = await renderScreen()
    await expect.element(view.getByText('Note A')).toBeInTheDocument()

    // Click the first row's body (the snippet), then Shift-click the third →
    // the whole range is selected (the row passes the modifier through).
    await view.getByText('alpha').click()
    await view.getByText('charlie').click({ modifiers: ['Shift'] })

    await expect.element(view.getByRole('button', { name: /Trash \(3\)/ })).toBeInTheDocument()
    await view.unmount()
  })

  it('opens a note on double-click', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByText('Shop your health goals.').dblClick()
    expect(probedRoute(view)).toEqual({ kind: 'note', path: 'notes/health.md' })
    await view.unmount()
  })

  it('drives selection from the keyboard and opens with Return', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await userEvent.keyboard('{ArrowDown}') // selects the first row
    await expect.element(view.getByRole('button', { name: /Trash \(1\)/ })).toBeInTheDocument()

    await userEvent.keyboard('{Enter}')
    expect(probedRoute(view)).toEqual({ kind: 'note', path: 'notes/health.md' })
    expect(openRouteInNewWindow).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('clears the selection on Escape', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByText('Shop your health goals.').click()
    await expect.element(view.getByRole('button', { name: /Trash \(1\)/ })).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')
    expect(view.getByRole('button', { name: /Trash \(/ }).query()).toBeNull()
    await view.unmount()
  })

  it('bulk-trashes the selection to the OS trash and drops the rows', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByText('Shop your health goals.').click()
    await view.getByText('Dandelion chocolate.').click({ modifiers: ['Meta'] })
    await view.getByRole('button', { name: /Trash \(2\)/ }).click()

    // Confirm, then the two notes go to the trash via `note_delete`.
    await expect.element(page.getByText('Trash 2 notes?')).toBeInTheDocument()
    await page.getByRole('button', { name: 'Trash', exact: true }).click()

    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('note_delete', {
        path: 'notes/health.md',
        generation: 1,
      })
      expect(mockInvoke).toHaveBeenCalledWith('note_delete', {
        path: 'notes/tokyo.md',
        generation: 1,
      })
    })
    // Optimistic removal: the rows leave at once — the test harness has no file
    // watcher to drive the reindex that would otherwise refresh the list.
    await expectLocatorToHaveCount(view.getByText('Health Stacked'), 0)
    expect(view.getByText('Tokyo Gâteau').query()).toBeNull()
    await view.unmount()
  })

  it('opens the confirm dialog from the ⌘⌫ shortcut', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByText('Shop your health goals.').click()
    await userEvent.keyboard('{Meta>}{Backspace}{/Meta}')

    await expect.element(page.getByText('Trash 1 note?')).toBeInTheDocument()
    await view.unmount()
  })

  it('does not offer bulk trash for a tagged daily note', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByRole('button', { name: /Custom/ }).click()
    await page.getByRole('option', { name: /#travel/ }).click()
    await expect.element(view.getByText('June 9, 2026')).toBeInTheDocument()

    await view.getByText('Daily travel notes.').click()
    expect(view.getByRole('button', { name: /Trash \(/ }).query()).toBeNull()

    await userEvent.keyboard('{Meta>}{Backspace}{/Meta}')
    expect(page.getByText('Trash 1 note?').query()).toBeNull()
    expect(mockInvoke.mock.calls.some(([command]) => command === 'note_delete')).toBe(false)
    await view.unmount()
  })

  it('does not open a note when Return activates a focused header button', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    // Select a note, then send Return to the New note button: a focused control
    // owns Return, so the document-level shortcut must back off and not open.
    await view.getByText('Shop your health goals.').click()
    view
      .getByRole('button', { name: /New note/ })
      .element()
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))

    expect(probedRoute(view)).toEqual({ kind: 'allNotes', tag: null })
    await view.unmount()
  })

  it('closes the confirm and reports the failure via the operations toast', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === 'note_delete') {
        throw new Error('disk on fire')
      }
      if (command !== 'db_query') {
        return null
      }
      const sql = String(args['sql'])
      if (sql.includes('group by')) {
        return facetRows
      }
      if (sql.includes('"preview"')) {
        return sql.includes('from "tags"') ? [] : noteRows
      }
      if (sql.includes('from "tags"')) {
        return tagRows
      }
      return []
    })
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByText('Shop your health goals.').click()
    await view.getByRole('button', { name: /Trash \(1\)/ }).click()
    await expect.element(page.getByText('Trash 1 note?')).toBeInTheDocument()
    await page.getByRole('button', { name: 'Trash', exact: true }).click()

    // The confirm closes either way; the reason lands in the operations toast.
    await expectLocatorToHaveCount(page.getByText('Trash 1 note?'), 0)
    await expect.element(view.getByTestId('operations')).toHaveTextContent('failed:disk on fire')
    // The note that failed to trash is left in the list and stays selected, so
    // the bulk action is still available for an immediate retry (no re-select).
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: /Trash \(1\)/ })).toBeInTheDocument()
    await view.unmount()
  })

  it('keeps trashed rows gone on a partial failure (no index resurrection)', async () => {
    // health trashes; tokyo fails. The index still lists health until the
    // watcher reindexes, so a refetch here would wrongly bring it back.
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === 'note_delete') {
        if (args['path'] === 'notes/tokyo.md') {
          throw new Error('locked')
        }
        return null
      }
      if (command !== 'db_query') {
        return null
      }
      const sql = String(args['sql'])
      if (sql.includes('group by')) {
        return facetRows
      }
      if (sql.includes('"preview"')) {
        return sql.includes('from "tags"') ? [] : noteRows
      }
      if (sql.includes('from "tags"')) {
        return tagRows
      }
      return []
    })
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByText('Shop your health goals.').click()
    await view.getByText('Dandelion chocolate.').click({ modifiers: ['Meta'] })
    await view.getByRole('button', { name: /Trash \(2\)/ }).click()
    await expect.element(page.getByText('Trash 2 notes?')).toBeInTheDocument()
    await page.getByRole('button', { name: 'Trash', exact: true }).click()

    // The successfully-trashed note stays gone; the failed one stays selected.
    await expectLocatorToHaveCount(view.getByText('Health Stacked'), 0)
    await expect.element(view.getByText('Tokyo Gâteau')).toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: /Trash \(1\)/ })).toBeInTheDocument()
    await view.unmount()
  })

  it('ignores a second confirm click while a trash is in flight', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByText('Shop your health goals.').click()
    await view.getByRole('button', { name: /Trash \(1\)/ }).click()
    await expect.element(page.getByText('Trash 1 note?')).toBeInTheDocument()

    const confirm = page.getByRole('button', { name: 'Trash', exact: true }).element() as HTMLElement
    confirm.click()
    confirm.click() // a rapid second click must not double-delete

    await expectLocatorToHaveCount(page.getByText('Trash 1 note?'), 0)
    const healthDeletes = mockInvoke.mock.calls.filter(
      ([command, args]) => command === 'note_delete' && args['path'] === 'notes/health.md',
    )
    expect(healthDeletes).toHaveLength(1)
    await view.unmount()
  })
})
