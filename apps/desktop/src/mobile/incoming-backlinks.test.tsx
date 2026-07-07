import { render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { RouterProvider, useRouter } from '@/routing/router'
import { IncomingBacklinks } from './incoming-backlinks'

const getBacklinksWithContext = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getBacklinksWithContext,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))

function RouteProbe(): ReactNode {
  const { route, arrivalFocusEditor } = useRouter()
  return (
    <output data-testid="route" data-focus={String(arrivalFocusEditor)}>
      {JSON.stringify(route)}
    </output>
  )
}

function renderSection(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider>
        <IncomingBacklinks path={path} />
        <RouteProbe />
      </RouterProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  window.sessionStorage.clear()
  getBacklinksWithContext.mockReset()
})

describe('IncomingBacklinks', () => {
  it('renders nothing when the note has no inbound links (no empty chrome)', async () => {
    getBacklinksWithContext.mockResolvedValue([])
    const view = renderSection('daily/2026-07-02.md')
    await waitFor(() => expect(getBacklinksWithContext).toHaveBeenCalled())
    expect(view.queryByText(/Incoming backlink/)).toBeNull()
    view.unmount()
  })

  it('surfaces a failed query as an alert instead of rendering nothing', async () => {
    getBacklinksWithContext.mockRejectedValue(new Error('index unavailable'))
    const view = renderSection('daily/2026-07-02.md')
    const alert = await view.findByRole('alert')
    expect(alert.textContent).toContain('Couldn’t load backlinks.')
    view.unmount()
  })

  it('groups references by source note under a counted header', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed [[2026-07-02]] follow-ups',
        posFrom: 12,
        tasks: [],
      },
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'revisit on [[2026-07-02]]',
        posFrom: 80,
        tasks: [],
      },
      {
        sourcePath: 'notes/planning.md',
        sourceTitle: 'Planning',
        snippet: 'ship by [[2026-07-02]]',
        posFrom: 3,
        tasks: [],
      },
    ])
    const view = renderSection('daily/2026-07-02.md')

    await view.findByText('Incoming backlinks (3)')
    expect(view.getAllByText('Meeting Notes')).toHaveLength(1)
    expect(view.getByText(/discussed/)).toBeDefined()
    expect(view.getByText(/revisit on/)).toBeDefined()
    expect(view.getByText(/ship by/)).toBeDefined()
    view.unmount()
  })

  it('navigates a daily-note source to the daily route (the carousel follows it)', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'daily/2026-06-01.md',
        sourceTitle: 'June 1st, 2026',
        snippet: 'planned [[Roadmap]] here',
        posFrom: 4,
        tasks: [],
      },
    ])
    const view = renderSection('notes/roadmap.md')

    await userEvent.click(await view.findByText('June 1st, 2026'))
    expect(view.getByTestId('route').textContent).toContain('"kind":"daily"')
    expect(view.getByTestId('route').textContent).toContain('2026-06-01')
    // The daily surface stays mounted and swipes; no editor focus is raised.
    expect(view.getByTestId('route').getAttribute('data-focus')).toBe('false')
    view.unmount()
  })

  it('navigates an ordinary source to the note route without a focus intent', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed [[2026-07-02]] follow-ups',
        posFrom: 12,
        tasks: [],
      },
    ])
    const view = renderSection('daily/2026-07-02.md')

    await userEvent.click(await view.findByText('Meeting Notes'))
    expect(view.getByTestId('route').textContent).toContain('notes/meeting.md')
    // A backlink tap must not request focus — that would raise the keyboard
    // through the mobile stack animation.
    expect(view.getByTestId('route').getAttribute('data-focus')).toBe('false')
    view.unmount()
  })

  it('collapses snippets but keeps source titles on header toggle, for the session', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed [[2026-07-02]] follow-ups',
        posFrom: 12,
        tasks: [],
      },
    ])
    const view = renderSection('daily/2026-07-02.md')

    const header = await view.findByRole('button', { name: /Incoming backlink \(1\)/ })
    expect(header.getAttribute('aria-expanded')).toBe('true')

    await userEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(view.getByText('Meeting Notes')).toBeDefined()
    expect(view.queryByText(/discussed/)).toBeNull()
    view.unmount()

    const reopened = renderSection('daily/2026-07-02.md')
    const persistedHeader = await reopened.findByRole('button', {
      name: /Incoming backlink \(1\)/,
    })
    expect(persistedHeader.getAttribute('aria-expanded')).toBe('false')
    reopened.unmount()
  })

  it('shares the toggle with the desktop panel key across mounted sections', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed follow-ups',
        posFrom: 12,
        tasks: [],
      },
    ])
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(
      <QueryClientProvider client={client}>
        <RouterProvider>
          <IncomingBacklinks path="daily/2026-07-01.md" />
          <IncomingBacklinks path="daily/2026-07-02.md" />
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
    view.unmount()
  })

  it('lets one group be peeked at via its always-visible chevron after a header collapse', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed follow-ups',
        posFrom: 12,
        tasks: [],
      },
      {
        sourcePath: 'notes/planning.md',
        sourceTitle: 'Planning',
        snippet: 'ship the roadmap',
        posFrom: 3,
        tasks: [],
      },
    ])
    const view = renderSection('daily/2026-07-02.md')

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
})
