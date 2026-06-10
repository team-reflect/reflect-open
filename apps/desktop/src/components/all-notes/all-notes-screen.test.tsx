import { fireEvent, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { setBridge } from '@reflect/core'
import { RouterProvider, useRouter } from '@/routing/router'
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
      editorMarkdownSyntax: 'focus',
      theme: 'system',
      allNotesFilterTags: ['book', 'person'],
    },
    updateSettings: () => {},
  }),
}))

// jsdom implements none of these, and measures every element as 0×0 — the
// virtualized table needs a viewport with height to window rows into. The
// virtualizer reads `offsetWidth`/`offsetHeight` for the scroll rect and
// `getBoundingClientRect` for row measurement.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
Element.prototype.scrollTo ??= () => {}
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get: () => 1024,
})
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get: () => 768,
})
Element.prototype.getBoundingClientRect = () => ({
  width: 1024,
  height: 768,
  top: 0,
  left: 0,
  right: 1024,
  bottom: 768,
  x: 0,
  y: 0,
  toJSON: () => ({}),
})

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
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command, args) => {
    if (command !== 'db_query') {
      return null
    }
    const sql = String(args.sql)
    const params = args.params as unknown[]
    if (sql.includes('group by')) {
      return facetRows
    }
    if (sql.includes('"preview"')) {
      // A tag-filtered list (EXISTS subquery carries the folded tag) — only
      // `travel` has matches in this fixture.
      if (sql.includes('exists')) {
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

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider initialRoute={{ kind: 'allNotes', tag: null }}>
        <RoutedScreen />
        <RouteProbe />
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
      const sql = String(args.sql)
      if (sql.includes('"preview"')) {
        return many
      }
      return []
    })

    const view = renderScreen()

    await view.findByText('Note 0')
    const rendered = view.container.querySelectorAll('li[data-index]')
    expect(rendered.length).toBeGreaterThan(0)
    // The list is uncapped, but only the scroll window (plus overscan) mounts.
    expect(rendered.length).toBeLessThan(100)
    view.unmount()
  })

  it('offers unpinned tags in the Custom menu and shows the chosen one', async () => {
    const view = renderScreen()

    // `book` is pinned, so the menu offers only `travel` (with its count).
    fireEvent.click(await view.findByRole('button', { name: 'Custom' }))
    const menu = view.getByRole('menu', { name: 'Filter by another tag' })
    expect(menu.textContent).toContain('#travel')
    expect(menu.textContent).toContain('2')
    expect(menu.textContent).not.toContain('#book')

    fireEvent.click(view.getByRole('menuitem', { name: /#travel/ }))

    expect(probedRoute(view)).toEqual({ kind: 'allNotes', tag: 'travel' })
    await view.findByText('Tokyo Gâteau')
    expect(view.queryByText('Health Stacked')).toBeNull()
    // The trigger adopts the active custom tag.
    await waitFor(() =>
      expect(view.getByRole('button', { name: /#travel/, expanded: false })).toBeDefined(),
    )
    view.unmount()
  })
})
