import { fireEvent, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { setBridge } from '@reflect/core'
import { resetOperations, useOperations } from '@/lib/operations'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { RouterProvider, useRouter } from '@/routing/router'
import { installVirtuaTestEnv } from '@/test-utils/virtua-jsdom'
import { AllNotesScreen } from './all-notes-screen'

/**
 * The All Notes screen over the real query layer and a fake IPC bridge: rows
 * from compiled SQL, tag tabs from settings, the Custom menu from the facet
 * query, and navigation through the real router.
 */

const settingsState = vi.hoisted((): { dateFormat: 'mdy' | 'dmy' | 'iso' } => ({
  dateFormat: 'mdy',
}))

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

// jsdom computes no layout, so virtua can't measure its viewport or rows.
// installVirtuaTestEnv supplies those: the scroll container reports a tall
// viewport and each row (an <li>) the estimated row height, so even a 1000-row
// list windows down to a handful of mounted rows.
installVirtuaTestEnv((element) => (element.tagName === 'LI' ? 48 : 768))
Element.prototype.scrollTo ??= () => {}
Element.prototype.scrollIntoView ??= () => {} // cmdk scrolls the selected item

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
const tagRows = [
  { note_path: 'notes/health.md', tag: 'link' },
  { note_path: 'notes/tokyo.md', tag: 'link' },
]
const facetRows = [
  { tag: 'book', count: 3 },
  { tag: 'travel', count: 2 },
]

const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

setBridge({ invoke: mockInvoke, listen: async () => () => {} })

beforeEach(() => {
  resetOperations()
  settingsState.dateFormat = 'mdy'
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
        return params.includes('travel') ? [noteRows[1]] : []
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
        <RoutedScreen />
        <RouteProbe />
        <OperationsProbe />
        <ReArrive />
      </RouterProvider>
    </QueryClientProvider>,
  )
}

function probedRoute(view: ReturnType<typeof renderScreen>): unknown {
  return JSON.parse(view.getByTestId('route').textContent ?? 'null')
}

describe('AllNotesScreen', () => {
  it('lists non-daily notes with subject, snippet, tags, and updated columns', async () => {
    const view = renderScreen()

    await view.findByText('Health Stacked')
    expect(view.getByText('Shop your health goals.')).toBeDefined()
    expect(view.getByText('Tokyo Gâteau')).toBeDefined()
    expect(view.getAllByText('#link')).toHaveLength(2)
    expect(view.getByText('1/15/2020')).toBeDefined()
    expect(view.getByText('1/10/2020')).toBeDefined()
    view.unmount()
  })

  it('keeps ISO updated dates on one line', async () => {
    settingsState.dateFormat = 'iso'
    const view = renderScreen()

    const updated = await view.findByText('2020-01-15')
    expect(updated.className).toContain('whitespace-nowrap')
    expect(updated.parentElement?.className ?? '').toContain(
      'grid-cols-[minmax(0,15rem)_minmax(0,1fr)_minmax(0,8rem)_6rem]',
    )
    view.unmount()
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
    const view = renderScreen()

    await view.findByText('Legacy Note')
    expect(view.getByText('—')).toBeDefined()
    view.unmount()
  })

  it('opens a note when its row is clicked', async () => {
    const view = renderScreen()

    fireEvent.click(await view.findByRole('button', { name: /Health Stacked/ }))

    expect(probedRoute(view)).toEqual({ kind: 'note', path: 'notes/health.md' })
    view.unmount()
  })

  it('renders pinned tags from settings as tabs and filters through the route', async () => {
    const view = renderScreen()
    await view.findByText('Health Stacked')

    expect(view.getByRole('button', { name: '#person' })).toBeDefined()
    fireEvent.click(view.getByRole('button', { name: '#book' }))

    expect(probedRoute(view)).toEqual({ kind: 'allNotes', tag: 'book' })
    await view.findByText('No notes tagged #book.')
    expect(view.queryByText('Health Stacked')).toBeNull()
    view.unmount()
  })

  it('re-anchors to the top when re-arriving on the same route', async () => {
    const view = renderScreen()
    await view.findByText('Health Stacked')

    const scroller = view.getByTestId('all-notes-scroll')
    fireEvent.scroll(scroller, { target: { scrollTop: 400 } })
    expect(scroller.scrollTop).toBe(400)

    // Same-route navigation pushes no entry, but the router clears the saved
    // offset and bumps arrivalSeq — the list must re-anchor, not stay put.
    fireEvent.click(view.getByTestId('re-arrive'))

    await waitFor(() => expect(scroller.scrollTop).toBe(0))
    view.unmount()
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

    const view = renderScreen(client)

    expect(await view.findByText('Health Stacked')).toBeDefined()
    expect(view.getByText('Tokyo Gâteau')).toBeDefined()
    view.unmount()
  })

  it('virtualizes long lists instead of rendering every row', async () => {
    const many = Array.from({ length: 1000 }, (_, index) => ({
      path: `notes/n${index}.md`,
      title: `Note ${index}`,
      mtime: 1_000_000 - index,
      preview: '',
    }))
    mockInvoke.mockImplementation(async (command, args) => {
      if (command !== 'db_query') {
        return null
      }
      const sql = String(args['sql'])
      if (sql.includes('"preview"')) {
        return many
      }
      return []
    })

    const view = renderScreen()

    await view.findByText('Note 0')
    const rendered = view.getByTestId('all-notes-scroll').querySelectorAll('li')
    expect(rendered.length).toBeGreaterThan(0)
    // The list is uncapped, but only the scroll window (plus buffer) mounts.
    expect(rendered.length).toBeLessThan(100)
    view.unmount()
  })

  it('offers unpinned tags in the Custom combobox and shows the chosen one', async () => {
    const view = renderScreen()

    // `book` is pinned, so the combobox offers only `travel` (with its count).
    fireEvent.click(await view.findByRole('button', { name: 'Custom' }))
    const listbox = await view.findByRole('listbox')
    expect(listbox.textContent).toContain('#travel')
    expect(listbox.textContent).toContain('2')
    expect(listbox.textContent).not.toContain('#book')

    fireEvent.click(view.getByRole('option', { name: /#travel/ }))

    expect(probedRoute(view)).toEqual({ kind: 'allNotes', tag: 'travel' })
    await view.findByText('Tokyo Gâteau')
    expect(view.queryByText('Health Stacked')).toBeNull()
    // The trigger adopts the active custom tag.
    await waitFor(() =>
      expect(view.getByRole('button', { name: /#travel/, expanded: false })).toBeDefined(),
    )
    view.unmount()
  })

  it('filters by an arbitrary typed tag from the Custom combobox', async () => {
    const view = renderScreen()
    await view.findByText('Health Stacked')

    fireEvent.click(view.getByRole('button', { name: 'Custom' }))
    const input = await view.findByPlaceholderText('Filter by any tag…')

    // An exact existing tag isn't duplicated as a "Filter by" item.
    fireEvent.change(input, { target: { value: 'travel' } })
    expect(view.queryByRole('option', { name: /Filter by/ })).toBeNull()

    // A leading `#` is accepted, and the tag need not exist in the index.
    fireEvent.change(input, { target: { value: '#zettel' } })
    fireEvent.click(await view.findByRole('option', { name: 'Filter by #zettel' }))

    expect(probedRoute(view)).toEqual({ kind: 'allNotes', tag: 'zettel' })
    await view.findByText('No notes tagged #zettel.')
    view.unmount()
  })

  it('matches facets case-insensitively in the Custom combobox', async () => {
    const view = renderScreen()
    await view.findByText('Health Stacked')

    fireEvent.click(view.getByRole('button', { name: 'Custom' }))
    const input = await view.findByPlaceholderText('Filter by any tag…')
    fireEvent.change(input, { target: { value: 'TRAVEL' } })

    // cmdk's default filter (command-score) folds case like `foldTag` does,
    // so a differently-cased query keeps the existing facet reachable instead
    // of dead-ending with a hidden list and a suppressed "Filter by" offer.
    expect(await view.findByRole('option', { name: /#travel/ })).toBeDefined()
    expect(view.queryByRole('option', { name: /Filter by/ })).toBeNull()

    fireEvent.click(view.getByRole('option', { name: /#travel/ }))
    expect(probedRoute(view)).toEqual({ kind: 'allNotes', tag: 'travel' })
    view.unmount()
  })
})

describe('AllNotesScreen — selection and bulk trash', () => {
  it('selects a row on click and reveals the bulk Trash action', async () => {
    const view = renderScreen()
    await view.findByText('Health Stacked')

    // Clicking the row body (the snippet, not a button) selects without opening.
    fireEvent.click(view.getByText('Shop your health goals.'))
    expect(probedRoute(view)).toEqual({ kind: 'allNotes', tag: null })
    const trashButton = view.getByRole('button', { name: /Trash \(1\)/ })
    expect(trashButton).toBeDefined()
    expect(view.getByRole('group', { name: 'Filter by tag' }).previousElementSibling).toBe(trashButton)

    // ⌘-click a second row extends the selection.
    fireEvent.click(view.getByText('Dandelion chocolate.'), { metaKey: true })
    expect(view.getByRole('button', { name: /Trash \(2\)/ })).toBeDefined()
    view.unmount()
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
    const view = renderScreen()
    await view.findByText('Note A')

    // Click the first row's body (the snippet), then Shift-click the third →
    // the whole range is selected (the row passes the modifier through).
    fireEvent.click(view.getByText('alpha'))
    fireEvent.click(view.getByText('charlie'), { shiftKey: true })

    expect(view.getByRole('button', { name: /Trash \(3\)/ })).toBeDefined()
    view.unmount()
  })

  it('opens a note on double-click', async () => {
    const view = renderScreen()
    await view.findByText('Health Stacked')

    fireEvent.doubleClick(view.getByText('Shop your health goals.'))
    expect(probedRoute(view)).toEqual({ kind: 'note', path: 'notes/health.md' })
    view.unmount()
  })

  it('drives selection from the keyboard and opens with Return', async () => {
    const view = renderScreen()
    await view.findByText('Health Stacked')
    const surface = view.getByLabelText('All notes')

    fireEvent.keyDown(surface, { key: 'ArrowDown' }) // selects the first row
    expect(view.getByRole('button', { name: /Trash \(1\)/ })).toBeDefined()

    fireEvent.keyDown(surface, { key: 'Enter' })
    expect(probedRoute(view)).toEqual({ kind: 'note', path: 'notes/health.md' })
    view.unmount()
  })

  it('clears the selection on Escape', async () => {
    const view = renderScreen()
    await view.findByText('Health Stacked')
    const surface = view.getByLabelText('All notes')

    fireEvent.click(view.getByText('Shop your health goals.'))
    expect(view.queryByRole('button', { name: /Trash \(1\)/ })).not.toBeNull()

    fireEvent.keyDown(surface, { key: 'Escape' })
    expect(view.queryByRole('button', { name: /Trash \(/ })).toBeNull()
    view.unmount()
  })

  it('bulk-trashes the selection to the OS trash and drops the rows', async () => {
    const view = renderScreen()
    await view.findByText('Health Stacked')

    fireEvent.click(view.getByText('Shop your health goals.'))
    fireEvent.click(view.getByText('Dandelion chocolate.'), { metaKey: true })
    fireEvent.click(view.getByRole('button', { name: /Trash \(2\)/ }))

    // Confirm, then the two notes go to the trash via `note_delete`.
    await view.findByText('Trash 2 notes?')
    fireEvent.click(view.getByRole('button', { name: 'Trash' }))

    await waitFor(() => {
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
    await waitFor(() => expect(view.queryByText('Health Stacked')).toBeNull())
    expect(view.queryByText('Tokyo Gâteau')).toBeNull()
    view.unmount()
  })

  it('opens the confirm dialog from the ⌘⌫ shortcut', async () => {
    const view = renderScreen()
    await view.findByText('Health Stacked')
    const surface = view.getByLabelText('All notes')

    fireEvent.click(view.getByText('Shop your health goals.'))
    fireEvent.keyDown(surface, { key: 'Backspace', metaKey: true })

    expect(await view.findByText('Trash 1 note?')).toBeDefined()
    view.unmount()
  })

  it('does not open a note when Return activates a focused header button', async () => {
    const view = renderScreen()
    await view.findByText('Health Stacked')

    // Select a note, then send Return to the New note button: a focused control
    // owns Return, so the document-level shortcut must back off and not open.
    fireEvent.click(view.getByText('Shop your health goals.'))
    fireEvent.keyDown(view.getByRole('button', { name: /New note/ }), { key: 'Enter' })

    expect(probedRoute(view)).toEqual({ kind: 'allNotes', tag: null })
    view.unmount()
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
    const view = renderScreen()
    await view.findByText('Health Stacked')

    fireEvent.click(view.getByText('Shop your health goals.'))
    fireEvent.click(view.getByRole('button', { name: /Trash \(1\)/ }))
    await view.findByText('Trash 1 note?')
    fireEvent.click(view.getByRole('button', { name: 'Trash' }))

    // The confirm closes either way; the reason lands in the operations toast.
    await waitFor(() => expect(view.queryByText('Trash 1 note?')).toBeNull())
    await waitFor(() =>
      expect(view.getByTestId('operations').textContent).toContain('failed:disk on fire'),
    )
    // The note that failed to trash is left in the list and stays selected, so
    // the bulk action is still available for an immediate retry (no re-select).
    expect(view.getByText('Health Stacked')).toBeDefined()
    expect(view.getByRole('button', { name: /Trash \(1\)/ })).toBeDefined()
    view.unmount()
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
    const view = renderScreen()
    await view.findByText('Health Stacked')

    fireEvent.click(view.getByText('Shop your health goals.'))
    fireEvent.click(view.getByText('Dandelion chocolate.'), { metaKey: true })
    fireEvent.click(view.getByRole('button', { name: /Trash \(2\)/ }))
    await view.findByText('Trash 2 notes?')
    fireEvent.click(view.getByRole('button', { name: 'Trash' }))

    // The successfully-trashed note stays gone; the failed one stays selected.
    await waitFor(() => expect(view.queryByText('Health Stacked')).toBeNull())
    expect(view.getByText('Tokyo Gâteau')).toBeDefined()
    expect(view.getByRole('button', { name: /Trash \(1\)/ })).toBeDefined()
    view.unmount()
  })

  it('ignores a second confirm click while a trash is in flight', async () => {
    const view = renderScreen()
    await view.findByText('Health Stacked')

    fireEvent.click(view.getByText('Shop your health goals.'))
    fireEvent.click(view.getByRole('button', { name: /Trash \(1\)/ }))
    await view.findByText('Trash 1 note?')

    const confirm = view.getByRole('button', { name: 'Trash' })
    fireEvent.click(confirm)
    fireEvent.click(confirm) // a rapid second click must not double-delete

    await waitFor(() => expect(view.queryByText('Trash 1 note?')).toBeNull())
    const healthDeletes = mockInvoke.mock.calls.filter(
      ([command, args]) => command === 'note_delete' && args['path'] === 'notes/health.md',
    )
    expect(healthDeletes).toHaveLength(1)
    view.unmount()
  })
})
