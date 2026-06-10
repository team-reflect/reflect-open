import { render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
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

describe('BacklinksPanel', () => {
  it('renders nothing when the note has no inbound links', async () => {
    getBacklinksWithContext.mockResolvedValue([])
    const view = renderPanel('notes/lonely.md')
    await waitFor(() => expect(getBacklinksWithContext).toHaveBeenCalled())
    expect(view.queryByText('Linked from')).toBeNull()
    view.unmount()
  })

  it('lists sources with snippets and navigates on click', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/meeting.md',
        sourceTitle: 'Meeting Notes',
        snippet: 'discussed [[Roadmap]] follow-ups',
        posFrom: 12,
      },
    ])
    const view = renderPanel('notes/roadmap.md')

    await view.findByText('Meeting Notes')
    expect(view.getByText('discussed [[Roadmap]] follow-ups')).toBeDefined()

    await userEvent.click(view.getByText('Meeting Notes'))
    expect(view.getByTestId('route').textContent).toContain('notes/meeting.md')
    view.unmount()
  })
})
