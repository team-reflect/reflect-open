import { render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { RouterProvider, useRouter } from '@/routing/router'
import { NoteContextSidebar } from './note-context-sidebar'

const getNote = vi.hoisted(() => vi.fn())
const getBacklinksWithContext = vi.hoisted(() => vi.fn())
const relatedNotes = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getNote,
  getBacklinksWithContext,
  relatedNotes,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', cloudSync: false, generation: 1 } }),
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
  getNote.mockReset().mockResolvedValue(undefined)
  getBacklinksWithContext.mockReset().mockResolvedValue([])
  relatedNotes.mockReset().mockResolvedValue([])
})

describe('NoteContextSidebar header', () => {
  it('shows the indexed note title', async () => {
    getNote.mockResolvedValue({
      path: 'notes/rust.md',
      title: 'Rust',
      dailyDate: null,
      isPrivate: false,
    })
    const view = renderSidebar('notes/rust.md')
    await waitFor(() =>
      expect(view.getByRole('heading', { name: 'Rust' })).toBeDefined(),
    )
    expect(getNote).toHaveBeenCalledWith('notes/rust.md')
    view.unmount()
  })

  it('falls back to the filename while the note is not indexed yet', async () => {
    const view = renderSidebar('notes/borrow-checker.md')
    expect(view.getByRole('heading', { name: 'borrow-checker' })).toBeDefined()
    await waitFor(() => expect(getNote).toHaveBeenCalled())
    view.unmount()
  })
})

describe('NoteContextSidebar backlinks', () => {
  it('shows a quiet empty state when nothing links to the note', async () => {
    const view = renderSidebar('notes/rust.md')
    await view.findByText('No notes link to this note yet.')
    expect(getBacklinksWithContext).toHaveBeenCalledWith('notes/rust.md')
    view.unmount()
  })

  it('lists inbound links with snippets and navigates on click', async () => {
    getBacklinksWithContext.mockResolvedValue([
      {
        sourcePath: 'notes/standup.md',
        sourceTitle: 'Standup',
        snippet: 'pairing on [[Rust]]',
        posFrom: 4,
      },
    ])
    const view = renderSidebar('notes/rust.md')
    await view.findByText('Standup')
    expect(view.getByText('pairing on [[Rust]]')).toBeDefined()
    await userEvent.click(view.getByText('Standup'))
    expect(view.getByTestId('route').textContent).toContain('notes/standup.md')
    view.unmount()
  })
})

describe('NoteContextSidebar related notes', () => {
  it('renders no Related section without results', async () => {
    const view = renderSidebar('notes/rust.md')
    await waitFor(() => expect(relatedNotes).toHaveBeenCalledWith('notes/rust.md'))
    expect(view.queryByText('Related')).toBeNull()
    view.unmount()
  })

  it('lists semantic neighbors when they exist', async () => {
    relatedNotes.mockResolvedValue([
      {
        path: 'notes/zig.md',
        title: 'Zig',
        score: 0.9,
        snippet: 'comptime experiments',
        heading: null,
      },
    ])
    const view = renderSidebar('notes/rust.md')
    await view.findByText('Zig')
    expect(view.getByText('Related')).toBeDefined()
    await userEvent.click(view.getByText('Zig'))
    expect(view.getByTestId('route').textContent).toContain('notes/zig.md')
    view.unmount()
  })
})
