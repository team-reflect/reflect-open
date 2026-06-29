import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { render } from 'vitest-browser-react'
import { setBridge } from '@reflect/core'
import { resetOperations, useOperations } from '@/lib/operations'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { RouterProvider, useRouter } from '@/routing/router'
import { act } from '@/test-utils/act'
import { AllNotesScreen } from './all-notes-screen'

/**
 * The All Notes screen over the real query layer and a fake IPC bridge: rows
 * from compiled SQL, tag tabs from settings, the Custom menu from the facet
 * query, and navigation through the real router.
 */

vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    graph: { root: '/g', name: 'g', cloudSync: null, generation: 1 },
    indexing: false,
  }),
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: {
      editorMarkdownSyntax: 'hide',
      theme: 'system',
      timeFormat: '12h',
      dateFormat: 'mdy',
      allNotesFilterTags: ['book', 'person'],
    },
    updateSettings: () => {},
  }),
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

/** Dispatches a native keydown on a locator's element, flushed through act. */
function keyDown(locator: import('vitest/browser').Locator, init: KeyboardEventInit) {
  return act(async () => {
    locator
      .element()
      .dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  })
}

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

async function renderScreen(
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return await render(
    <QueryClientProvider client={client}>
      <RouterProvider initialRoute={{ kind: 'allNotes', tag: null }}>
        {/* Give the `h-full` scroll container a real, fixed viewport so virtua
            measures and windows the list the way it does in the app. */}
        <div style={{ height: '600px' }}>
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
    expect(view.getByText('#link').elements()).toHaveLength(2)
    await expect.element(view.getByText('1/15/2020')).toBeInTheDocument()
    await expect.element(view.getByText('1/10/2020')).toBeInTheDocument()
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
  })

  it('opens a note when its row is clicked', async () => {
    const view = await renderScreen()

    await view.getByRole('button', { name: /Health Stacked/ }).click()

    await vi.waitFor(() =>
      expect(probedRoute(view)).toEqual({ kind: 'note', path: 'notes/health.md' }),
    )
  })

  it('renders pinned tags from settings as tabs and filters through the route', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await expect.element(view.getByRole('button', { name: '#person' })).toBeInTheDocument()
    await view.getByRole('button', { name: '#book' }).click()

    await vi.waitFor(() => expect(probedRoute(view)).toEqual({ kind: 'allNotes', tag: 'book' }))
    await expect.element(view.getByText('No notes tagged #book.')).toBeInTheDocument()
    await expect.element(view.getByText('Health Stacked')).not.toBeInTheDocument()
  })

  it('re-anchors to the top when re-arriving on the same route', async () => {
    // The default 2-row fixture cannot scroll in a real viewport, so seed a long
    // list that overflows the 600px viewport and a real scroll can move.
    const manyRows = Array.from({ length: 40 }, (_, index) => ({
      path: `notes/row-${index}.md`,
      title: `Row Note ${index}`,
      mtime: HEALTH_MTIME - index,
      preview: `Row body ${index}.`,
    }))
    mockInvoke.mockImplementation(async (command, args) => {
      if (command !== 'db_query') {
        return null
      }
      const sql = String(args['sql'])
      if (sql.includes('group by')) {
        return facetRows
      }
      if (sql.includes('"preview"')) {
        return manyRows
      }
      return []
    })
    const view = await renderScreen()
    await expect.element(view.getByText('Row Note 0')).toBeInTheDocument()

    const el = view.getByTestId('all-notes-scroll').element()
    el.scrollTop = 400
    await act(async () => {
      el.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    expect(el.scrollTop).toBeGreaterThan(0)

    // Same-route navigation pushes no entry, but the router clears the saved
    // offset and bumps arrivalSeq — the list must re-anchor, not stay put.
    await view.getByTestId('re-arrive').click()

    await vi.waitFor(() => expect(el.scrollTop).toBe(0))
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

    const view = await renderScreen()

    await expect.element(view.getByText('Note 0')).toBeInTheDocument()
    const rendered = view.getByTestId('all-notes-scroll').element().querySelectorAll('li')
    expect(rendered.length).toBeGreaterThan(0)
    // The list is uncapped, but only the scroll window (plus buffer) mounts.
    expect(rendered.length).toBeLessThan(100)
  })

  it('offers unpinned tags in the Custom combobox and shows the chosen one', async () => {
    const view = await renderScreen()

    // `book` is pinned, so the combobox offers only `travel` (with its count).
    await view.getByRole('button', { name: 'Custom' }).click()
    await expect.element(view.getByRole('listbox')).toBeInTheDocument()
    const listbox = view.getByRole('listbox').element()
    expect(listbox.textContent).toContain('#travel')
    expect(listbox.textContent).toContain('2')
    expect(listbox.textContent).not.toContain('#book')

    await view.getByRole('option', { name: /#travel/ }).click()

    await vi.waitFor(() => expect(probedRoute(view)).toEqual({ kind: 'allNotes', tag: 'travel' }))
    await expect.element(view.getByText('Tokyo Gâteau')).toBeInTheDocument()
    await expect.element(view.getByText('Health Stacked')).not.toBeInTheDocument()
    // The trigger adopts the active custom tag.
    await expect
      .element(view.getByRole('button', { name: /#travel/, expanded: false }))
      .toBeInTheDocument()
  })

  it('filters by an arbitrary typed tag from the Custom combobox', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByRole('button', { name: 'Custom' }).click()
    const input = view.getByPlaceholder('Filter by any tag…')

    // An exact existing tag isn't duplicated as a "Filter by" item.
    await input.fill('travel')
    await expect.element(view.getByRole('option', { name: /Filter by/ })).not.toBeInTheDocument()

    // A leading `#` is accepted, and the tag need not exist in the index.
    await input.fill('#zettel')
    await view.getByRole('option', { name: 'Filter by #zettel' }).click()

    await vi.waitFor(() => expect(probedRoute(view)).toEqual({ kind: 'allNotes', tag: 'zettel' }))
    await expect.element(view.getByText('No notes tagged #zettel.')).toBeInTheDocument()
  })

  it('matches facets case-insensitively in the Custom combobox', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByRole('button', { name: 'Custom' }).click()
    const input = view.getByPlaceholder('Filter by any tag…')
    await input.fill('TRAVEL')

    // cmdk's default filter (command-score) folds case like `foldTag` does,
    // so a differently-cased query keeps the existing facet reachable instead
    // of dead-ending with a hidden list and a suppressed "Filter by" offer.
    await expect.element(view.getByRole('option', { name: /#travel/ })).toBeInTheDocument()
    await expect.element(view.getByRole('option', { name: /Filter by/ })).not.toBeInTheDocument()

    await view.getByRole('option', { name: /#travel/ }).click()
    await vi.waitFor(() => expect(probedRoute(view)).toEqual({ kind: 'allNotes', tag: 'travel' }))
  })
})

describe('AllNotesScreen — selection and bulk trash', () => {
  it('selects a row on click and reveals the bulk Trash action', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    // Clicking the row body (the snippet, not a button) selects without opening.
    await view.getByText('Shop your health goals.').click()
    await vi.waitFor(() => expect(probedRoute(view)).toEqual({ kind: 'allNotes', tag: null }))
    const trashButton = view.getByRole('button', { name: /Trash \(1\)/ })
    await expect.element(trashButton).toBeInTheDocument()
    expect(view.getByRole('group', { name: 'Filter by tag' }).element().previousElementSibling).toBe(
      trashButton.element(),
    )

    // ⌘-click a second row extends the selection.
    await view.getByText('Dandelion chocolate.').click({ modifiers: ['Meta'] })
    await expect.element(view.getByRole('button', { name: /Trash \(2\)/ })).toBeInTheDocument()
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
  })

  it('opens a note on double-click', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByText('Shop your health goals.').dblClick()
    await vi.waitFor(() =>
      expect(probedRoute(view)).toEqual({ kind: 'note', path: 'notes/health.md' }),
    )
  })

  it('drives selection from the keyboard and opens with Return', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()
    const surface = view.getByLabelText('All notes')

    await keyDown(surface, { key: 'ArrowDown' }) // selects the first row
    await expect.element(view.getByRole('button', { name: /Trash \(1\)/ })).toBeInTheDocument()

    await keyDown(surface, { key: 'Enter' })
    await vi.waitFor(() =>
      expect(probedRoute(view)).toEqual({ kind: 'note', path: 'notes/health.md' }),
    )
  })

  it('clears the selection on Escape', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()
    const surface = view.getByLabelText('All notes')

    await view.getByText('Shop your health goals.').click()
    await expect.element(view.getByRole('button', { name: /Trash \(1\)/ })).toBeInTheDocument()

    await keyDown(surface, { key: 'Escape' })
    await expect.element(view.getByRole('button', { name: /Trash \(/ })).not.toBeInTheDocument()
  })

  it('bulk-trashes the selection to the OS trash and drops the rows', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByText('Shop your health goals.').click()
    await view.getByText('Dandelion chocolate.').click({ modifiers: ['Meta'] })
    await view.getByRole('button', { name: /Trash \(2\)/ }).click()

    // Confirm, then the two notes go to the trash via `note_delete`.
    await expect.element(view.getByText('Trash 2 notes?')).toBeInTheDocument()
    await view.getByRole('button', { name: 'Trash' }).click()

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
    await expect.element(view.getByText('Health Stacked')).not.toBeInTheDocument()
    await expect.element(view.getByText('Tokyo Gâteau')).not.toBeInTheDocument()
  })

  it('opens the confirm dialog from the ⌘⌫ shortcut', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()
    const surface = view.getByLabelText('All notes')

    await view.getByText('Shop your health goals.').click()
    await keyDown(surface, { key: 'Backspace', metaKey: true })

    await expect.element(view.getByText('Trash 1 note?')).toBeInTheDocument()
  })

  it('does not open a note when Return activates a focused header button', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    // Select a note, then send Return to the New note button: a focused control
    // owns Return, so the document-level shortcut must back off and not open.
    await view.getByText('Shop your health goals.').click()
    await keyDown(view.getByRole('button', { name: /New note/ }), { key: 'Enter' })

    await vi.waitFor(() => expect(probedRoute(view)).toEqual({ kind: 'allNotes', tag: null }))
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
    await expect.element(view.getByText('Trash 1 note?')).toBeInTheDocument()
    await view.getByRole('button', { name: 'Trash' }).click()

    // The confirm closes either way; the reason lands in the operations toast.
    await expect.element(view.getByText('Trash 1 note?')).not.toBeInTheDocument()
    await vi.waitFor(() =>
      expect(view.getByTestId('operations').element().textContent).toContain('failed:disk on fire'),
    )
    // The note that failed to trash is left in the list and stays selected, so
    // the bulk action is still available for an immediate retry (no re-select).
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: /Trash \(1\)/ })).toBeInTheDocument()
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
    await expect.element(view.getByText('Trash 2 notes?')).toBeInTheDocument()
    await view.getByRole('button', { name: 'Trash' }).click()

    // The successfully-trashed note stays gone; the failed one stays selected.
    await expect.element(view.getByText('Health Stacked')).not.toBeInTheDocument()
    await expect.element(view.getByText('Tokyo Gâteau')).toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: /Trash \(1\)/ })).toBeInTheDocument()
  })

  it('ignores a second confirm click while a trash is in flight', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByText('Shop your health goals.').click()
    await view.getByRole('button', { name: /Trash \(1\)/ }).click()
    await expect.element(view.getByText('Trash 1 note?')).toBeInTheDocument()

    // Fire both clicks synchronously so the second lands while the first trash
    // is still in flight: the in-flight ref guard must drop the duplicate.
    const confirm = view.getByRole('button', { name: 'Trash' }).element() as HTMLElement
    await act(async () => {
      confirm.click()
      confirm.click() // a rapid second click must not double-delete
    })

    await expect.element(view.getByText('Trash 1 note?')).not.toBeInTheDocument()
    const healthDeletes = mockInvoke.mock.calls.filter(
      ([command, args]) => command === 'note_delete' && args['path'] === 'notes/health.md',
    )
    expect(healthDeletes).toHaveLength(1)
  })
})
