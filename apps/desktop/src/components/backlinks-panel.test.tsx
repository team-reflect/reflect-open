import { fireEvent, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { RouterProvider, useRouter } from '@/routing/router'
import { BacklinksPanel } from './backlinks-panel'

const { getBacklinksWithContext, getBacklinksPage } = vi.hoisted(() => {
  const getBacklinksWithContext = vi.fn()
  const getBacklinksPage = vi.fn(async (path: string, options: unknown) => {
    const result: unknown = await getBacklinksWithContext(path, options)
    return Array.isArray(result)
      ? { contexts: result, nextCursor: null, indexedLinkCount: result.length }
      : result
  })
  return { getBacklinksWithContext, getBacklinksPage }
})
const resolveOrCreateWikiTarget = vi.hoisted(() => vi.fn())
const resolveExistingMarkdownTarget = vi.hoisted(() => vi.fn())
const openRouteInNewWindow = vi.hoisted(() => vi.fn<() => Promise<boolean>>())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getBacklinksWithContext: getBacklinksPage,
  resolveOrCreateWikiTarget,
  resolveExistingMarkdownTarget,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))
vi.mock('@/lib/windows/open-in-new-window', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/windows/open-in-new-window')>()),
  openRouteInNewWindow,
}))

function RouteProbe(): ReactNode {
  const { route, arrivalFocusEditor } = useRouter()
  return (
    <output data-testid="route" data-focus={String(arrivalFocusEditor)}>
      {JSON.stringify(route)}
    </output>
  )
}

function renderPanel(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider>
        <BacklinksPanel path={path} />
        <RouteProbe />
      </RouterProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  window.sessionStorage.clear()
  getBacklinksWithContext.mockReset()
  getBacklinksPage.mockClear()
  resolveOrCreateWikiTarget.mockReset()
  resolveExistingMarkdownTarget.mockReset()
  openRouteInNewWindow.mockReset().mockResolvedValue(true)
})

describe('BacklinksPanel', () => {
  it('renders nothing when the note has no inbound links', async () => {
    getBacklinksWithContext.mockResolvedValue([])
    const view = renderPanel('notes/lonely.md')
    await waitFor(() => expect(getBacklinksWithContext).toHaveBeenCalled())
    expect(view.queryByText(/Incoming backlink/)).toBeNull()
    view.unmount()
  })

  it('surfaces a failed query as an alert instead of rendering nothing', async () => {
    getBacklinksWithContext.mockRejectedValue(new Error('index unavailable'))
    const view = renderPanel('notes/roadmap.md')
    const alert = await view.findByRole('alert')
    expect(alert.textContent).toContain('Couldn’t load backlinks.')
    view.unmount()
  })

  it('uses the singular header for one inbound link', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed [[Roadmap]] follow-ups',
        posFrom: 12,
        tasks: [],
      },
    ])
    const view = renderPanel('notes/roadmap.md')
    await view.findByText('Incoming backlink (1)')
    view.unmount()
  })

  it('renders a snippet wiki link as a clickable chip that navigates to its target', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed [[Roadmap]] follow-ups',
        posFrom: 12,
        tasks: [],
      },
    ])
    resolveOrCreateWikiTarget.mockResolvedValue({
      kind: 'resolved',
      path: 'notes/roadmap.md',
    })
    const view = renderPanel('notes/source.md')

    // The [[Roadmap]] source renders as a chip whose label is the bare target,
    // not the raw bracket syntax.
    const chip = await view.findByTestId('wikilink')
    expect(chip.textContent).toBe('Roadmap')

    await userEvent.click(chip)
    await waitFor(() =>
      expect(view.getByTestId('route').textContent).toContain('notes/roadmap.md'),
    )
    expect(resolveOrCreateWikiTarget).toHaveBeenCalledWith(
      'Roadmap',
      'notes/meeting.md',
      1,
    )
    view.unmount()
  })

  it('resolves a relative Markdown link from the backlink source note', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'Projects/Meetings/Review.md',
        sourceTitle: 'Review',
        snippet: '[Plan](../Plan.md#Scope)',
        posFrom: 12,
        tasks: [],
      },
    ])
    resolveExistingMarkdownTarget.mockResolvedValue({
      kind: 'resolved',
      path: 'Projects/Plan.md',
    })
    const view = renderPanel('notes/source.md')

    await view.findByText('Plan')
    const markdownLink = view.container.querySelector<HTMLAnchorElement>(
      'a[href="../Plan.md#Scope"]',
    )
    if (markdownLink === null) {
      throw new Error('expected the relative Markdown link to render')
    }
    await userEvent.click(markdownLink)

    await waitFor(() =>
      expect(view.getByTestId('route').textContent).toContain('Projects/Plan.md'),
    )
    expect(resolveExistingMarkdownTarget).toHaveBeenCalledWith(
      '../Plan.md#Scope',
      'Projects/Meetings/Review.md',
      1,
    )
    view.unmount()
  })

  it('groups references by source note and navigates on title click', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed [[Roadmap]] follow-ups',
        posFrom: 12,
        tasks: [],
      },
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'revisit [[Roadmap]] next week',
        posFrom: 80,
        tasks: [],
      },
      {
        sourcePath: 'notes/planning.md',
        sourceTitle: 'Planning',
        snippet: 'ship the [[Roadmap]]',
        posFrom: 3,
        tasks: [],
      },
    ])
    const view = renderPanel('notes/roadmap.md')

    await view.findByText('Incoming backlinks (3)')
    expect(view.getAllByText('Meeting Notes')).toHaveLength(1)
    // Snippets render as rich text: the leading prose survives, the [[…]] source
    // becomes a chip whose label shows the bare target.
    expect(view.getByText(/discussed/)).toBeDefined()
    expect(view.getByText(/revisit/)).toBeDefined()
    expect(view.getByText(/ship the/)).toBeDefined()
    expect(view.getAllByTestId('wikilink')).toHaveLength(3)

    await userEvent.click(view.getByText('Meeting Notes'))
    expect(view.getByTestId('route').textContent).toContain('notes/meeting.md')
    // A backlink tap must not request focus — on mobile that would raise the
    // keyboard mid-arrival; desktop autofocuses note arrivals on its own.
    expect(view.getByTestId('route').getAttribute('data-focus')).toBe('false')
    view.unmount()
  })

  it('opens a ⌘-clicked backlink source in a new window', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed [[Roadmap]] follow-ups',
        posFrom: 12,
        tasks: [],
      },
    ])
    const view = renderPanel('notes/roadmap.md')

    fireEvent.click(await view.findByText('Meeting Notes'), { metaKey: true })

    await waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({
        kind: 'note',
        path: 'notes/meeting.md',
      }),
    )
    expect(view.getByTestId('route').textContent).toContain('"today"')
    view.unmount()
  })

  it('collapses snippets but keeps source titles on header toggle, for the session', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed [[Roadmap]] follow-ups',
        posFrom: 12,
        tasks: [],
      },
    ])
    const view = renderPanel('notes/roadmap.md')

    const header = await view.findByRole('button', { name: /Incoming backlink \(1\)/ })
    expect(header.getAttribute('aria-expanded')).toBe('true')

    await userEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(view.getByText('Meeting Notes')).toBeDefined()
    expect(view.queryByText(/discussed/)).toBeNull()
    view.unmount()

    const reopened = renderPanel('notes/roadmap.md')
    const persistedHeader = await reopened.findByRole('button', {
      name: /Incoming backlink \(1\)/,
    })
    expect(persistedHeader.getAttribute('aria-expanded')).toBe('false')
    reopened.unmount()
  })

  it('resets a collapsed group when navigating to another note with the same source', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/shared.md',
        sourceTitle: 'Shared Source',
        snippet: 'links [[A]] and [[B]]',
        posFrom: 5,
        tasks: [],
      },
    ])
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const panelFor = (path: string) => (
      <QueryClientProvider client={client}>
        <RouterProvider>
          <BacklinksPanel path={path} />
        </RouterProvider>
      </QueryClientProvider>
    )
    const view = render(panelFor('notes/a.md'))

    await view.findByText(/links and/)
    await userEvent.click(
      view.getByRole('button', { name: 'Collapse references from Shared Source' }),
    )
    expect(view.queryByText(/links and/)).toBeNull()

    view.rerender(panelFor('notes/b.md'))
    await view.findByText(/links and/)
    view.unmount()
  })

  it('keeps simultaneously mounted panels in sync (one per day in the stream)', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed [[Roadmap]] follow-ups',
        posFrom: 12,
        tasks: [],
      },
    ])
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(
      <QueryClientProvider client={client}>
        <RouterProvider>
          <BacklinksPanel path="daily/2026-06-09.md" />
          <BacklinksPanel path="daily/2026-06-10.md" />
        </RouterProvider>
      </QueryClientProvider>,
    )

    await waitFor(() =>
      expect(view.getAllByRole('button', { name: /Incoming backlink \(1\)/ })).toHaveLength(2),
    )
    const headers = view.getAllByRole('button', { name: /Incoming backlink \(1\)/ })

    await userEvent.click(headers[0]!)
    expect(headers[0]!.getAttribute('aria-expanded')).toBe('false')
    expect(headers[1]!.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText(/discussed/)).toBeNull()
    view.unmount()
  })

  it('lets one group be peeked at after the header collapse (old Reflect behavior)', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed [[Roadmap]] follow-ups',
        posFrom: 12,
        tasks: [],
      },
      {
        sourcePath: 'notes/planning.md',
        sourceTitle: 'Planning',
        snippet: 'ship the [[Roadmap]]',
        posFrom: 3,
        tasks: [],
      },
    ])
    const view = renderPanel('notes/roadmap.md')

    const header = await view.findByRole('button', { name: /Incoming backlinks \(2\)/ })
    await userEvent.click(header)
    expect(view.queryByText(/discussed/)).toBeNull()
    expect(view.queryByText(/ship the/)).toBeNull()

    await userEvent.click(
      view.getByRole('button', { name: 'Expand references from Meeting Notes' }),
    )
    expect(view.getByText(/discussed/)).toBeDefined()
    expect(view.queryByText(/ship the/)).toBeNull()

    await userEvent.click(header)
    expect(view.getByText(/ship the/)).toBeDefined()
    view.unmount()
  })

  it('collapses one source group via its own chevron', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed [[Roadmap]] follow-ups',
        posFrom: 12,
        tasks: [],
      },
      {
        sourcePath: 'notes/planning.md',
        sourceTitle: 'Planning',
        snippet: 'ship the [[Roadmap]]',
        posFrom: 3,
        tasks: [],
      },
    ])
    const view = renderPanel('notes/roadmap.md')
    await view.findByText('Incoming backlinks (2)')

    await userEvent.click(
      view.getByRole('button', { name: 'Collapse references from Meeting Notes' }),
    )
    expect(view.queryByText(/discussed/)).toBeNull()
    expect(view.getByText(/ship the/)).toBeDefined()
    view.unmount()
  })
})
