import { render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { RouterProvider, useRouter } from '@/routing/router'
import { SimilarNotesSection } from './similar-notes-section'

const relatedNotes = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  relatedNotes,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', cloudSync: null, generation: 1 } }),
}))
const semanticSetting = vi.hoisted(() => ({ enabled: true }))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: { semanticSearchEnabled: semanticSetting.enabled },
    updateSettings: () => {},
  }),
}))

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function renderSimilar(path: string, probe: boolean = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider>
        <SimilarNotesSection path={path} />
        {probe ? <RouteProbe /> : null}
      </RouterProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  window.sessionStorage.clear()
  semanticSetting.enabled = true
  relatedNotes.mockReset().mockResolvedValue([])
})

describe('SimilarNotesSection', () => {
  it('renders nothing at all when the note has no semantic neighbors', async () => {
    const view = renderSimilar('daily/2026-06-09.md', false)
    await waitFor(() => expect(relatedNotes).toHaveBeenCalledWith('daily/2026-06-09.md'))
    expect(view.container.firstChild).toBeNull()
    view.unmount()
  })

  it('neither queries nor renders while semantic search is disabled', async () => {
    semanticSetting.enabled = false
    relatedNotes.mockResolvedValue([
      {
        path: 'notes/rust.md',
        title: 'Rust',
        score: 0.9,
        snippet: 'borrow checker notes',
        heading: null,
        isPrivate: false,
      },
    ])
    const view = renderSimilar('notes/languages.md', false)
    // Give a would-be fetch a tick to fire before asserting it never did.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(relatedNotes).not.toHaveBeenCalled()
    expect(view.container.firstChild).toBeNull()
    view.unmount()
  })

  it('renders the Similar notes section with one title-only row per neighbor', async () => {
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
    const view = renderSimilar('notes/languages.md')
    await view.findByText('Rust')
    expect(view.getByText('Similar notes')).toBeDefined()
    expect(view.getByText('Zig')).toBeDefined()
    // V1 rows are bare titles — snippets never render here.
    expect(view.queryByText('borrow checker notes')).toBeNull()
    expect(view.queryByText('comptime experiments')).toBeNull()
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
    const view = renderSimilar('daily/2026-06-09.md')
    await userEvent.click(await view.findByText('Gardening'))
    expect(view.getByTestId('route').textContent).toContain('"kind":"note"')
    expect(view.getByTestId('route').textContent).toContain('notes/gardening.md')
    view.unmount()
  })
})
