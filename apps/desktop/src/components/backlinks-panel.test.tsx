import { render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { RouterProvider, useRouter } from '@/routing/router'
import { BacklinksPanel } from './backlinks-panel'

const getBacklinksWithContext = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getBacklinksWithContext,
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
})

describe('BacklinksPanel', () => {
  it('renders nothing when the note has no inbound links', async () => {
    getBacklinksWithContext.mockResolvedValue([])
    const view = renderPanel('notes/lonely.md')
    await waitFor(() => expect(getBacklinksWithContext).toHaveBeenCalled())
    expect(view.queryByText(/Incoming backlink/)).toBeNull()
    view.unmount()
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
    const view = renderPanel('notes/roadmap.md')
    await view.findByText('Incoming backlink (1)')
    view.unmount()
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
    const view = renderPanel('notes/roadmap.md')

    await view.findByText('Incoming backlinks (3)')
    expect(view.getAllByText('Meeting Notes')).toHaveLength(1)
    expect(view.getByText('discussed [[Roadmap]] follow-ups')).toBeDefined()
    expect(view.getByText('revisit [[Roadmap]] next week')).toBeDefined()
    expect(view.getByText('ship the [[Roadmap]]')).toBeDefined()

    await userEvent.click(view.getByText('Meeting Notes'))
    expect(view.getByTestId('route').textContent).toContain('notes/meeting.md')
    view.unmount()
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
    const view = renderPanel('notes/roadmap.md')

    const header = await view.findByRole('button', { name: /Incoming backlink \(1\)/ })
    expect(header.getAttribute('aria-expanded')).toBe('true')

    await userEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(view.getByText('Meeting Notes')).toBeDefined()
    expect(view.queryByText('discussed [[Roadmap]] follow-ups')).toBeNull()
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

    await view.findByText('links [[A]] and [[B]]')
    await userEvent.click(
      view.getByRole('button', { name: 'Collapse references from Shared Source' }),
    )
    expect(view.queryByText('links [[A]] and [[B]]')).toBeNull()

    view.rerender(panelFor('notes/b.md'))
    await view.findByText('links [[A]] and [[B]]')
    view.unmount()
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

    await userEvent.click(headers[0])
    expect(headers[0].getAttribute('aria-expanded')).toBe('false')
    expect(headers[1].getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText('discussed [[Roadmap]] follow-ups')).toBeNull()
    view.unmount()
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
    const view = renderPanel('notes/roadmap.md')

    const header = await view.findByRole('button', { name: /Incoming backlinks \(2\)/ })
    await userEvent.click(header)
    expect(view.queryByText('discussed [[Roadmap]] follow-ups')).toBeNull()
    expect(view.queryByText('ship the [[Roadmap]]')).toBeNull()

    await userEvent.click(
      view.getByRole('button', { name: 'Expand references from Meeting Notes' }),
    )
    expect(view.getByText('discussed [[Roadmap]] follow-ups')).toBeDefined()
    expect(view.queryByText('ship the [[Roadmap]]')).toBeNull()

    await userEvent.click(header)
    expect(view.getByText('ship the [[Roadmap]]')).toBeDefined()
    view.unmount()
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
    const view = renderPanel('notes/roadmap.md')
    await view.findByText('Incoming backlinks (2)')

    await userEvent.click(
      view.getByRole('button', { name: 'Collapse references from Meeting Notes' }),
    )
    expect(view.queryByText('discussed [[Roadmap]] follow-ups')).toBeNull()
    expect(view.getByText('ship the [[Roadmap]]')).toBeDefined()
    view.unmount()
  })
})
