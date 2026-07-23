import { render } from 'vitest-browser-react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { RouterProvider, useRouter } from '@/routing/router'
import { expectLocatorToHaveCount } from '@/test-utils/expect'
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
const resolveOrCreateNoteWithTitle = vi.hoisted(() => vi.fn())
const openRouteInNewWindow = vi.hoisted(() => vi.fn<() => Promise<boolean>>())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getBacklinksWithContext: getBacklinksPage,
  resolveOrCreateNoteWithTitle,
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
  resolveOrCreateNoteWithTitle.mockReset()
  openRouteInNewWindow.mockReset().mockResolvedValue(true)
})

describe('BacklinksPanel', () => {
  it('renders nothing when the note has no inbound links', async () => {
    getBacklinksWithContext.mockResolvedValue([])
    const view = await renderPanel('notes/lonely.md')
    await vi.waitFor(() => expect(getBacklinksWithContext).toHaveBeenCalled())
    expect(view.getByText(/Incoming backlink/).query()).toBeNull()
    await view.unmount()
  })

  it('surfaces a failed query as an alert instead of rendering nothing', async () => {
    getBacklinksWithContext.mockRejectedValue(new Error('index unavailable'))
    const view = await renderPanel('notes/roadmap.md')
    await expect.element(view.getByRole('alert')).toHaveTextContent('Couldn’t load backlinks.')
    await view.unmount()
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
    const view = await renderPanel('notes/roadmap.md')
    await expect.element(view.getByText('Incoming backlink (1)')).toBeInTheDocument()
    await view.unmount()
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
    resolveOrCreateNoteWithTitle.mockResolvedValue({
      kind: 'resolved',
      path: 'notes/roadmap.md',
    })
    const view = await renderPanel('notes/source.md')

    // The [[Roadmap]] source renders as a chip whose label is the bare target,
    // not the raw bracket syntax.
    const chip = view.getByTestId('wikilink')
    await expect.element(chip).toHaveTextContent(/^Roadmap$/)

    await chip.click()
    await expect.element(view.getByTestId('route')).toHaveTextContent('notes/roadmap.md')
    await view.unmount()
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
    const view = await renderPanel('notes/roadmap.md')

    await expect.element(view.getByText('Incoming backlinks (3)')).toBeInTheDocument()
    await expectLocatorToHaveCount(view.getByText('Meeting Notes'), 1)
    // Snippets render as rich text: the leading prose survives, the [[…]] source
    // becomes a chip whose label shows the bare target.
    await expect.element(view.getByText(/discussed/)).toBeInTheDocument()
    await expect.element(view.getByText(/revisit/)).toBeInTheDocument()
    await expect.element(view.getByText(/ship the/)).toBeInTheDocument()
    await expectLocatorToHaveCount(view.getByTestId('wikilink'), 3)

    await view.getByText('Meeting Notes').click()
    await expect.element(view.getByTestId('route')).toHaveTextContent('notes/meeting.md')
    // A backlink tap must not request focus — on mobile that would raise the
    // keyboard mid-arrival; desktop autofocuses note arrivals on its own.
    await expect.element(view.getByTestId('route')).toHaveAttribute('data-focus', 'false')
    await view.unmount()
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
    const view = await renderPanel('notes/roadmap.md')

    await view.getByText('Meeting Notes').click({ modifiers: ['Meta'] })

    await vi.waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({
        kind: 'note',
        path: 'notes/meeting.md',
      }),
    )
    await expect.element(view.getByTestId('route')).toHaveTextContent('"today"')
    await view.unmount()
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
    const view = await renderPanel('notes/roadmap.md')

    const header = view.getByRole('button', { name: /Incoming backlink \(1\)/ })
    await expect.element(header).toHaveAttribute('aria-expanded', 'true')

    await header.click()
    await expect.element(header).toHaveAttribute('aria-expanded', 'false')
    await expect.element(view.getByText('Meeting Notes')).toBeInTheDocument()
    expect(view.getByText(/discussed/).query()).toBeNull()
    await view.unmount()

    const reopened = await renderPanel('notes/roadmap.md')
    const persistedHeader = reopened.getByRole('button', {
      name: /Incoming backlink \(1\)/,
    })
    await expect.element(persistedHeader).toHaveAttribute('aria-expanded', 'false')
    await reopened.unmount()
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
    const view = await render(panelFor('notes/a.md'))

    await expect.element(view.getByText(/links/)).toBeInTheDocument()
    await view.getByRole('button', { name: 'Collapse references from Shared Source' }).click()
    expect(view.getByText(/links/).query()).toBeNull()

    await view.rerender(panelFor('notes/b.md'))
    await expect.element(view.getByText(/links/)).toBeInTheDocument()
    await view.unmount()
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
    const view = await render(
      <QueryClientProvider client={client}>
        <RouterProvider>
          <BacklinksPanel path="daily/2026-06-09.md" />
          <BacklinksPanel path="daily/2026-06-10.md" />
        </RouterProvider>
      </QueryClientProvider>,
    )

    const headers = view.getByRole('button', { name: /Incoming backlink \(1\)/ })
    await expectLocatorToHaveCount(headers, 2)

    await headers.nth(0).click()
    await expect.element(headers.nth(0)).toHaveAttribute('aria-expanded', 'false')
    await expect.element(headers.nth(1)).toHaveAttribute('aria-expanded', 'false')
    expect(view.getByText(/discussed/).query()).toBeNull()
    await view.unmount()
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
    const view = await renderPanel('notes/roadmap.md')

    const header = view.getByRole('button', { name: /Incoming backlinks \(2\)/ })
    await header.click()
    expect(view.getByText(/discussed/).query()).toBeNull()
    expect(view.getByText(/ship the/).query()).toBeNull()

    await view.getByRole('button', { name: 'Expand references from Meeting Notes' }).click()
    await expect.element(view.getByText(/discussed/)).toBeInTheDocument()
    expect(view.getByText(/ship the/).query()).toBeNull()

    await header.click()
    await expect.element(view.getByText(/ship the/)).toBeInTheDocument()
    await view.unmount()
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
    const view = await renderPanel('notes/roadmap.md')
    await expect.element(view.getByText('Incoming backlinks (2)')).toBeInTheDocument()

    await view.getByRole('button', { name: 'Collapse references from Meeting Notes' }).click()
    expect(view.getByText(/discussed/).query()).toBeNull()
    await expect.element(view.getByText(/ship the/)).toBeInTheDocument()
    await view.unmount()
  })
})
