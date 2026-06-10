import { render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { RouterProvider, useRouter } from '@/routing/router'
import { SidebarRelatedNotes } from './sidebar-related-notes'

const relatedNotes = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  relatedNotes,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', cloudSync: null, generation: 1 } }),
}))

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function renderRelated(path: string, probe: boolean = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider>
        <SidebarRelatedNotes path={path} />
        {probe ? <RouteProbe /> : null}
      </RouterProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  window.sessionStorage.clear()
  relatedNotes.mockReset().mockResolvedValue([])
})

describe('SidebarRelatedNotes', () => {
  it('renders nothing at all when the note has no semantic neighbors', async () => {
    const view = renderRelated('notes/rust.md', false)
    await waitFor(() => expect(relatedNotes).toHaveBeenCalledWith('notes/rust.md'))
    expect(view.container.firstChild).toBeNull()
    view.unmount()
  })

  it('renders the Related section with one row per neighbor', async () => {
    relatedNotes.mockResolvedValue([
      {
        path: 'notes/rust.md',
        title: 'Rust',
        score: 0.9,
        snippet: 'borrow checker notes',
        heading: null,
        isPrivate: false,
      },
      {
        path: 'notes/zig.md',
        title: 'Zig',
        score: 0.7,
        snippet: 'comptime experiments',
        heading: null,
        isPrivate: false,
      },
    ])
    const view = renderRelated('notes/systems.md')
    await view.findByText('Rust')
    expect(view.getByText('Related')).toBeDefined()
    expect(view.getByText('borrow checker notes')).toBeDefined()
    expect(view.getByText('Zig')).toBeDefined()
    expect(view.getByText('comptime experiments')).toBeDefined()
    view.unmount()
  })

  it('navigates to the clicked neighbor', async () => {
    relatedNotes.mockResolvedValue([
      {
        path: 'notes/gardening.md',
        title: 'Gardening',
        score: 0.8,
        snippet: 'tomato beds',
        heading: null,
        isPrivate: false,
      },
    ])
    const view = renderRelated('notes/yard.md')
    await userEvent.click(await view.findByText('Gardening'))
    expect(view.getByTestId('route').textContent).toContain('"kind":"note"')
    expect(view.getByTestId('route').textContent).toContain('notes/gardening.md')
    view.unmount()
  })
})
