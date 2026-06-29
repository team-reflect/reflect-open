import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type { ReactNode } from 'react'
import { RouterProvider, useRouter } from '@/routing/router'
import { BacklinksPanel } from './backlinks-panel'

const getBacklinksWithContext = vi.hoisted(() => vi.fn())
const resolveWikiTarget = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getBacklinksWithContext,
  resolveWikiTarget,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', cloudSync: false, generation: 1 } }),
}))

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
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
  resolveWikiTarget.mockReset()
})

describe('BacklinksPanel', () => {
  it('renders nothing when the note has no inbound links', async () => {
    getBacklinksWithContext.mockResolvedValue([])
    const view = await renderPanel('notes/lonely.md')
    await vi.waitFor(() => expect(getBacklinksWithContext).toHaveBeenCalled())
    await expect.element(view.getByText(/Incoming backlink/)).not.toBeInTheDocument()
  })

  it('surfaces a failed query as an alert instead of rendering nothing', async () => {
    getBacklinksWithContext.mockRejectedValue(new Error('index unavailable'))
    const view = await renderPanel('notes/roadmap.md')
    await expect.element(view.getByRole('alert')).toHaveTextContent('Couldn’t load backlinks.')
  })

  it('uses the singular header for one inbound link', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed [[Roadmap]] follow-ups',
        posFrom: 12,
      },
    ])
    const view = await renderPanel('notes/roadmap.md')
    await expect.element(view.getByText('Incoming backlink (1)', { exact: true })).toBeInTheDocument()
  })

  it('renders a snippet wiki link as a clickable chip that navigates to its target', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed [[Roadmap]] follow-ups',
        posFrom: 12,
      },
    ])
    resolveWikiTarget.mockResolvedValue({ kind: 'resolved', ref: 'notes/roadmap.md' })
    const view = await renderPanel('notes/source.md')

    // The [[Roadmap]] source renders as a chip whose label is the bare target,
    // not the raw bracket syntax.
    const chip = view.getByTestId('wikilink')
    await expect.element(chip).toBeInTheDocument()
    expect(chip.element().textContent).toBe('Roadmap')

    await userEvent.click(chip)
    await vi.waitFor(() =>
      expect(view.getByTestId('route').element().textContent).toContain('notes/roadmap.md'),
    )
  })

  it('groups references by source note and navigates on title click', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed [[Roadmap]] follow-ups',
        posFrom: 12,
      },
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'revisit [[Roadmap]] next week',
        posFrom: 80,
      },
      {
        sourcePath: 'notes/planning.md',
        sourceTitle: 'Planning',
        snippet: 'ship the [[Roadmap]]',
        posFrom: 3,
      },
    ])
    const view = await renderPanel('notes/roadmap.md')

    await expect.element(view.getByText('Incoming backlinks (3)', { exact: true })).toBeInTheDocument()
    expect(view.getByText('Meeting Notes', { exact: true }).elements()).toHaveLength(1)
    // Snippets render as rich text: the leading prose survives, the [[…]] source
    // becomes a chip whose label shows the bare target.
    await expect.element(view.getByText(/discussed/)).toBeInTheDocument()
    await expect.element(view.getByText(/revisit/)).toBeInTheDocument()
    await expect.element(view.getByText(/ship the/)).toBeInTheDocument()
    expect(view.getByTestId('wikilink').elements()).toHaveLength(3)

    await userEvent.click(view.getByText('Meeting Notes', { exact: true }))
    expect(view.getByTestId('route').element().textContent).toContain('notes/meeting.md')
  })

  it('collapses snippets but keeps source titles on header toggle, for the session', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed [[Roadmap]] follow-ups',
        posFrom: 12,
      },
    ])
    const view = await renderPanel('notes/roadmap.md')

    const header = view.getByRole('button', { name: /Incoming backlink \(1\)/ })
    await expect.element(header).toHaveAttribute('aria-expanded', 'true')

    await userEvent.click(header)
    await expect.element(header).toHaveAttribute('aria-expanded', 'false')
    await expect.element(view.getByText('Meeting Notes', { exact: true })).toBeInTheDocument()
    await expect.element(view.getByText(/discussed/)).not.toBeInTheDocument()
    await view.unmount()

    const reopened = await renderPanel('notes/roadmap.md')
    const persistedHeader = reopened.getByRole('button', {
      name: /Incoming backlink \(1\)/,
    })
    await expect.element(persistedHeader).toHaveAttribute('aria-expanded', 'false')
  })

  it('resets a collapsed group when navigating to another note with the same source', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/shared.md',
        sourceTitle: 'Shared Source',
        snippet: 'links [[A]] and [[B]]',
        posFrom: 5,
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

    await expect.element(view.locate('.reflect-backlink-snippet')).toBeInTheDocument()
    await userEvent.click(
      view.getByRole('button', { name: 'Collapse references from Shared Source' }),
    )
    await expect.element(view.locate('.reflect-backlink-snippet')).not.toBeInTheDocument()

    await view.rerender(panelFor('notes/b.md'))
    await expect.element(view.locate('.reflect-backlink-snippet')).toBeInTheDocument()
  })

  it('keeps simultaneously mounted panels in sync (one per day in the stream)', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed [[Roadmap]] follow-ups',
        posFrom: 12,
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

    await vi.waitFor(() =>
      expect(
        view.getByRole('button', { name: /Incoming backlink \(1\)/ }).elements(),
      ).toHaveLength(2),
    )
    const headers = view.getByRole('button', { name: /Incoming backlink \(1\)/ }).all()

    await userEvent.click(headers[0]!)
    await expect.element(headers[0]!).toHaveAttribute('aria-expanded', 'false')
    await expect.element(headers[1]!).toHaveAttribute('aria-expanded', 'false')
    await expect.element(view.getByText(/discussed/)).not.toBeInTheDocument()
  })

  it('lets one group be peeked at after the header collapse (old Reflect behavior)', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed [[Roadmap]] follow-ups',
        posFrom: 12,
      },
      {
        sourcePath: 'notes/planning.md',
        sourceTitle: 'Planning',
        snippet: 'ship the [[Roadmap]]',
        posFrom: 3,
      },
    ])
    const view = await renderPanel('notes/roadmap.md')

    const header = view.getByRole('button', { name: /Incoming backlinks \(2\)/ })
    await expect.element(header).toBeInTheDocument()
    await userEvent.click(header)
    await expect.element(view.getByText(/discussed/)).not.toBeInTheDocument()
    await expect.element(view.getByText(/ship the/)).not.toBeInTheDocument()

    await userEvent.click(
      view.getByRole('button', { name: 'Expand references from Meeting Notes' }),
    )
    await expect.element(view.getByText(/discussed/)).toBeInTheDocument()
    await expect.element(view.getByText(/ship the/)).not.toBeInTheDocument()

    await userEvent.click(header)
    await expect.element(view.getByText(/ship the/)).toBeInTheDocument()
  })

  it('collapses one source group via its own chevron', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed [[Roadmap]] follow-ups',
        posFrom: 12,
      },
      {
        sourcePath: 'notes/planning.md',
        sourceTitle: 'Planning',
        snippet: 'ship the [[Roadmap]]',
        posFrom: 3,
      },
    ])
    const view = await renderPanel('notes/roadmap.md')
    await expect.element(view.getByText('Incoming backlinks (2)', { exact: true })).toBeInTheDocument()

    await userEvent.click(
      view.getByRole('button', { name: 'Collapse references from Meeting Notes' }),
    )
    await expect.element(view.getByText(/discussed/)).not.toBeInTheDocument()
    await expect.element(view.getByText(/ship the/)).toBeInTheDocument()
  })
})
