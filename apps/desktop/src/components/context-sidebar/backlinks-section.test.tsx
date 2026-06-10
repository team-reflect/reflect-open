import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { RouterProvider, useRouter } from '@/routing/router'
import { BacklinksSection } from './backlinks-section'

const getBacklinksWithContext = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getBacklinksWithContext,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', cloudSync: null, generation: 1 } }),
}))

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function renderBacklinks(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider>
        <BacklinksSection path={path} emptyLabel="No notes link to this day yet." />
        <RouteProbe />
      </RouterProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  window.sessionStorage.clear()
  getBacklinksWithContext.mockReset().mockResolvedValue([])
})

describe('BacklinksSection', () => {
  it('shows a loading line while the query is in flight', () => {
    getBacklinksWithContext.mockImplementation(() => new Promise(() => {}))
    const view = renderBacklinks('daily/2026-06-09.md')
    expect(view.getByText('Loading…')).toBeDefined()
    view.unmount()
  })

  it('announces an alert when the query fails', async () => {
    getBacklinksWithContext.mockRejectedValue(new Error('index unavailable'))
    const view = renderBacklinks('daily/2026-06-09.md')
    const alert = await view.findByRole('alert')
    expect(alert.textContent).toBe('Couldn’t load backlinks.')
    view.unmount()
  })

  it('shows the host-provided quiet empty state when nothing links here', async () => {
    const view = renderBacklinks('daily/2026-06-09.md')
    await view.findByText('No notes link to this day yet.')
    expect(getBacklinksWithContext).toHaveBeenCalledWith('daily/2026-06-09.md')
    view.unmount()
  })

  it('renders each backlink with its title and snippet', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/standup.md',
        sourceTitle: 'Standup',
        snippet: 'review on [[2026-06-09]]',
        posFrom: 4,
      },
      {
        sourcePath: 'notes/standup.md',
        sourceTitle: 'Standup',
        snippet: 'follow-up from [[2026-06-09]]',
        posFrom: 90,
      },
    ])
    const view = renderBacklinks('daily/2026-06-09.md')
    await view.findByText('review on [[2026-06-09]]')
    expect(view.getAllByText('Standup')).toHaveLength(2)
    expect(view.getByText('follow-up from [[2026-06-09]]')).toBeDefined()
    view.unmount()
  })

  it('navigates a clicked row through routeForPath of its source', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'daily/2026-06-01.md',
        sourceTitle: 'June 1st, 2026',
        snippet: 'see [[2026-06-09]]',
        posFrom: 12,
      },
      {
        sourcePath: 'notes/projects.md',
        sourceTitle: 'Projects',
        snippet: 'kickoff [[2026-06-09]]',
        posFrom: 7,
      },
    ])
    const view = renderBacklinks('daily/2026-06-09.md')

    await userEvent.click(await view.findByText('June 1st, 2026'))
    expect(view.getByTestId('route').textContent).toContain('"kind":"daily"')
    expect(view.getByTestId('route').textContent).toContain('"date":"2026-06-01"')

    await userEvent.click(view.getByText('Projects'))
    expect(view.getByTestId('route').textContent).toContain('"kind":"note"')
    expect(view.getByTestId('route').textContent).toContain('notes/projects.md')
    view.unmount()
  })
})
