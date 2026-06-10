import { render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { RouterProvider, useRouter } from '@/routing/router'
import { NoteContextSidebar } from './note-context-sidebar'

const getBacklinksWithContext = vi.hoisted(() => vi.fn())
const relatedNotes = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getBacklinksWithContext,
  relatedNotes,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', cloudSync: null, generation: 1 } }),
}))

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function renderSidebar(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider>
        <NoteContextSidebar path={path} />
        <RouteProbe />
      </RouterProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  window.sessionStorage.clear()
  getBacklinksWithContext.mockReset().mockResolvedValue([])
  relatedNotes.mockReset().mockResolvedValue([])
})

describe('NoteContextSidebar', () => {
  it('queries the note path for both backlinks and similar notes', async () => {
    const view = renderSidebar('notes/rust.md')
    await waitFor(() => expect(getBacklinksWithContext).toHaveBeenCalledWith('notes/rust.md'))
    await waitFor(() => expect(relatedNotes).toHaveBeenCalledWith('notes/rust.md'))
    view.unmount()
  })

  it('shows a note-flavored empty state and no Similar notes section without results', async () => {
    const view = renderSidebar('notes/rust.md')
    await view.findByText('No notes link to this note yet.')
    expect(view.queryByText('Similar notes')).toBeNull()
    view.unmount()
  })

  it('lists inbound links and navigates on click', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'daily/2026-06-09.md',
        sourceTitle: 'June 9th, 2026',
        snippet: 'pairing on [[Rust]]',
        posFrom: 10,
      },
    ])
    const view = renderSidebar('notes/rust.md')
    await userEvent.click(await view.findByText('June 9th, 2026'))
    expect(view.getByTestId('route').textContent).toContain('"kind":"daily"')
    expect(view.getByTestId('route').textContent).toContain('"date":"2026-06-09"')
    view.unmount()
  })

  it('lists similar notes under their own section and navigates on click', async () => {
    relatedNotes.mockResolvedValue([
      {
        path: 'notes/zig.md',
        title: 'Zig',
        score: 0.8,
        snippet: 'comptime experiments',
        heading: null,
        isPrivate: false,
      },
    ])
    const view = renderSidebar('notes/rust.md')
    await view.findByText('Similar notes')
    await userEvent.click(view.getByText('Zig'))
    expect(view.getByTestId('route').textContent).toContain('"kind":"note"')
    expect(view.getByTestId('route').textContent).toContain('notes/zig.md')
    view.unmount()
  })
})
